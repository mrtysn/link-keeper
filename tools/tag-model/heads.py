"""Jeffy heads for the owner's tags: embeddings, one binary head per tag, training and loading.

Jeffy (jeffy-classify) is a frozen sentence encoder (English: BAAI/bge-large-en-v1.5, 1024
dimensions, about 1.3 GB downloaded once by sentence-transformers) with a StandardScaler and a
LogisticRegression (C=0.01) per classifier, saved as a model pack (`model.npz`, `model.pkl`,
`manifest.json`). A Jeffy classifier is single-label, so a link that can carry several tags gets one
binary head per tag (the tag against the owner's other tagged links). The encoder runs once per
link text; the vectors are cached so retraining and suggesting reuse them.
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import precision_score, recall_score
from sklearn.model_selection import StratifiedShuffleSplit
from sklearn.preprocessing import StandardScaler

from jeffy.catalog import ENCODER, ENCODER_DIM
from jeffy.model_pack import ArtifactManifest, coef_hash, load_artifact, save_artifact, scaler_hash

from tagdata import Link

Encode = Callable[[list[str]], np.ndarray]
CLASS_NO, CLASS_YES = "no", "yes"
REGULARISATION = 0.01  # Jeffy's own default for a custom classifier
HELD_OUT_SHARE = 0.2
MIN_NEGATIVES = 20


def jeffy_encoder() -> Encode:
    """The English encoder Jeffy uses, loaded on the first call."""
    state: dict = {}

    def encode(texts: list[str]) -> np.ndarray:
        if "model" not in state:
            from sentence_transformers import SentenceTransformer
            state["model"] = SentenceTransformer(ENCODER, device="cpu")
        return np.asarray(state["model"].encode(texts, batch_size=64, show_progress_bar=len(texts) > 64))

    return encode


class EmbeddingCache:
    """Vectors keyed by a hash of the link text, kept in one .npz beside the heads."""

    def __init__(self, path: Path, encode: Encode):
        self.path, self.encode = path, encode
        self.vectors: dict[str, np.ndarray] = {}
        if path.is_file():
            data = np.load(path, allow_pickle=False)
            self.vectors = dict(zip(data["keys"].tolist(), data["vectors"]))

    @staticmethod
    def key(text: str) -> str:
        return hashlib.sha1(text.encode()).hexdigest()

    def matrix(self, texts: list[str]) -> np.ndarray:
        keys = [self.key(t) for t in texts]
        missing = sorted({k: t for k, t in zip(keys, texts) if k not in self.vectors}.items())
        if missing:
            started = time.time()
            vectors = self.encode([t for _, t in missing])
            for (k, _), v in zip(missing, vectors):
                self.vectors[k] = np.asarray(v, dtype=np.float32)
            print(f"encoded {len(missing)} texts in {time.time() - started:.0f} s")
            self.save()
        return np.stack([self.vectors[k] for k in keys])

    def save(self) -> None:
        tmp = self.path.with_name(self.path.name + ".tmp.npz")
        np.savez_compressed(tmp, keys=np.array(list(self.vectors)), vectors=np.stack(list(self.vectors.values())))
        tmp.replace(self.path)


def slug(tag: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", tag.lower()).strip("-") or "tag"


def fit_head(X: np.ndarray, y: list[str]):
    """Jeffy's recipe: standardise, then L2-regularised logistic regression."""
    scaler = StandardScaler()
    clf = LogisticRegression(C=REGULARISATION, max_iter=3000, solver="newton-cg", random_state=42)
    clf.fit(scaler.fit_transform(X), y)
    return clf, scaler


def head_probabilities(clf, scaler, X: np.ndarray) -> np.ndarray:
    """P(the tag applies) per row."""
    column = list(clf.classes_).index(CLASS_YES)
    return clf.predict_proba(scaler.transform(X))[:, column]


@dataclass
class HeadReport:
    tag: str
    positives: int
    negatives: int
    held_out: int
    precision: float
    recall: float
    enabled: bool
    reason: str
    head: str


def train_head(tag: str, X: np.ndarray, positive: np.ndarray, heads_dir: Path, *, threshold: float,
               min_precision: float) -> HeadReport:
    """Hold out 20 % (stratified), measure precision and recall at `threshold`, then refit on every
    labelled link and save the head. A head under `min_precision` is saved but marked disabled."""
    y = [CLASS_YES if p else CLASS_NO for p in positive]
    split = StratifiedShuffleSplit(n_splits=1, test_size=HELD_OUT_SHARE, random_state=42)
    train_idx, test_idx = next(split.split(X, y))
    clf, scaler = fit_head(X[train_idx], [y[i] for i in train_idx])
    predicted = head_probabilities(clf, scaler, X[test_idx]) >= threshold
    truth = np.array([y[i] == CLASS_YES for i in test_idx])
    precision = float(precision_score(truth, predicted, zero_division=0))
    recall = float(recall_score(truth, predicted, zero_division=0))
    if not predicted.any():
        enabled, reason = False, f"no held-out link reached {threshold}"
    elif precision < min_precision:
        enabled, reason = False, f"held-out precision {precision:.2f} is under {min_precision}"
    else:
        enabled, reason = True, "ok"
    clf, scaler = fit_head(X, y)
    save_head(heads_dir, tag, clf, scaler, positives=int(positive.sum()), total=len(y))
    return HeadReport(tag, int(positive.sum()), int((~positive).sum()), len(test_idx), round(precision, 4),
                      round(recall, 4), enabled, reason, slug(tag))


def save_head(heads_dir: Path, tag: str, clf, scaler, *, positives: int, total: int) -> None:
    manifest = ArtifactManifest(
        dataset=tag, description=f"Does the owner file a link under '{tag}'", n_classes=2, task_type="noul",
        encoder=ENCODER, encoder_dim=ENCODER_DIM, labels={CLASS_NO: "other tags", CLASS_YES: tag},
        class_order=list(clf.classes_), hf_source="user-provided", hf_config=None, hf_revision=None,
        license="user-provided", train_examples=total, train_accuracy=0, test_examples=positives,
        test_accuracy=0, scaler_mean_hash=scaler_hash(scaler), classifier_coef_hash=coef_hash(clf),
    )
    save_artifact(heads_dir, slug(tag), clf, scaler, manifest)


def load_head(heads_dir: Path, tag: str):
    clf, scaler, _ = load_artifact(heads_dir / slug(tag))
    return clf, scaler


def labelled_matrix(links: list[Link], cache: EmbeddingCache):
    """Embeddings of the links that carry at least one tag, with those links."""
    labelled = [l for l in links if l.tags]
    return labelled, (cache.matrix([l.text for l in labelled]) if labelled else np.zeros((0, ENCODER_DIM)))
