#!/usr/bin/env python3
"""Generate docs/assets/enzo-banner.svg — animated ENZO title bar.

Logo source of truth: synthetic-nature/public/android-chrome-512x512.png
(official app icon / favicon mark). A white rounded tile pops in, the mark
assembles from shards (clip-path windows over <use> of one embedded image),
then ENZO letters + tagline rise. All CSS animation, settled base states,
prefers-reduced-motion respected — pure SVG, no JS, no external refs.
"""
import base64
import io
import math
import numpy as np
from PIL import Image, ImageDraw

SRC = "synthetic-nature/public/android-chrome-512x512.png"
OUT = "docs/assets/enzo-banner.svg"

# layout ------------------------------------------------------------------
W, H = 860, 160
TILE = 96
RX = 22
TILE_Y = 32
LOCKUP_W = TILE + 40 + 330          # tile + gap + text block
X0 = (W - LOCKUP_W) // 2           # centered lockup start
TILE_X = X0
MARK = 84
MX, MY = TILE_X + 6, TILE_Y + 6     # mark origin inside tile
BASELINE = 100
TAG_Y = BASELINE + 28
LETTERS = ["E", "N", "Z", "O"]
LCOLS = ["#7C5CFF", "#6E7BFF", "#4B9DFF", "#22D3EE"]
TAGLINE = "the AI workspace with no middleman"

COLS, ROWS = 4, 4                   # shard grid over the mark
LETTER_T0, LETTER_STAG, LETTER_DUR = 1.15, 0.16, 0.5
TAG_T0, TAG_DUR = 1.85, 0.6


def b64_png(im):
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def rounded_tile():
    tile = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    white = Image.new("RGBA", (TILE, TILE), (255, 255, 255, 255))
    mask = Image.new("L", (TILE, TILE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, TILE - 1, TILE - 1], radius=RX, fill=255)
    tile.paste(white, (0, 0), mask)
    return tile


def mark_img():
    im = Image.open(SRC).convert("RGBA")
    # the 512 icon ships its own light-gray rounded background — crop to the
    # emblem itself so the shield sits natively on the white tile
    a = np.array(im)
    alpha = a[:, :, 3] > 128
    lum = a[:, :, :3].mean(axis=2)
    # emblem = darker than its gray plate, or colorful vs the neutral bg
    colorful = (a[:, :, :3].max(axis=2).astype(int)
                - a[:, :, :3].min(axis=2).astype(int)) > 24
    mask = alpha & ((lum < 165) | colorful)
    ys, xs = np.where(mask)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    pad = 6
    box = (max(0, x0 - pad), max(0, y0 - pad),
           min(im.width, x1 + pad), min(im.height, y1 + pad))
    cropped = im.crop(box)
    return cropped.resize((MARK, MARK), Image.LANCZOS)


def build():
    tile_b64 = b64_png(rounded_tile())
    mark_b64 = b64_png(mark_img())

    cw = MARK / COLS
    ch = MARK / ROWS
    cx, cy = MX + MARK / 2, MY + MARK / 2

    shards = []          # (delay, fx, fy, cliprect)
    cells = []
    for r in range(ROWS):
        for c in range(COLS):
            cells.append((r, c))
    # order by distance from center: core forms first, edges land last
    cells.sort(key=lambda rc: (rc[0] - (ROWS - 1) / 2) ** 2 + (rc[1] - (COLS - 1) / 2) ** 2)
    for i, (r, c) in enumerate(cells):
        sx, sy = MX + c * cw, MY + r * ch
        ang = math.atan2(r - (ROWS - 1) / 2, c - (COLS - 1) / 2)
        dist = 120 + ((i * 37) % 60)
        fx, fy = math.cos(ang) * dist, math.sin(ang) * dist
        delay = 0.30 + i * 0.055
        shards.append((delay, fx, fy, sx, sy, cw, ch, i))

    s = []
    s.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
        f'aria-label="ENZO — the AI workspace with no middleman">'
    )
    s.append("<title>ENZO</title>")
    s.append("<defs>")
    s.append(
        '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#0d1117"/>'
        '<stop offset="1" stop-color="#171230"/>'
        "</linearGradient>"
    )
    s.append(
        '<radialGradient id="sheenA" cx="0.15" cy="0" r="1.1">'
        '<stop offset="0" stop-color="#7C5CFF" stop-opacity="0.14"/>'
        '<stop offset="1" stop-color="#7C5CFF" stop-opacity="0"/>'
        "</radialGradient>"
    )
    s.append(
        '<radialGradient id="sheenB" cx="0.95" cy="1" r="1.1">'
        '<stop offset="0" stop-color="#22D3EE" stop-opacity="0.10"/>'
        '<stop offset="1" stop-color="#22D3EE" stop-opacity="0"/>'
        "</radialGradient>"
    )
    s.append(
        '<linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">'
        '<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>'
        '<stop offset="0.5" stop-color="#ffffff" stop-opacity="0.07"/>'
        '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>'
        "</linearGradient>"
    )
    s.append(
        '<filter id="tsh" x="-40%" y="-40%" width="180%" height="180%">'
        '<feDropShadow dx="0" dy="5" stdDeviation="9" flood-color="#000000" flood-opacity="0.5"/>'
        "</filter>"
    )
    # embedded official mark — referenced once, reused by every shard
    s.append(
        f'<image id="mk" href="data:image/png;base64,{mark_b64}" '
        f'xlink:href="data:image/png;base64,{mark_b64}" '
        f'x="{MX}" y="{MY}" width="{MARK}" height="{MARK}"/>'
    )
    for delay, fx, fy, sx, sy, sw, sh, i in shards:
        s.append(
            f'<clipPath id="c{i}"><rect x="{sx:.2f}" y="{sy:.2f}" '
            f'width="{sw:.2f}" height="{sh:.2f}"/></clipPath>'
        )
    s.append("</defs>")

    s.append(f'<rect width="{W}" height="{H}" rx="18" fill="url(#bg)"/>')
    s.append(f'<rect width="{W}" height="{H}" rx="18" fill="url(#sheenA)"/>')
    s.append(f'<rect width="{W}" height="{H}" rx="18" fill="url(#sheenB)"/>')
    s.append(
        f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="18" '
        f'fill="none" stroke="#30363d" stroke-width="1"/>'
    )

    # wordmark letters
    for i, ch in enumerate(LETTERS):
        x = TILE_X + TILE + 40 + i * 62
        s.append(
            f'<text class="lt lt{i}" x="{x}" y="{BASELINE}" '
            f'style="font:800 76px -apple-system,\'Segoe UI\',sans-serif;letter-spacing:2px" '
            f'fill="{LCOLS[i]}">{ch}</text>'
        )
    tag_x = TILE_X + TILE + 42
    s.append(
        f'<text class="tg" x="{tag_x}" y="{TAG_Y}" '
        f'style="font:500 17px -apple-system,\'Segoe UI\',sans-serif" '
        f'fill="#8b949e">{TAGLINE}</text>'
    )

    # white tile pops in (base state: settled)
    s.append(
        f'<image class="tile" href="data:image/png;base64,{tile_b64}" '
        f'xlink:href="data:image/png;base64,{tile_b64}" '
        f'x="{TILE_X}" y="{TILE_Y}" width="{TILE}" height="{TILE}" '
        f'filter="url(#tsh)"/>'
    )

    # mark shards: clip windows fly in and settle into the official mark
    for delay, fx, fy, sx, sy, sw, sh, i in shards:
        s.append(f'<g class="sh s{i}" clip-path="url(#c{i})"><use href="#mk" xlink:href="#mk"/></g>')

    # glass glint sweeping the bar (subtle, repeating)
    s.append(
        f'<g transform="skewX(-18)"><rect class="glint" x="{-W}" y="0" '
        f'width="{W}" height="{H}" fill="url(#shine)"/></g>'
    )

    # ---- CSS: settled base states, 'both' fill, reduced-motion safe ----
    css = ["<style><![CDATA["]
    css.append("image, text, g { }")
    css.append(
        ".tile { transform-box: fill-box; transform-origin: center; "
        "animation: pop .5s cubic-bezier(.2,.85,.25,1.05) .05s both; }"
    )
    css.append("@keyframes pop { from { transform: scale(.72); opacity: 0; } }")
    for delay, fx, fy, sx, sy, sw, sh, i in shards:
        css.append(
            f".s{i} {{ animation: fly{i} .62s cubic-bezier(.18,.85,.25,1) {delay:.2f}s both; }}"
        )
        css.append(
            f"@keyframes fly{i} {{ from {{ transform: translate({fx:.0f}px,{fy:.0f}px); opacity: 0; }} }}"
        )
    for i in range(len(LETTERS)):
        t0 = LETTER_T0 + i * LETTER_STAG
        css.append(
            f".lt{i} {{ animation: rise .{int(LETTER_DUR*100)}s ease-out {t0:.2f}s both; }}"
        )
    css.append(
        f".tg {{ animation: rise .6s ease-out {TAG_T0:.2f}s both; }}"
    )
    css.append("@keyframes rise { from { opacity: 0; transform: translateY(14px); } }")
    css.append(
        ".glint { animation: sweep 4.6s linear 2.6s infinite; }"
        "@keyframes sweep { 0% { transform: translateX(0); } "
        "45%, 100% { transform: translateX(2360px); } }"
    )
    css.append(
        "@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }"
    )
    css.append("]]></style>")
    s.append("\n".join(css))
    s.append("</svg>")
    return "\n".join(s)


if __name__ == "__main__":
    svg = build()
    with open(OUT, "w") as f:
        f.write(svg)
    print(f"svg bytes: {len(svg)}  → {OUT}")
