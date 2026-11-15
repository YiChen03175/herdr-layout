#!/usr/bin/env python3
"""Makes the picture a macOS notification shows for an agent: its icon on a
rounded tile, as a PNG (notifications can't show SVG, and can't change their
app icon, so this goes in as the attached image).

    notify_icon.py <icon.svg> <tile color> <glyph color> <out.png>

A one-color icon (fill="currentColor") is drawn in the glyph color; a colored
one keeps its colors. Does nothing when <out.png> is newer than the icon.
"""
import os
import re
import subprocess
import sys
import tempfile

src, tile, color, out = sys.argv[1:5]
if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(src):
    sys.exit(0)
with open(src, encoding="utf-8") as f:
    svg = f.read().strip()
head = re.search(r"<svg\b[^>]*>", svg)  # after any <?xml ...?> or comment
if not head:
    sys.exit(1)
box = re.search(r'viewBox="([^"]+)"', head.group(0))
box = box.group(1) if box else "0 0 24 24"
inner = re.sub(r"</svg>\s*$", "", svg[head.end():]).replace("currentColor", color)
fill = f' fill="{color}"' if 'fill="currentColor"' in head.group(0) else ""
tiled = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">'
    f'<rect width="256" height="256" rx="58" fill="{tile}"/>'
    f'<svg x="52" y="52" width="152" height="152" viewBox="{box}"{fill}>{inner}</svg></svg>'
)
os.makedirs(os.path.dirname(out), exist_ok=True)
# Made beside it and moved in only when whole: a half-written PNG would count as made.
with tempfile.TemporaryDirectory(dir=os.path.dirname(out)) as work:
    tmp_svg, tmp_png = os.path.join(work, "icon.svg"), os.path.join(work, "icon.png")
    with open(tmp_svg, "w", encoding="utf-8") as f:
        f.write(tiled)
    try:
        r = subprocess.run(["sips", "-s", "format", "png", tmp_svg, "--out", tmp_png], capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        sys.exit(1)
    if r.returncode != 0 or not os.path.exists(tmp_png) or not os.path.getsize(tmp_png):
        sys.exit(1)
    os.replace(tmp_png, out)
