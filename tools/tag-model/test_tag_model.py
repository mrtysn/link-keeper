"""Tests for the tag model: training, the precision gate, the suggestions contract, link reading.

The encoder is a hashed bag of words and system-one is a stub, so the suite needs no model download
and no server. Run: `uv run pytest test_tag_model.py` from tools/tag-model.
"""

from __future__ import annotations

import io
import json
import random
import urllib.error
import zlib

import numpy as np
import pytest

import heads
import suggest as suggest_mod
import suggest_gutsy as gutsy_mod
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


LIBRARY = ["cook", "code", "noise", "games"]


def test_train_save_load_suggest(corpus, tmp_path):
    metrics = train.train_all(corpus, LIBRARY, tmp_path, encode, report=lambda *_: None)
    assert metrics["labelled_links"] == 120
    assert metrics["tags"]["cook"]["enabled"] and metrics["tags"]["code"]["enabled"]
    assert metrics["tags"]["cook"]["precision"] >= 0.7
    assert metrics["skipped"] == {"games": 0}
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
    assert any(i["by"] == "system-one" and i["tag"] == "games" for i in result["https://cook.example/new"])
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
                                 ask_fn=lambda r: {t: 0.9 for t in r["questions"]}, report=lambda *_: None)
    assert {i["by"] for items in result.values() for i in items} == {"system-one"}
    assert all(len(items) == 4 for items in result.values())  # four tags, all at 0.9: capped at 4


def test_personal_tags_are_never_asked_of_system_one(corpus, tmp_path):
    asked = set()
    def ask(request):
        asked.update(request["questions"])
        return {t: 0.9 for t in request["questions"]}
    result = suggest_mod.suggest(corpus, LIBRARY + ["leverage", "to-read"], tmp_path, encode,
                                 system_one_only=True, ask_fn=ask, report=lambda *_: None)
    assert asked and not asked & {"leverage", "to-read"}
    assert all(i["tag"] not in ("leverage", "to-read") for items in result.values() for i in items)


def test_threshold_keeps_only_what_clears_it(corpus, tmp_path):
    probs = {"cook": 0.95, "code": 0.84, "noise": 0.86, "games": 0.2}
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


def test_a_link_system_one_cannot_answer_is_skipped(corpus, tmp_path):
    def ask(request):
        if "oven" in request["state"]:
            raise RuntimeError("HTTP Error 500")
        return {t: 0.9 for t in request["questions"]}
    links = [l for l in corpus if "oven" in l.text][:1] + [l for l in corpus if "oven" not in l.text][:3]
    got = s1.score_links(links, ["games"], {}, 0.7, ask_fn=ask, report=lambda *_: None)
    assert links[0].url not in got and len(got) == 3


def test_system_one_failing_every_link_stops_the_run(corpus):
    def ask(request):
        raise RuntimeError("connection refused")
    with pytest.raises(RuntimeError, match="in a row"):
        s1.score_links(corpus[:10], ["games"], {}, 0.7, ask_fn=ask, report=lambda *_: None)


def test_a_500_is_retried_once(monkeypatch):
    replies = iter([urllib.error.HTTPError("u", 500, "boom", {}, None), io.BytesIO(b'{"answers": {"t": {"noul": 0.9}}}')])

    def urlopen(req, timeout):
        reply = next(replies)
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(s1.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(s1, "HTTP_500_RETRY_SECONDS", 0)
    assert s1.ask({"state": "x", "questions": {}}, 1) == {"t": 0.9}  # 500 once, then answered

    boom = urllib.error.HTTPError("u", 500, "boom", {}, None)
    monkeypatch.setattr(s1.urllib.request, "urlopen", lambda req, timeout: (_ for _ in ()).throw(boom))
    with pytest.raises(RuntimeError, match="did not answer"):  # 500 twice: left to the skip logic
        s1.ask({"state": "x", "questions": {}}, 1)
    link = Link("https://a.example/1", "t", [])
    assert s1.score_links([link], ["games"], {}, 0.7, ask_fn=lambda r: s1.ask(r, 1), report=lambda *_: None) == {}


def two_sources(corpus, tmp_path, **kw):
    return suggest_mod.suggest(
        corpus, LIBRARY, tmp_path, encode, system_one_only=True, report=lambda *_: None,
        ask_fn=lambda r: {t: 0.9 for t in r["questions"]},
        gutsy_ask_fn=lambda r: {"cook": 0.6, "code": 0.4, "noise": 0.5, "games": 0.9}, **kw)


def test_a_tag_from_both_servers_keeps_both_entries_and_each_threshold(corpus, tmp_path):
    result = two_sources(corpus, tmp_path)
    items = result["https://cook.example/new"]
    mine = [(i["tag"], i["by"]) for i in items]
    assert ("cook", "system-one") in mine and ("cook", "gutsy") in mine
    gutsy = {i["tag"]: i["p"] for i in items if i["by"] == "gutsy"}
    assert gutsy == {"cook": 0.6, "noise": 0.5, "games": 0.9}  # 0.50 is kept, 0.4 is not
    assert len([i for i in items if i["by"] == "system-one"]) == 4
    assert len(items) == 7  # up to 4 per source, not 4 per link
    assert [i["p"] for i in items] == sorted((i["p"] for i in items), reverse=True)


def test_system_one_needs_0_85_and_gutsy_0_5():
    assert s1.DEFAULT_THRESHOLD == 0.85 and gutsy_mod.GUTSY_THRESHOLD == 0.50
    link = Link("https://a.example/1", "t", [])
    probs = {"a": 0.84, "b": 0.85, "c": 0.49, "d": 0.5}
    kept = lambda th, src: [s.tag for s in s1.score_links([link], list(probs), {}, th, ask_fn=lambda r: probs,
                                                          report=lambda *_: None, source=src)[link.url]]
    assert kept(s1.DEFAULT_THRESHOLD, "system-one") == ["b"]
    assert kept(gutsy_mod.GUTSY_THRESHOLD, "gutsy") == ["a", "b", "d"]


def test_gutsy_is_skipped_when_unset_or_switched_off(corpus, tmp_path):
    said = []
    kw = dict(system_one_only=True, ask_fn=lambda r: {t: 0.9 for t in r["questions"]}, report=said.append)
    result = suggest_mod.suggest(corpus, LIBRARY, tmp_path, encode, gutsy_dir=None, **kw)
    assert {i["by"] for items in result.values() for i in items} == {"system-one"}
    assert [s for s in said if "GUTSY_DIR is not set" in s] == [gutsy_mod.skip_line()]
    said.clear()
    result = suggest_mod.suggest(corpus, LIBRARY, tmp_path, encode, gutsy_ask_fn=lambda r: {"cook": 0.9},
                                 use_gutsy=False, **kw)
    assert "gutsy" not in {i["by"] for items in result.values() for i in items}
    assert any("--no-gutsy" in s for s in said)


def test_each_server_has_its_own_answer_cache(corpus, tmp_path):
    asked = {"s1": 0, "gutsy": 0}

    def count(name):
        def ask(request):
            asked[name] += 1
            return {t: 0.9 for t in request["questions"]}
        return ask

    for _ in range(2):
        suggest_mod.suggest(corpus, LIBRARY, tmp_path, encode, system_one_only=True, report=lambda *_: None,
                            ask_fn=count("s1"), gutsy_ask_fn=count("gutsy"))
    assert asked == {"s1": 2, "gutsy": 2}  # the second run asks nothing
    assert (tmp_path / "system-one-answers.json").is_file() and (tmp_path / gutsy_mod.ANSWERS_FILE).is_file()


def test_trained_heads_cover_a_tag_for_both_servers(corpus, tmp_path):
    train.train_all(corpus, LIBRARY, tmp_path, encode, report=lambda *_: None)
    asked = []

    def ask(request):
        asked.append(set(request["questions"]))
        return {t: 0.9 for t in request["questions"]}

    suggest_mod.suggest(corpus, LIBRARY, tmp_path, encode, ask_fn=ask, gutsy_ask_fn=ask, report=lambda *_: None)
    assert asked and all("cook" not in q and "code" not in q for q in asked)


def test_the_gutsy_server_is_stopped_only_when_this_run_started_it(monkeypatch, tmp_path):
    install = tmp_path / "gutsy"
    (install / ".venv" / "bin").mkdir(parents=True)
    (install / ".venv" / "bin" / "gutsy-inference").write_text("")
    events = []

    class Proc:
        returncode = None
        def poll(self): return None
        def terminate(self): events.append("terminate")
        def wait(self, timeout=None): events.append("wait")

    monkeypatch.setattr(gutsy_mod.subprocess, "Popen", lambda cmd, **kw: events.append((cmd[1], kw["cwd"])) or Proc())
    monkeypatch.setattr(s1, "server_ready", lambda port: True)
    with gutsy_mod.gutsy_server(install, tmp_path / "log") as port:  # already listening
        assert port == gutsy_mod.GUTSY_PORT
    assert events == []

    ready = iter([False, True])
    monkeypatch.setattr(s1, "server_ready", lambda port: next(ready))
    monkeypatch.setattr(gutsy_mod.time, "sleep", lambda s: None)
    with gutsy_mod.gutsy_server(install, tmp_path / "log"):
        pass
    assert events == [("serve", install), "terminate", "wait"]


def test_gutsy_without_an_install_fails_clearly(monkeypatch, tmp_path):
    monkeypatch.setattr(s1, "server_ready", lambda port: False)
    with pytest.raises(RuntimeError, match="GUTSY_DIR"):
        with gutsy_mod.gutsy_server(tmp_path, tmp_path / "log"):
            pass
