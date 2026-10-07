# -*- coding: utf-8 -*-
"""Compose hero-layout.svg (base64 icon layers) and render hero.png via Chrome headless."""
import base64, subprocess, sys, os
from pathlib import Path

ROOT = Path(r"C:/Users/jackmin/Documents/my_project/remote_codex/assets/readme")
SRC = ROOT / "source"


def b64(p):
    return base64.b64encode(Path(p).read_bytes()).decode()


svg = (ROOT / "source" / "hero-layout-svg-template.svg").read_text(encoding="utf-8")

# Icon layers inside chain boxes 1 (Codex UI), 3 (SSH channel), 5 (remote workspace)
ICONS = {
    "%%ICON_LOCAL%%": SRC / "icon-local.png",
    "%%ICON_LOCK%%": SRC / "icon-lock.png",
    "%%ICON_REMOTE%%": SRC / "icon-remote.png",
}
for token, path in ICONS.items():
    uri = "data:image/png;base64," + b64(path)
    assert token in svg, token
    svg = svg.replace(token, uri)

out_svg = SRC / "hero-layout.svg"
out_svg.write_text(svg, encoding="utf-8")

png = ROOT / "hero.png"
chrome = r"C:/Program Files/Google/Chrome/Application/chrome.exe"
cmd = [
    chrome, "--headless", "--disable-gpu", "--no-sandbox",
    "--force-device-scale-factor=2", "--window-size=1200,380",
    "--default-background-color=00000000",
    "--screenshot=" + str(png), str(out_svg),
]
r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
print("chrome rc:", r.returncode)
if r.returncode != 0:
    print(r.stderr[-2000:])
    sys.exit(1)
print("saved:", png, png.stat().st_size, "bytes")
