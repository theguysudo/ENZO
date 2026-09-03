import { memo, useCallback, useRef } from 'react'

/**
 * Logged-out homepage feature card ("01 · Direct Node Gateway" et al).
 *
 * Typography: the whole card is set in Playfair Display — the artistic-but-
 * formal Didone serif — with the label as engraved small caps and the intro
 * line above the grid in italic. See `.font-playfair` in index.css.
 *
 * Layout: fixed-width number rail on the left, label/title/body column
 * on the right — both columns share the card's first baseline, which reads
 * much cleaner than stacked centered blocks.
 *
 * Hover: a soft radial sheen follows the cursor. Coordinates are written
 * straight into CSS custom properties on the element (no React state, no
 * re-render per mousemove) and painted by `.homepage-feature-card` in
 * index.css (scoped under body[data-craft="home"]).
 */
export const HomepageFeatureCard = memo(function HomepageFeatureCard({
  index,
  label,
  title,
  body,
  isLight,
}: {
  index: string
  label: string
  title: string
  body: string
  isLight: boolean
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = cardRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--sheen-x', `${e.clientX - rect.left}px`)
    el.style.setProperty('--sheen-y', `${e.clientY - rect.top}px`)
  }, [])

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      className={`homepage-feature-card rounded-2xl border p-6 backdrop-blur-xl transition-[border-color,transform,background-color] duration-200 ease-out hover:-translate-y-px ${
        isLight
          ? 'border-black/[0.06] bg-black/[0.03] hover:border-black/[0.14]'
          : 'border-white/[0.06] bg-white/[0.03] hover:border-white/[0.16]'
      }`}
    >
      <div
        aria-hidden="true"
        className={`font-playfair w-9 shrink-0 pt-1.5 text-right text-[11px] tracking-[0.25em] ${
          isLight ? 'text-slate-400' : 'text-white/[0.28]'
        }`}
      >
        {index}
      </div>
      <div className="min-w-0">
        <div
          className={`font-playfair text-[10px] uppercase tracking-[0.28em] ${
            isLight ? 'text-slate-500' : 'text-white/[0.45]'
          }`}
        >
          {label}
        </div>
        <h3
          className={`font-playfair mt-3 text-[24px] font-medium leading-snug tracking-[0.01em] ${
            isLight ? 'text-slate-800' : 'text-white/[0.92]'
          }`}
        >
          {title}
        </h3>
        <p
          className={`font-playfair homepage-body mt-2.5 text-[14px] font-normal leading-[1.75] ${
            isLight ? 'text-slate-500 homepage-body-light' : 'text-white/[0.55]'
          }`}
        >
          {body}
        </p>
      </div>
    </div>
  )
})
