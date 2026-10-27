"""Regenerate html_unescape.json: what the Python original makes of generated strings.

    python3 tests/fixtures/text/html_unescape.py        (from the repository root)

tests/text.test.ts replays every string through the TypeScript port and expects the same
output, so the port is checked against Python's html.unescape (and the original Python
clean_text, kept below) rather than against itself. The strings are generated from a fixed
seed: the same Python writes the same file.
"""

import html
import json
import os
import random
import re
import sys
from html.entities import html5

HERE = os.path.dirname(os.path.abspath(__file__))

# clean_text exactly as the Python version of Reygent had it (reygent/text.py), kept here
# so this script still runs now that the Python sources are gone.
_TAG_RX = re.compile(r"</?[a-zA-Z][^<>]*>")
_SPACE_RX = re.compile(r"[ \t\r\f\v]+")
_PUNCT_MAP = {
    0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"',
    0x2013: "-", 0x2014: "-", 0x2212: "-", 0x00A0: " ",
}


def clean_text(raw: str) -> str:
    """Strip HTML, decode entities and normalise typographic punctuation."""
    text = html.unescape(html.unescape(raw or ""))
    text = _TAG_RX.sub(" ", text).translate(_PUNCT_MAP)
    return _SPACE_RX.sub(" ", text).strip()


rng = random.Random(20261012)
WITH_SEMICOLON = sorted(name for name in html5 if name.endswith(";"))
LEGACY = sorted(name for name in html5 if not name.endswith(";"))
ROCKET = "\U0001F680"

# Code points on and around every boundary html.unescape treats specially.
CODE_POINTS = [
    0, 1, 8, 9, 10, 11, 12, 13, 14, 31, 32, 34, 38, 39, 60, 62, 65, 127, 128, 129, 133, 141, 146, 150, 159, 160,
    233, 0x2019, 0x2028, 0xD7FF, 0xD800, 0xDBFF, 0xDC00, 0xDFFF, 0xE000, 0xFDCF, 0xFDD0, 0xFDEF, 0xFDF0, 0xFFFD,
    0xFFFE, 0xFFFF, 0x10000, 0x1F680, 0x1FFFD, 0x1FFFE, 0x1FFFF, 0x10FFFD, 0x10FFFE, 0x10FFFF, 0x110000,
    0xFFFFFFFF, 99999999999999999999999999,
]
# Text that can follow a reference and change how it is read.
TAILS = ["", "", ";", " ", "money", "it;", "=2", "900", "x", "A", "z9", "\u00e9", ROCKET, "\t", "\n", "\x0c", "\r", "&", "<b>", "#", ".", "/", ";;"]
WORDS = ["Earn", "per day", "registration", "fee", "experience", "required", "Easy", "t", "me/", "R&D", "AT&T", "Q & A",
         "a<b", "1 < 2", "caf\u00e9", "\u201cquoted\u201d", "x\u00a0y", ROCKET, "https://x.test/?a=1", "100%", "#1", ";"]
JUNK = ["&", "&&", "&;", "&#", "&#;", "&#x", "&#x;", "&#X;", "&#xZZ;", "&#-5;", "&#+5;", "&# 65;", "&#65x;", "&#x41g",
        "&#x41;g", "& amp;", "&\tamp;", "&\namp;", "&<amp;", "&am", "&a", "&A;", "&Amp;", "&NBSP;", "&nbs", "&nbsp",
        "&bogus;", "&notanentity;", "&#0065;", "&#x000041;", "&#X41", "&#65", "&#1234567890123456789012345678901234567890;"]


def numeric():
    value = rng.choice(CODE_POINTS + [rng.randrange(0, 0x110000) for _ in range(6)])
    form = rng.choice(["#%d", "#%d", "#x%x", "#X%X", "#x%X", "#0%d", "#x00%x"])
    return "&" + form % value


def named():
    kind = rng.randrange(6)
    if kind == 0:
        return "&" + rng.choice(WITH_SEMICOLON)            # a full reference
    if kind == 1:
        return "&" + rng.choice(WITH_SEMICOLON)[:-1]       # its name with the ";" left off
    if kind == 2:
        return "&" + rng.choice(LEGACY)                    # a name that is valid without ";"
    if kind == 3:
        return "&" + rng.choice(LEGACY) + rng.choice(["money", "it", "X", "9", "=2", "\u00e9", ROCKET])
    if kind == 4:
        name = rng.choice(WITH_SEMICOLON)[:-1]             # a damaged name
        return "&" + rng.choice([name[:-1], name.upper(), name.lower(), name.swapcase(), name + name])
    return "&amp;" + rng.choice(WITH_SEMICOLON + LEGACY)   # escaped twice, as ATS feeds send it


def long_name():
    length = rng.choice([31, 32, 33, 40])
    unit = rng.choice(["a", ROCKET, "\u00e9"])
    return "&" + unit * length + rng.choice([";", "", "amp;"])


def piece():
    roll = rng.random()
    if roll < 0.40:
        return named() + rng.choice(TAILS)
    if roll < 0.65:
        return numeric() + rng.choice(TAILS)
    if roll < 0.80:
        return rng.choice(WORDS)
    if roll < 0.95:
        return rng.choice(JUNK)
    return long_name()


def chunks(items, size):
    return [items[start:start + size] for start in range(0, len(items), size)]


strings = []
# 1. Every entry of the table, exactly as html.unescape keys it (with and without ";").
strings += ["|".join("&" + name for name in group) for group in chunks(sorted(html5), 16)]
# 2. Every name with its ";" left off: only the legacy ones (and legacy prefixes) may decode.
strings += [" ".join("&" + name[:-1] for name in group) for group in chunks(WITH_SEMICOLON, 16)]
# 3. Every legacy name run straight into more text.
strings += ["&%smoney &%s=2 &%s9 &%s;x" % (name, name, name, name) for name in LEGACY]
# 4. Every special code point, decimal and hex, with and without ";".
strings += ["&#%d; &#%d &#x%x; &#X%Xz" % (value, value, value, value) for value in CODE_POINTS]
# 5. The obfuscations the scam filter met, and the odd shapes on their own.
strings += ["Earn &dollar;900 per day", "registration&Tab;fee", "experience&NewLine;required", "t&period;me/",
            "Easy&nbspmoney", "&#32income", "&#x41rest", "&notit;", "?a=1&copy=2&region=us", "&amp;nbsp;", "&amp;amp;lt;"]
strings += JUNK
# 6. Random mixtures of all of the above.
strings += [rng.choice(["", " ", "x"]).join(piece() for _ in range(rng.randrange(1, 7))) for _ in range(500)]

fixture = {
    "about": "Generated by tests/fixtures/text/html_unescape.py; do not edit by hand.",
    "python": sys.version.split()[0],
    "cases": [[text, html.unescape(text), clean_text(text)] for text in strings],
}
lines = ["{", ' "about": %s,' % json.dumps(fixture["about"]), ' "python": %s,' % json.dumps(fixture["python"]), ' "cases": [']
lines += ["  " + json.dumps(case, ensure_ascii=True) + ("," if index < len(strings) - 1 else "") for index, case in enumerate(fixture["cases"])]
lines += [" ]", "}"]
with open(os.path.join(HERE, "html_unescape.json"), "w", encoding="ascii") as handle:
    handle.write("\n".join(lines) + "\n")
print("%d cases written" % len(strings))
