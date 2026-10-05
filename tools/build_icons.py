"""Builds the site's icon font from the icons it actually uses.

The Phosphor icon set has about 1,500 icons in each of three weights
(regular, bold, fill): 430 KB of fonts and 250 KB of CSS. The site uses a
small part of it, so this script keeps only those icons and writes:

    assets/fonts/phosphor-{regular,bold,fill}.woff2
    assets/css/icons.css

Run it again after using an icon the site hasn't used before (an icon that
isn't in the font shows as an empty space):

    pip install fonttools brotli
    python tools/build_icons.py

It needs an internet connection the first time, to fetch Phosphor 2.1.2.
Nothing else in the site needs building.
"""

import glob
import os
import re
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get("PHOSPHOR_CACHE", os.path.join(ROOT, "tools", ".phosphor"))
CDN = "https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.2/src"
WEIGHTS = {
    # weight: (font file, css class, font family)
    "regular": ("Phosphor.woff2", "ph", "Phosphor"),
    "bold": ("Phosphor-Bold.woff2", "ph-bold", "Phosphor-Bold"),
    "fill": ("Phosphor-Fill.woff2", "ph-fill", "Phosphor-Fill"),
}


def fetch(weight, name):
    path = os.path.join(CACHE, f"{weight}-{name}")
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        req = urllib.request.Request(f"{CDN}/{weight}/{name}", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as res, open(path, "wb") as out:
            out.write(res.read())
    return path


def main():
    # Every word in the site's pages and scripts. Any of them that is also an
    # icon name is kept, so an icon chosen in code ("ph-" + name) is found too.
    words = set()
    sources = glob.glob(os.path.join(ROOT, "*.html")) + glob.glob(os.path.join(ROOT, "assets", "js", "**", "*.js"), recursive=True)
    for path in sources:
        for word in re.findall(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", open(path, encoding="utf8").read()):
            words.add(word)
            # "ph-arrow-up" in a class list names the icon "arrow-up".
            if word.startswith("ph-"):
                words.add(word[3:])

    os.makedirs(os.path.join(ROOT, "assets", "fonts"), exist_ok=True)
    css = [
        "/* Phosphor icons 2.1.2 (MIT), only the icons this site uses.",
        "   Made by tools/build_icons.py; run it again after using a new icon. */",
        "",
    ]
    report = []
    for weight, (font_file, cls, family) in WEIGHTS.items():
        sheet = open(fetch(weight, "style.css"), encoding="utf8").read()
        codes = dict(re.findall(r"\.ph-([a-z0-9-]+):before\s*\{\s*content:\s*\"\\([0-9a-f]+)\";", sheet))
        used = sorted(name for name in codes if name in words)
        assert used, weight

        out = os.path.join(ROOT, "assets", "fonts", f"phosphor-{weight}.woff2")
        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = []  # the site uses classes, not ligatures
        options.name_IDs = []
        options.notdef_outline = True
        font = TTFont(fetch(weight, font_file))
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=[int(codes[name], 16) for name in used])
        subsetter.subset(font)
        font.flavor = "woff2"
        font.save(out)

        base = re.search(r"\.%s \{.*?\n\}" % re.escape(cls), sheet, re.S).group(0)
        base = re.sub(r"\n\s*/\* Enable Ligatures.*?(?=\n\s*/\* Better Font Rendering)", "", base, flags=re.S)
        css.append(f'@font-face {{\n  font-family: "{family}";\n  src: url("../fonts/phosphor-{weight}.woff2") format("woff2");\n  font-weight: normal;\n  font-style: normal;\n  font-display: block;\n}}')
        css.append(base)
        css.append("\n".join(f'.{cls}.ph-{name}:before {{ content: "\\{codes[name]}"; }}' for name in used))
        css.append("")
        report.append(f"{weight}: {len(used)} icons, {os.path.getsize(out) // 1024} KB")

    with open(os.path.join(ROOT, "assets", "css", "icons.css"), "w", encoding="utf8", newline="\n") as f:
        f.write("\n".join(css))
    print("; ".join(report))
    print("icons.css:", os.path.getsize(os.path.join(ROOT, "assets", "css", "icons.css")) // 1024, "KB")


if __name__ == "__main__":
    sys.exit(main())
