"""Tests for the tag model: training, the precision gate, the suggestions contract, link reading.

The encoder is a hashed bag of words and system-one is a stub, so the suite needs no model download
and no server. Run: `uv run pytest test_tag_model.py` from tools/tag-model.
"""

from __future__ import annotations

import json
import random
import zlib

import numpy as np
import pytest

import heads
import suggest as suggest_mod
import suggest_system_one as s1
import tagdata
import train
from tagdata import Link

DIM = 128
COOKING = ["recipe", "pasta", "oven", "bake", "sauce", "dinner", "flour", "garlic", "simmer", "kitchen"]
PYTHON = ["python", "function", "import", "class", "pytest", "decorator", "module", "list", "async", "debug"]


def encode(texts: list[str]) -> np.ndarray:
    """A stand-in encoder: each word adds to one of DIM buckets."""
    out = np.zeros((len(texts), DIM), dtype=np.float32)
    for row, text in enumerate(texts):
        for word in text.lower().split():
            out[row, zlib.crc32(word.encode()) % DIM] += 1.0
    return out


def make_text(rng: random.Random, words: list[str]) -> str:
    return " ".join(rng.choice(words) for _ in range(12))


@pytest.fixture
def corpus():
    rng = random.Random(7)
    links = []
    for i in range(60):
        noise = ["noise"] if rng.random() < 0.5 else []
        links.append(Link(f"https://cook.example/{i}", make_text(rng, COOKING), ["cook", *noise]))
    for i in range(60):
        noise = ["noise"] if rng.random() < 0.5 else []
        links.append(Link(f"https://code.example/{i}", make_text(rng, PYTHON), ["code", *noise]))
    links.append(Link("https://cook.example/new", "pasta recipe garlic sauce oven dinner", []))
    links.append(Link("https://code.example/new", "python function import pytest async module", []))
    return links


LIBRARY = ["cook", "code", "noise", "gamble"]


def test_train_save_load_suggest(corpus, tmp_path):
    metrics = train.train_all(corpus, LIBRARY, tmp_path, encode, report=lambda *_: None)
    assert metrics["labelled_links"] == 120
    assert metrics["tags"]["cook"]["enabled"] and metrics["tags"]["code"]["enabled"]
    assert metrics["tags"]["cook"]["precision"] >= 0.7
    assert metrics["skipped"] == {"gamble": 0}
    assert json.loads((tmp_path / "metrics.json").read_text())["tags"]["cook"]["head"] == "cook"
    assert (tmp_path / "heads" / "cook" / "manifest.json").is_file()

    asked = []

    def stub_ask(request):
        asked.append(request)
        return {tag: 0.9 for tag in request["questions"]}

    result = suggest_mod.suggest(corpus, LIBRARY, tmp_path, encode, ask_fn=stub_ask, report=lambda *_: None)
    assert set(result) == {"https://cook.example/new", "https://code.example/new"}  # tagged links get none
    for url, items in result.items():
        assert 1 <= len(items) <= 4
        assert [i["p"] for i in items] == sorted((i["p"] for i in items), reverse=True)
        for item in items:
            assert set(item) == {"tag", "p", "by"} and 0 <= item["p"] <= 1
            assert item["by"] in ("system-one", "model")
    cook = {i["tag"]: i for i in result["https://cook.example/new"]}
    assert cook["cook"]["by"] == "model" and cook["cook"]["p"] > 0.5
    assert "code" not in cook or cook["code"]["p"] < cook["cook"]["p"]
    assert any(i["by"] == "system-one" and i["tag"] == "gamble" for i in result["https://cook.example/new"])
    assert all("cook" not in q["questions"] for q in asked)  # a covered tag is not asked about


def test_precision_gate_disables_a_random_tag(corpus, tmp_path):
    metrics = train.train_all(corpus, LIBRARY, tmp_path, encode, report=lambda *_: None)
    noise = metrics["tags"]["noise"]
    assert noise["enabled"] is False and noise["precision"] < 0.7
    result = suggest_mod.suggest(corpus, LIBRARY, tmp_path, encode, ask_fn=lambda r: {t: 0.0 for t in r["questions"]},
                                 report=lambda *_: None)
    assert all(i["tag"] != "noise" for items in result.values() for i in items)


def test_a_loaded_head_scores_like_the_one_trained(corpus, tmp_path):
    X = encode([l.text for l in corpus[:120]])
    positive = np.array(["cook" in l.tags for l in corpus[:120]])
    heads.train_head("cook", X, positive, tmp_path, threshold=0.5, min_precision=0.7)
    clf, scaler = heads.load_head(tmp_path, "cook")
    p = heads.head_probabilities(clf, scaler, X)
    assert p[positive].mean() > 0.8 > 0.2 > p[~positive].mean()


def test_system_one_only_ignores_heads(corpus, tmp_path):
    train.train_all(corpus, LIBRARY, tmp_path, encode, report=lambda *_: None)
    result = suggest_mod.suggest(corpus, LIBRARY, tmp_path, encode, system_one_only=True,
                                 ask_fn=lambda r: {t: 0.8 for t in r["questions"]}, report=lambda *_: None)
    assert {i["by"] for items in result.values() for i in items} == {"system-one"}
    assert all(len(items) == 4 for items in result.values())  # four tags, all at 0.8: capped at 4


def test_threshold_keeps_only_what_clears_it(corpus, tmp_path):
    probs = {"cook": 0.95, "code": 0.69, "noise": 0.71, "gamble": 0.2}
    result = suggest_mod.suggest(corpus, LIBRARY, tmp_path, encode, system_one_only=True,
                                 ask_fn=lambda r: probs, report=lambda *_: None)
    assert [i["tag"] for i in result["https://cook.example/new"]] == ["cook", "noise"]


def test_no_enabled_head_never_loads_the_encoder(corpus, tmp_path):
    def boom(texts):
        raise AssertionError("the encoder must not run without an enabled head")

    train.train_all([l for l in corpus if not l.tags], LIBRARY, tmp_path, boom, report=lambda *_: None)
    result = suggest_mod.suggest(corpus, LIBRARY, tmp_path, boom, ask_fn=lambda r: {"cook": 0.9}, report=lambda *_: None)
    assert result["https://cook.example/new"][0]["by"] == "system-one"


def test_link_text_is_title_host_and_the_start_of_the_capture():
    text = tagdata.link_text("A title", "https://www.example.com/x", "word " * 1000)
    assert text.startswith("A title — example.com\n")
    assert len(text.split("\n", 1)[1]) <= tagdata.CAPTURE_TEXT_CHARS
    assert tagdata.link_text("T", "https://example.com/") == "T — example.com"


def test_load_links_drops_filtered_out_and_joins_capture_text(monkeypatch):
    links = {"links": [
        {"url": "https://a.example/1", "title": "one", "tags": [], "cap": {"kind": "page"}},
        {"url": "https://a.example/2", "title": "two", "tags": ["filtered-out"], "cap": None},
        {"url": "https://a.example/3", "title": "three", "tags": ["dev"], "cap": None},
        {"url": "chrome://browser/content/blanktab.html", "title": "New Tab", "tags": [], "cap": None},
    ]}
    export = {"captures": [{"url": "https://a.example/1", "text": "the captured text"}]}
    answers = {("links", "--all", "--json"): links, ("call", "export"): export}
    monkeypatch.setattr(tagdata, "link_keeper", lambda *a: json.dumps(answers[a]))
    got = tagdata.load_links()
    assert [l.url for l in got] == ["https://a.example/1", "https://a.example/3"]
    assert got[0].capture_text == "the captured text" and got[0].kind == "page"


def test_tag_library_leaves_out_the_internal_tag(monkeypatch):
    monkeypatch.setattr(tagdata, "link_keeper", lambda *a: json.dumps([{"name": "dev"}, {"name": "filtered-out"}]))
    assert tagdata.load_tag_library() == ["dev"]


def test_the_server_is_stopped_only_when_this_run_started_it(monkeypatch):
    calls = []
    monkeypatch.setattr(s1.subprocess, "run", lambda cmd, **kw: calls.append(cmd[1]) or None)
    monkeypatch.setattr(s1, "server_ready", lambda port: True)

    monkeypatch.setattr(s1, "server_port", lambda: 7811)  # already running
    with s1.system_one_server() as port:
        assert port == 7811
    assert "stop" not in calls and "start" not in calls

    ports = iter([None, 7811])  # not running, then up after `start`
    monkeypatch.setattr(s1, "server_port", lambda: next(ports))
    with s1.system_one_server():
        pass
    assert calls == ["start", "stop"]


def test_the_question_carries_the_tag_meaning_only_when_known():
    plain = s1.question_for("music", None)
    assert plain == "Would the owner file this link under the tag 'music'?"
    assert "multiplies" in s1.question_for("leverage", tagdata.DEFAULT_TAG_MEANINGS["leverage"])


def test_a_rerun_asks_only_about_new_links(corpus, tmp_path):
    asked = []

    def stub(request):
        asked.append(request["state"])
        return {tag: 0.9 for tag in request["questions"]}

    first = suggest_mod.suggest(corpus, LIBRARY, tmp_path, encode, system_one_only=True, ask_fn=stub, report=lambda *_: None)
    assert len(asked) == 2
    corpus.append(Link("https://cook.example/newer", "soup recipe", []))
    second = suggest_mod.suggest(corpus, LIBRARY, tmp_path, encode, system_one_only=True, ask_fn=stub, report=lambda *_: None)
    assert len(asked) == 3 and set(second) == set(first) | {"https://cook.example/newer"}
    assert second["https://cook.example/new"] == first["https://cook.example/new"]
