import { memo, useCallback, useRef } from 'react'
import { ArrowUpRight } from 'lucide-react'

/**
 * Logged-out homepage product-showcase — art-directed like a maker's studio
 * wall, not a SaaS grid. Three surfaces, each a spread: the screenshot framed
 * like a canvas on one side, typography composed around it like a painted
 * poster — one title huge and heavy, one small and light, one with a
 * hand-written word scribbled in Caveat like a margin note from the artist.
 *
 * Crop fix: the promo shots are 1920×1003 (≈1.91:1), so the frame renders at
 * the same aspect with object-cover. The old 16:10 frame cropped ~16% off
 * the left and right of every screenshot; matching the native ratio means
 * the full-width UI in each shot survives.
 *
 * Art direction per row (font-mixing is the point — see index.css):
 *   1. Catalog  — Fraunces Black, very large, tight tracking; "one console"
 *                in italic. A Caveat annotation under the eyebrow.
 *   2. Terminal — same Fraunces Black as row 1, at full showcase scale.
 *   4. Advisor  — Fraunces SemiBold mid-size with "launch" swapped into the
 *                hand font, oversized and tilted.
 *
 * Text colours are theme-aware via `isLight`; frame chrome is scoped under
 * body[data-craft="home"] in homepage-polish.css.
 */

const TRAFFIC = ['#ff5f57', '#febc2e', '#28c840']

interface ShowcaseRow {
  img: string
  windowLabel: string
  eyebrow: string
  title: React.ReactNode
  body: string
  /** Rendered as one quiet spec line under the frame, never as bullets. */
  specs: string[]
  /** Which side the canvas sits on — alternates so the wall breathes. */
  flip?: boolean
  /** Optional hand-written annotation, painted beside the title. */
  note?: string
}

/** Split a title string around one word to render in the hand font. */
function handWord(text: string, word: string): React.ReactNode {
  const parts = text.split(word)
  if (parts.length < 2) return text
  return (
    <>
      {parts[0]}
      <span className="font-hand">{word}</span>
      {parts.slice(1).join(word)}
    </>
  )
}

const SHOWCASE_ROWS: ShowcaseRow[] = [
  {
    img: '/promo/promo-catalog.jpg',
    windowLabel: 'enzo://marketplace',
    eyebrow: 'Unified catalog',
    title: (
      <>
        Every model, <br className="hidden sm:block" />
        <span className="italic">one console</span>
      </>
    ),
    body: 'Browse the live provider catalog — OpenRouter, Groq, Pollinations, HuggingFace and more — as one routable surface. Tailor the feed by task, provider, or price so the right model is always in reach.',
    specs: ['Live model health dots', 'Task / provider filters', 'One-click handoff to the terminal'],
    note: 'pick a model, any model',
  },
  {
    img: '/promo/promo-terminal.jpg',
    windowLabel: 'enzo://terminal',
    eyebrow: 'Agentic terminal',
    title: <>think · research · build</>,
    body: 'An operator console with a cognitive mode per intent. Stream reasoning chains over SSE, toggle web search, incognito or auto-fallback, and let the agent keep working when a route fails.',
    specs: ['Normal / thinking / research / coding', 'Live reasoning & SSE token streams', 'Auto fallback across providers'],
    flip: true,
  },
  {
    img: '/promo/promo-advisor.jpg',
    windowLabel: 'enzo://advisor',
    eyebrow: 'Catalog AI advisor',
    title: handWord('Ask which model to launch', 'launch'),
    body: 'Not sure what to run? Ask the advisor. It reads the live catalog and your query in context, then recommends the exact model — with a launch button that hands it straight off to your terminal.',
    specs: ['Context-aware recommendation', 'Multi-turn follow-ups', 'Instant launch handoff'],
    note: 'picks for you',
  },
]

function ShowcaseMedia({ row, isLight }: { row: ShowcaseRow; isLight: boolean }) {
  const frameRef = useRef<HTMLDivElement>(null)

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = frameRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.setProperty('--showcase-sheen-x', `${e.clientX - rect.left}px`)
    el.style.setProperty('--showcase-sheen-y', `${e.clientY - rect.top}px`)
  }, [])

  return (
    <div
      ref={frameRef}
      onMouseMove={handleMouseMove}
      className={`homepage-showcase-frame relative overflow-hidden rounded-2xl ${
        isLight
          ? 'bg-white/[0.5]'
          : 'bg-white/[0.04]'
      }`}
    >
      {/* Window chrome */}
      <div className={`homepage-showcase-bar flex items-center gap-2 px-4 py-3 ${
        isLight ? 'text-black/35' : 'text-white/25'
      }`}>
        <span className="flex gap-1.5" aria-hidden="true">
          {TRAFFIC.map((c) => (
            <i key={c} className="h-2.5 w-2.5 rounded-full opacity-80" style={{ background: c }} />
          ))}
        </span>
        <span className="ml-2 font-mono text-[9px] uppercase tracking-[0.22em]">
          {row.windowLabel}
        </span>
      </div>

      {/* Product screenshot at the shots' native ≈1.91:1 — the old 16:10
          window cropped ~16% off both sides of every promo image. The img is
          absolutely positioned so the parallax drift slides it inside the
          window; scale is kept to 1.09 (see HomepageScrollAnimations) so the
          drift never exposes the frame's edges. */}
      <div
        className={`homepage-showcase-shot relative overflow-hidden aspect-[1.91/1] ${
          isLight ? 'border-t border-black/[0.06]' : 'border-t border-white/[0.08]'
        }`}
      >
        <img
          src={row.img}
          alt="ENZO screenshot"
          loading="lazy"
          decoding="async"
          data-parallax="0.04"
          data-parallax-scale="1.09"
          className="absolute inset-0 h-full w-full select-none object-cover"
          draggable={false}
        />
        {/* Floor fade so the shot melts into the page */}
        <div className="homepage-showcase-fade pointer-events-none absolute inset-x-0 bottom-0 h-16" aria-hidden="true" />
      </div>
    </div>
  )
}

export const HomepageFeatureShowcase = memo(function HomepageFeatureShowcase({
  isLight,
  onAccess,
}: {
  isLight: boolean
  /** Same destination as the hero's "Sign up" CTA. */
  onAccess: () => void
}) {
  return (
    <section
      id="showcase"
      data-section="showcase"
      data-gsap-reveal
      className="homepage-showcase w-full max-w-6xl px-6 py-28"
      aria-labelledby="showcase-title"
    >
      {/* Statement block */}
      <div id="showcase-statement" className="mx-auto max-w-2xl text-center">
        <div className={`inline-flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.3em] ${
          isLight ? 'text-slate-500' : 'text-white/[0.45]'
        }`}>
          <span className={`tracking-[0.3em] ${isLight ? 'text-slate-400' : 'text-white/[0.28]'}`}>
            02
          </span>
          <span
            aria-hidden="true"
            className={`h-px w-6 shrink-0 ${isLight ? 'bg-black/15' : 'bg-white/15'}`}
          />
          The full intelligence stack
        </div>
        <h2 id="showcase-title" data-gsap-words className={`mt-5 font-garamond text-4xl sm:text-5xl font-normal text-white ${
          isLight ? '!text-slate-900' : ''
        }`}>
          One console to route every model, carry every key
        </h2>
        <p className={`homepage-just mx-auto mt-5 max-w-xl text-[15px] font-light leading-[1.7] ${
          isLight ? 'text-slate-500' : 'text-white/[0.55]'
        }`}>
          ENZO is the command center for teams who want frontier models without frontier lock-in.
          One catalog across nine gateways, one agentic terminal, one vault — running on your keys,
          on your machine, at provider cost.
        </p>
      </div>

      {/* Studio wall — each surface a spread: canvas on one side, painted
          poster typography on the other. Rows alternate sides. */}
      <div data-gsap-stagger className="mt-20 space-y-24 sm:space-y-32">
        {SHOWCASE_ROWS.map((row) => (
          <div
            key={row.img}
            className={`grid items-center gap-10 md:grid-cols-2 md:gap-16 ${row.flip ? 'md:[direction:rtl]' : ''}`}
          >
            {/* Media — direction:rtl on the flipped row swaps visual order
                without touching DOM order (a11y/reading order preserved). */}
            <div className="min-w-0 md:[direction:ltr]">
              <ShowcaseMedia row={row} isLight={isLight} />
            </div>

            {/* Copy — the poster */}
            <div className="min-w-0 md:[direction:ltr]">
              <div className={`font-mono text-[10px] uppercase tracking-[0.3em] ${
                isLight ? 'text-slate-500' : 'text-white/[0.45]'
              }`}>
                {row.eyebrow}
              </div>

              <h3 className={`mt-4 font-fraunces text-[2.6rem] font-black leading-[1.02] tracking-tight ${
                isLight ? 'text-slate-900' : 'text-white/[0.92]'
              }`}>
                {row.title}
              </h3>

              {row.note && (
                <p className={`font-hand mt-3 text-[1.35rem] leading-none ${
                  isLight ? 'text-sky-700/80' : 'text-cyan-300/70'
                }`}>
                  {row.note}
                </p>
              )}

              <p className={`mt-5 max-w-md text-[14px] font-light leading-[1.75] ${
                isLight ? 'text-slate-500' : 'text-white/[0.55]'
              }`}>
                {row.body}
              </p>

              {/* Spec line — one quiet mono row, the caption under the canvas */}
              <div className={`mt-6 font-mono text-[10px] uppercase tracking-[0.22em] ${
                isLight ? 'text-slate-500' : 'text-white/[0.42]'
              }`}>
                {row.specs.join('  ·  ')}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom CTA */}
      <div className="mt-24 text-center">
        <button
          type="button"
          onClick={onAccess}
          className={`group inline-flex items-center gap-2 rounded-full border px-7 py-3 font-mono text-[11px] uppercase tracking-[0.2em] transition-all hover:-translate-y-0.5 ${
            isLight
              ? 'border-black/12 text-slate-700 hover:border-black/25 hover:bg-black/[0.03]'
              : 'border-white/12 text-white/85 hover:border-white/25 hover:bg-white/5'
          }`}
        >
          Sign up
          <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </button>
      </div>
    </section>
  )
})
