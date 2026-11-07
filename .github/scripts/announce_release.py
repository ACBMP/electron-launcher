#!/usr/bin/env python3
"""POST a published GitHub Release to the API's /launcher/latest endpoint.

Run by .github/workflows/announce.yml with the release JSON (as returned by
`gh api repos/:owner/:repo/releases/tags/:tag`) as its only argument. Reads
API_URL and API_KEY from the environment.

Only ever sends version/notes/url/downloads. minimumVersion is the switch that
stops old launchers from playing, so it is never set automatically.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

# The launcher renders notes as one line of plain text in the update banner, so
# a full markdown changelog has to be condensed rather than passed through.
NOTES_MAX = 200

VERSION_RE = re.compile(r"^v?\d+\.\d+\.\d+")

# Asset suffix -> the key the launcher looks for in `downloads`.
TARGETS = ((".exe", "win"), (".AppImage", "linux"), (".deb", "deb"))

_SKIP_LINE = re.compile(r"^\s*(#|<!--|---|\*\*\*|___)")
_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_EMPHASIS = re.compile(r"[*_`~]")
# electron-builder / GitHub add these to generated notes; they mean nothing to a
# player looking at a one-line banner.
_BOILERPLATE = re.compile(
    r"^\s*(full changelog|what's changed|new contributors)\b", re.IGNORECASE
)


def summarize(body):
    """Flatten markdown release notes into one short plain-text line."""
    parts = []

    for line in (body or "").replace("\r", "").split("\n"):
        if not line.strip() or _SKIP_LINE.match(line) or _BOILERPLATE.match(line):
            continue

        text = _EMPHASIS.sub("", _LINK.sub(r"\1", _BULLET.sub("", line))).strip()

        if text:
            parts.append(text)

    notes = " · ".join(parts)

    if len(notes) > NOTES_MAX:
        notes = notes[: NOTES_MAX - 1].rstrip(" ·") + "…"

    return notes


def downloads_for(assets):
    urls = {}

    for asset in assets:
        name = asset.get("name", "")

        for suffix, key in TARGETS:
            # First asset wins, so a re-uploaded duplicate can't clobber the
            # canonical one.
            if name.endswith(suffix) and key not in urls:
                urls[key] = asset["browser_download_url"]

    return urls


def main():
    release = json.load(open(sys.argv[1]))

    tag = release.get("tag_name", "")

    if release.get("draft") or release.get("prerelease"):
        print(f"::notice::{tag} is a draft or prerelease — not announcing it.")
        return 0

    if not VERSION_RE.match(tag):
        print(f"::error::Tag {tag!r} is not a version the API will accept (want v1.2.3).")
        return 1

    payload = {
        "version": tag.lstrip("vV"),
        "notes": summarize(release.get("body")),
        "url": release.get("html_url"),
        "downloads": downloads_for(release.get("assets", [])),
    }

    if not payload["downloads"]:
        # Not fatal: the banner's Download button falls back to the release
        # page. But it means the platform jobs uploaded nothing, which is worth
        # seeing in the run summary.
        print("::warning::Release has no .exe/.AppImage/.deb assets.")

    print(json.dumps(payload, indent=2))

    request = urllib.request.Request(
        os.environ["API_URL"].rstrip("/") + "/launcher/latest",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + os.environ["API_KEY"],
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print(f"Published {payload['version']}: {response.read().decode()}")
    except urllib.error.HTTPError as error:
        # Show the body — the endpoint explains itself ("minimumVersion cannot
        # be newer than version", "Insufficient privileges", ...).
        print(f"::error::API returned {error.code}: {error.read().decode()}")
        return 1
    except urllib.error.URLError as error:
        print(f"::error::Could not reach the API: {error.reason}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
