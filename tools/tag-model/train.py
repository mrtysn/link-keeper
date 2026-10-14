#!/usr/bin/env python3
"""Train one Jeffy head per tag the owner has used often enough.

Positives for a tag are the links the owner gave that tag; negatives are the owner's other tagged
links (untagged links are unlabelled, not negative). A tag with at least --min-positives positive
links gets a head: 20 % of the labelled links are held out (stratified), precision and recall are
measured at --threshold, and a head whose held-out precision is under --min-precision is marked
disabled. The head that is saved is refit on every labelled link. Links carrying `filtered-out` are
ignored.

Writes, under <data dir>/tag-model/:  heads/<tag>/  (Jeffy model packs),  metrics.json,
embeddings.npz (cached encoder output).

    uv run python train.py
    uv run python train.py --min-positives 30 --min-precision 0.8
"""

from __future__ import annotations

import argparse
import time

import numpy as np

import tagdata
import heads as heads_mod

DEFAULT_MIN_POSITIVES = 50
DEFAULT_MIN_PRECISION = 0.7
DEFAULT_THRESHOLD = 0.5


def train_all(links, tag_library, folder, encode, *, min_positives=DEFAULT_MIN_POSITIVES,
              min_precision=DEFAULT_MIN_PRECISION, threshold=DEFAULT_THRESHOLD, report=print) -> dict:
    """Train every eligible tag; writes metrics.json and the heads, returns the metrics."""
    cache = heads_mod.EmbeddingCache(folder / "embeddings.npz", encode)
    labelled, X = heads_mod.labelled_matrix(links, cache)
    heads_dir = folder / "heads"
    metrics = {"encoder": heads_mod.ENCODER, "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
               "min_positives": min_positives, "min_precision": min_precision, "threshold": threshold,
               "labelled_links": len(labelled), "tags": {}, "skipped": {}}
    for tag in tag_library:
        positive = np.array([tag in l.tags for l in labelled], dtype=bool)
        n_pos = int(positive.sum())
        if n_pos < min_positives:
            metrics["skipped"][tag] = n_pos
        elif len(labelled) - n_pos < heads_mod.MIN_NEGATIVES:
            metrics["skipped"][tag] = n_pos
            report(f"{tag}: {n_pos} positives but fewer than {heads_mod.MIN_NEGATIVES} other tagged links; skipped")
        else:
            r = heads_mod.train_head(tag, X, positive, heads_dir, threshold=threshold, min_precision=min_precision)
            metrics["tags"][tag] = r.__dict__
            report(f"{tag}: {r.positives} positives, held-out precision {r.precision:.2f}, recall {r.recall:.2f} "
                   f"-> {'enabled' if r.enabled else 'disabled (' + r.reason + ')'}")
    tagdata.write_json(folder / "metrics.json", metrics)
    enabled = sum(1 for r in metrics["tags"].values() if r["enabled"])
    report(f"{len(labelled)} labelled links; {len(metrics['tags'])} heads trained, {enabled} enabled; "
           f"{len(metrics['skipped'])} tags under {min_positives} positives")
    return metrics


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--min-positives", type=int, default=DEFAULT_MIN_POSITIVES,
                    help="links a tag needs before it gets a head (default %(default)s)")
    ap.add_argument("--min-precision", type=float, default=DEFAULT_MIN_PRECISION,
                    help="held-out precision a head needs to be enabled (default %(default)s)")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                    help="P(tag) at which precision and recall are measured and suggestions are made (default %(default)s)")
    ap.add_argument("--data-dir", help="the refresh's data folder (default: DATA_DIR, else the repo's data/)")
    args = ap.parse_args()
    folder = tagdata.model_dir(args.data_dir)
    train_all(tagdata.load_links(), tagdata.load_tag_library(), folder, heads_mod.jeffy_encoder(),
              min_positives=args.min_positives, min_precision=args.min_precision, threshold=args.threshold)


if __name__ == "__main__":
    main()
