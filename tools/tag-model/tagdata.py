"""Shared pieces of the tag model: where data lives, reading links, link text, the output contract.

The tag model suggests tags for links the owner has not tagged. Two voices share one output:
the local `system-one` model guesses any tag, and a Jeffy head trained on the owner's own tags
takes over for a tag once it has enough examples. Both write the same shape (see `Suggestion`).
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

REPO = Path(__file__).resolve().parents[2]
LINK_KEEPER = REPO / "tools" / "link-keeper.mjs"

# The internal tag that marks a link the owner's filter rules threw out; never learned, never suggested.
INTERNAL_TAG = "filtered-out"
CAPTURE_TEXT_CHARS = 1500
MAX_SUGGESTIONS_PER_LINK = 4
SOURCE_SYSTEM_ONE = "system-one"
SOURCE_MODEL = "model"

# One line per tag whose name alone does not say what belongs under it. The owner's own list lives in
# `<data dir>/tag-model/tag-meanings.json` ({tag: meaning}) and overrides these.
DEFAULT_TAG_MEANINGS = {
    "leverage": "an idea, tool or service that multiplies what one person can get done with little effort",
    "numbness": "content that dulls attention or feelings: mindless scrolling, doom, endless feeds",
    "enhancement": "ways to improve oneself: body, mind, health, skills, habits, performance",
    "crowd": "what groups of people do together: communities, crowds, social dynamics, collective behaviour",
    "capital": "money, investing, funding, business assets and ways to grow wealth",
    "niche": "a small specialised market or audience and the opportunity it offers",
    "network": "people, connections, contacts, relationships and networking",
    "gamble": "betting, chance, risk-taking, speculative bets with a large possible payoff",
    "addiction": "compulsion, dependence, habits that are hard to stop, and how products hook people",
    "discipline": "habits, routine, self-control and sticking to a plan",
    "focus": "deep work, attention, concentration and removing distraction",
    "content": "making and publishing content: posts, videos, writing, audience growth",
    "text": "writing and written material to read: essays, documents, text tools",
    "image": "pictures and visual material: photos, illustration, image tools",
    "experience": "things to do or live through: places, events, trips, activities",
    "random": "an odd, unrelated find that fits no other tag",
    "cv": "material for the owner's CV or résumé: roles, skills, achievements, how to present them",
    "eat": "food: recipes, restaurants, cafes, groceries, cooking",
    "ux": "user experience and interface design",
    "subscription": "recurring-payment services and products",
    "commute": "getting around: transport, travel to work, routes",
    "portfolio": "work to show: the owner's projects, case studies, examples of finished work",
    "principles": "rules to live or work by",
    "ambitions": "long-term aims and what to aim for",
    "goals": "concrete goals and plans to reach them",
    "experimental": "unusual experiments and prototypes worth trying",
    "to-try": "something to try out or test",
    "to-read": "something to read later",
    "to-watch": "something to watch later",
    "reference": "something to keep for later lookup",
    "inspiration": "something that inspires ideas or taste",
}


def data_dir(override: str | None = None) -> Path:
    """The folder the refresh writes to: --data-dir, else $DATA_DIR, else config.local.sh's DATA_DIR,
    else this repo's gitignored data/."""
    if override:
        return Path(override).expanduser().resolve()
    if os.environ.get("DATA_DIR"):
        return Path(os.environ["DATA_DIR"]).expanduser().resolve()
    config = REPO / "config.local.sh"
    if config.is_file():
        got = subprocess.run(
            ["zsh", "-c", 'source "$1" >/dev/null 2>&1; print -r -- "${DATA_DIR:-}"', "zsh", str(config)],
            capture_output=True, text=True,
        ).stdout.strip()
        if got:
            return Path(got).expanduser().resolve()
    return REPO / "data"


def model_dir(override: str | None = None) -> Path:
    """`<data dir>/tag-model`: embeddings, heads, metrics, suggestions."""
    path = data_dir(override) / "tag-model"
    path.mkdir(parents=True, exist_ok=True)
    return path


def link_keeper(*args: str) -> str:
    """Run the link-keeper CLI and return its stdout; raises with its message on failure."""
    done = subprocess.run(["node", str(LINK_KEEPER), *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"link-keeper {' '.join(args)} failed: {(done.stderr or done.stdout).strip()}")
    return done.stdout


@dataclass
class Link:
    url: str
    title: str
    tags: list[str]
    capture_text: str = ""
    kind: str = ""

    @property
    def host(self) -> str:
        return (urlparse(self.url).hostname or "").removeprefix("www.")

    @property
    def text(self) -> str:
        return link_text(self.title, self.url, self.capture_text)


def link_text(title: str, url: str, capture_text: str = "", limit: int = CAPTURE_TEXT_CHARS) -> str:
    """Title, site host, then the first `limit` characters of the capture's text."""
    host = (urlparse(url).hostname or "").removeprefix("www.")
    head = " — ".join(part for part in ((title or "").strip(), host) if part)
    body = " ".join((capture_text or "").split())[:limit]
    return f"{head}\n{body}" if body else head


def load_tag_library() -> list[str]:
    """Tag names in the owner's library, without the internal tag."""
    tags = json.loads(link_keeper("tags", "--json"))
    return [t["name"] for t in tags if t["name"] != INTERNAL_TAG]


def load_links() -> list[Link]:
    """Every link with its tags and, where captured, its text. Links carrying the internal tag are left out.

    Capture text comes from one `call export`; when that read is unavailable (Firefox closed, so the
    CLI answers from the latest backup), each captured link is read with `capture URL --json`.
    """
    raw = json.loads(link_keeper("links", "--all", "--json"))["links"]
    texts: dict[str, str] = {}
    try:
        for cap in json.loads(link_keeper("call", "export")).get("captures", []):
            if cap.get("url") and cap.get("text"):
                texts[cap["url"]] = cap["text"]
    except (RuntimeError, ValueError):
        for item in raw:
            if item.get("cap"):
                try:
                    texts[item["url"]] = json.loads(link_keeper("capture", item["url"], "--json")).get("text") or ""
                except (RuntimeError, ValueError):
                    pass
    links = []
    for item in raw:
        tags = item.get("tags") or []
        if INTERNAL_TAG in tags or not item["url"].startswith(("http://", "https://")):
            continue
        links.append(Link(item["url"], item.get("title") or "", list(tags), texts.get(item["url"], ""),
                          (item.get("cap") or {}).get("kind") or ""))
    return links


# Tags that say what the owner means to do with a link, or an idea of theirs, rather than what the page
# is about. A page's text cannot show them, and system-one guessed them on cookware pages, so they
# are never asked of system-one: they are suggested only by a head trained on the owner's own tags.
PERSONAL_TAGS = {
    "to-read", "to-watch", "to-try", "reference", "inspiration", "work", "personal", "random",
    "leverage", "numbness", "enhancement", "crowd", "capital", "niche", "network", "gamble",
    "addiction", "discipline", "focus", "content", "text", "image", "experience", "cv", "portfolio",
    "principles", "ambitions", "goals", "experimental",
}


def tag_meanings(model_folder: Path) -> dict[str, str]:
    """The built-in one-line meanings, overridden by the owner's tag-meanings.json."""
    meanings = dict(DEFAULT_TAG_MEANINGS)
    own = model_folder / "tag-meanings.json"
    if own.is_file():
        meanings.update(json.loads(own.read_text()))
    return meanings


@dataclass
class Suggestion:
    tag: str
    p: float
    by: str

    def as_dict(self) -> dict:
        return {"tag": self.tag, "p": round(float(self.p), 4), "by": self.by}


def finish_suggestions(per_link: dict[str, list[Suggestion]]) -> dict[str, list[dict]]:
    """Sort each link's suggestions by p descending, keep the top few, drop links with none."""
    out = {}
    for url, found in per_link.items():
        top = sorted(found, key=lambda s: -s.p)[:MAX_SUGGESTIONS_PER_LINK]
        if top:
            out[url] = [s.as_dict() for s in top]
    return out


def write_json(path: Path, value) -> None:
    """Write via a temp file so a reader never sees half a file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    tmp.replace(path)
