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
W, H = 860, 190
TILE = 96
RX = 22
TILE_Y = 45
LOCKUP_W = TILE + 40 + 246          # tile + gap + measured glyph block
X0 = (W - LOCKUP_W) // 2           # centered lockup start
TILE_X = X0
MARK = 84
MX, MY = TILE_X + 6, TILE_Y + 6     # mark origin inside tile
BASELINE = 113
TAG_Y = BASELINE + 28
LETTERS = ["E", "N", "Z", "O"]
LCOLS = ["#ffffff", "#ffffff", "#ffffff", "#ffffff"]
TAGLINE = "the AI workspace with no middleman"

# hand-drawn loop around the lockup — path lifted verbatim from KokonutUI's
# HandWrittenTitle (1200x600 stage) and affine-mapped onto the banner
CIRC_RAW = [
    ("M", [(950, 90)]),
    ("C", [(1250, 300), (1050, 480), (600, 520)]),
    ("C", [(250, 520), (150, 480), (150, 300)]),
    ("C", [(150, 120), (350, 80), (600, 80)]),
    ("C", [(850, 80), (950, 180), (950, 180)]),
]
CIRC_SRC_CX, CIRC_SRC_CY = 600, 300
CIRC_RX, CIRC_RY = 280, 80          # target half-extents around the lockup

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


def circ_path():
    """Map the KokonutUI 1200x600 loop onto the banner lockup.

    The source loop's drawn extents differ from its control-point bbox (the
    right bulge never reaches its x=1250 control), so flatten the beziers by
    sampling and normalize against the SAMPLED bbox — the drawn loop then
    lands symmetric around the lockup on both axes.
    """
    pts = []          # on-curve + sampled points, for true extents
    cur = None        # current on-curve point
    segs = []         # (p0, c1, c2, p2) cubics
    for cmd, seg in CIRC_RAW:
        if cmd == "M":
            cur = seg[0]
            pts.append(cur)
        else:
            c1, c2, p2 = seg
            segs.append((cur, c1, c2, p2))
            cur = p2
    for p0, c1, c2, p2 in segs:
        for i in range(33):
            t = i / 32
            u = 1 - t
            x = u**3*p0[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t**3*p2[0]
            y = u**3*p0[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t**3*p2[1]
            pts.append((x, y))
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    sx_lo, sx_hi, sy_lo, sy_hi = min(xs), max(xs), min(ys), max(ys)
    lockup_cx = (TILE_X + TILE_X + TILE + 40 + 246) / 2
    lockup_cy = TILE_Y + TILE / 2
    def map_pt(x, y):
        nx = (x - (sx_lo + sx_hi) / 2) / ((sx_hi - sx_lo) / 2)
        ny = (y - (sy_lo + sy_hi) / 2) / ((sy_hi - sy_lo) / 2)
        return lockup_cx + nx * CIRC_RX, lockup_cy + ny * CIRC_RY
    d = []
    for cmd, seg in CIRC_RAW:
        mapped = [map_pt(x, y) for x, y in seg]
        if cmd == "M":
            d.append(f"M {mapped[0][0]:.1f} {mapped[0][1]:.1f}")
        else:
            d.append("C " + " ".join(f"{mx:.1f},{my:.1f}" for mx, my in mapped))
    return " ".join(d)


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

    s.append(f'<rect width="{W}" height="{H}" rx="18" fill="#000000"/>')
    s.append(
        f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="18" '
        f'fill="none" stroke="#30363d" stroke-width="1"/>'
    )

    # hand-drawn loop sketching itself around the lockup (KokonotUI motion)
    s.append(
        f'<path class="circ" d="{circ_path()}" pathLength="1" fill="none" '
        f'stroke="#ffffff" stroke-width="6" stroke-linecap="round" '
        f'stroke-linejoin="round"/>'
    )

    # wordmark letters
    for i, ch in enumerate(LETTERS):
        x = TILE_X + TILE + 40 + i * 62
        s.append(
            f'<text class="lt lt{i}" x="{x}" y="{BASELINE}" '
            f'style="font:800 76px -apple-system,\'Segoe UI\',sans-serif;letter-spacing:2px" '
            f'fill="{LCOLS[i]}">{ch}</text>'
        )
    tag_x = TILE_X + TILE + 40 + 246 / 2
    s.append(
        f'<text class="tg" x="{tag_x:.1f}" y="{TAG_Y}" '
        f'text-anchor="middle" '
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
        ".circ { animation: draw 2.5s cubic-bezier(.43,.13,.23,.96) 2.5s both; }"
    )
    css.append(
        "@keyframes draw { from { stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0; } "
        "18% { opacity: .9; } to { stroke-dasharray: 1; stroke-dashoffset: 0; opacity: .9; } }"
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
