import { memo } from 'react'

/**
 * Film grain overlay — an SVG turbulence noise tile shimmered via CSS
 * keyframes (`.film-grain` in styles/homepage-polish.css).
 *
 * Rendered as a fixed, pointer-events-free layer. The SVG data-URI noise is
 * generated inline so no asset file or network fetch is needed. The tile is
 * 240×240 and `image-rendering: pixelated` avoids smearing while it shifts.
 *
 * Opacity is kept extremely low (~0.035, 0.9 dark / 0.55 light) and blended
 * with `mix-blend-mode: overlay` so it reads as analog texture, not static.
 */
function FilmGrain({ tone = 'overlay' as 'overlay' | 'soft-light' }) {
  const NOISE_URI =
    'url("data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">' +
        '<filter id="n">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="2" stitchTiles="stitch"/>' +
        '<feColorMatrix type="saturate" values="0"/>' +
        '</filter>' +
        '<rect width="240" height="240" filter="url(#n)" opacity="0.9"/>' +
        '</svg>',
    ) +
    '")'

  return (
    <div
      aria-hidden="true"
      className="film-grain"
      style={{
        position: 'fixed',
        inset: '-32px',
        zIndex: 5,
        pointerEvents: 'none',
        backgroundImage: NOISE_URI,
        backgroundRepeat: 'repeat',
        backgroundSize: '240px 240px',
        mixBlendMode: tone,
        opacity: 0.035,
        imageRendering: 'pixelated',
      }}
    />
  )
}

export default memo(FilmGrain)
