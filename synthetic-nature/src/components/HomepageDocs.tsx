import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Terminal } from 'lucide-react'
import { DOC_SECTIONS, type DocBlock, type DocSection } from '../content/docs'

/**
 * HomepageDocs — renders content/docs.ts. Pure presentation: this file holds no
 * documentation text, and docs.ts holds no markup. Adding a section means
 * editing docs.ts only.
 *
 * Visual grammar matches the rest of the logged-out homepage: mono eyebrow with
 * wide tracking, Garamond display heading, glass surfaces, theme-aware through
 * `isLight` (see HomepagePlatform.tsx, homepage-polish.css §12).
 *
 * Layout: sticky sidebar table of contents + one long scrolling content pane, so
 * browser find-in-page works across the whole document. Every section is
 * deep-linkable as `#docs/<section id>`; the hash is rewritten on TOC click and
 * read on mount, which is what makes a pasted link land in the right place.
 *
 * ponytail: window scroll and an IntersectionObserver for the active TOC item —
 * no scroll library, no router. `**bold**` is the only inline markup, split in
 * `RichText`. If docs ever need inline links or images, that is the point to add
 * a real inline parser; a bold-splitter is not the thing to grow.
 */

// ─── Inline emphasis ────────────────────────────────────────────────────────

/** Splits on `**` and emphasises odd segments. Even segments are plain text. */
function RichText({ text, isLight }: { text: string; isLight: boolean }) {
  const parts = text.split('**')
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <strong key={i} className={`font-medium ${isLight ? 'text-slate-900' : 'text-white/95'}`}>
            {part}
          </strong>
        ) : (
          part
        )
      )}
    </>
  )
}

// ─── Block renderer ─────────────────────────────────────────────────────────

function Block({ block, isLight }: { block: DocBlock; isLight: boolean }) {
  const body = isLight ? 'text-slate-600' : 'text-white/60'

  switch (block.kind) {
    case 'h':
      return (
        <h3
          className={`mt-10 font-garamond text-2xl font-normal ${
            isLight ? 'text-slate-900' : 'text-white/90'
          }`}
        >
          {block.text}
        </h3>
      )

    case 'p':
      return (
        <p className={`mt-4 text-[15px] leading-[1.75] ${body}`}>
          <RichText text={block.text} isLight={isLight} />
        </p>
      )

    case 'ul':
      return (
        <ul className="mt-5 space-y-3">
          {block.items.map((item, i) => (
            <li key={i} className={`flex gap-3 text-[15px] leading-[1.7] ${body}`}>
              <span
                aria-hidden
                className={`mt-[9px] h-1 w-1 shrink-0 rounded-full ${
                  isLight ? 'bg-indigo-500/50' : 'bg-indigo-300/40'
                }`}
              />
              <span>
                <RichText text={item} isLight={isLight} />
              </span>
            </li>
          ))}
        </ul>
      )

    case 'steps':
      return (
        <ol className="mt-6 space-y-5">
          {block.items.map((step, i) => (
            <li key={i} className="flex gap-4">
              <span
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${
                  isLight
                    ? 'border-black/[0.08] bg-white/60 text-slate-500'
                    : 'border-white/[0.09] bg-white/[0.04] text-white/50'
                }`}
              >
                {i + 1}
              </span>
              <span>
                <span className={`block text-[15px] font-medium ${isLight ? 'text-slate-900' : 'text-white/90'}`}>
                  {step.title}
                </span>
                <span className={`mt-1.5 block text-[15px] leading-[1.7] ${body}`}>
                  <RichText text={step.text} isLight={isLight} />
                </span>
              </span>
            </li>
          ))}
        </ol>
      )

    case 'code':
      return (
        <pre
          className={`mt-5 overflow-x-auto rounded-xl border p-4 font-mono text-[12px] leading-[1.7] ${
            isLight
              ? 'border-black/[0.07] bg-slate-900/[0.04] text-slate-700'
              : 'border-white/[0.06] bg-black/30 text-white/65'
          }`}
        >
          <code>{block.lines.join('\n')}</code>
        </pre>
      )

    case 'note':
      return (
        <div
          className={`mt-6 rounded-xl border-l-2 py-3 pl-4 pr-4 text-[14px] leading-[1.7] ${
            isLight
              ? 'border-l-indigo-400/60 bg-indigo-500/[0.04] text-slate-600'
              : 'border-l-indigo-300/40 bg-indigo-300/[0.04] text-white/60'
          }`}
        >
          <RichText text={block.text} isLight={isLight} />
        </div>
      )

    case 'dev':
      // Technical detail, clearly fenced off. A non-technical reader stops at the
      // label; a developer scrolls straight to it. Same prose, no duplication.
      //
      // These explain how the product WORKS. They deliberately carry no
      // clone-and-run or local-setup instructions — see the rule at the top of
      // docs.ts for why.
      return (
        <div
          className={`mt-8 rounded-2xl border p-6 backdrop-blur-xl ${
            isLight ? 'border-black/[0.07] bg-white/40' : 'border-white/[0.06] bg-white/[0.02]'
          }`}
        >
          <div
            className={`flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] ${
              isLight ? 'text-indigo-500/80' : 'text-indigo-300/55'
            }`}
          >
            <Terminal className="h-3 w-3" aria-hidden />
            {block.label ?? 'Technical detail'}
          </div>
          <div className="-mt-1">
            {block.blocks.map((inner, i) => (
              <Block key={i} block={inner} isLight={isLight} />
            ))}
          </div>
        </div>
      )
  }
  // No default: the switch above is exhaustive over DocBlock, so adding a block
  // kind to docs.ts without a renderer for it is a type error, not a blank space.
}

// ─── Section ────────────────────────────────────────────────────────────────

const Section = memo(function Section({ section, isLight }: { section: DocSection; isLight: boolean }) {
  return (
    <section
      id={`doc-${section.id}`}
      data-doc-section={section.id}
      // Fixed nav is ~72px tall; without this an anchor jump hides the heading
      // behind it. CSS does the offset so no scroll maths is needed in JS.
      className="scroll-mt-32 pb-20 pt-4"
      aria-labelledby={`doc-${section.id}-title`}
    >
      <div className={`font-mono text-[10px] uppercase tracking-[0.3em] ${
        isLight ? 'text-indigo-500/80' : 'text-indigo-300/60'
      }`}>
        {section.eyebrow}
      </div>
      <h2
        id={`doc-${section.id}-title`}
        className={`mt-4 font-garamond text-3xl font-normal sm:text-4xl ${
          isLight ? 'text-slate-900' : 'text-white'
        }`}
      >
        {section.title}
      </h2>
      <p className={`mt-3 text-[15px] italic ${isLight ? 'text-slate-500' : 'text-white/40'}`}>
        {section.blurb}
      </p>
      <div className={`mt-8 border-t ${isLight ? 'border-black/[0.07]' : 'border-white/[0.07]'}`} />
      {section.blocks.map((block, i) => (
        <Block key={i} block={block} isLight={isLight} />
      ))}
    </section>
  )
})

// ─── Page ───────────────────────────────────────────────────────────────────

export interface HomepageDocsProps {
  isLight: boolean
  /** Returns to the homepage. Owns clearing the `#docs` hash. */
  onBack: () => void
  /** Scroll depth past the intro masthead, 0 → 1. Drives the dim overlay. */
  onScrollDepth?: (depth: number) => void
}

export const HomepageDocs = memo(function HomepageDocs({ isLight, onBack, onScrollDepth }: HomepageDocsProps) {
  const ids = useMemo(() => DOC_SECTIONS.map((s) => s.id), [])
  const [activeId, setActiveId] = useState(ids[0])

  // Deep link on mount: `#docs/security` → scroll to that section.
  //
  // `behavior: 'instant'` is load-bearing, and it has to be `instant` rather than
  // `auto`: homepage-polish.css §8 sets `scroll-behavior: smooth` on any crafted
  // surface, and per spec `auto` DEFERS to that CSS value rather than overriding
  // it — only `instant` forces no animation. Without it a pasted link animates
  // thousands of pixels down the page instead of landing on it. Smooth is right
  // for a TOC click (see jumpTo), not for arrival.
  //
  // Jumped twice, on purpose. The position at commit time is provisional — every
  // section's offset moves once the Garamond/mono webfonts swap in, and on a
  // 15,000px document that error is hundreds of pixels. `document.fonts.ready`
  // is the native signal for "text metrics are final"; if the fonts are already
  // cached it resolves immediately and the second jump is a no-op.
  //
  // Deliberately NOT wrapped in requestAnimationFrame. rAF is suspended while the
  // document is hidden, so in a tab opened in the background — cmd-click, "open in
  // new tab", a restored session — the callback never runs and the deep link
  // silently lands at the top. Nothing here needs a frame anyway: effects run after
  // React has committed the DOM, and scrollIntoView forces layout itself.
  //
  // No "already jumped" ref guard: `ids` is a stable memo, so this runs exactly
  // once per mount on its own — and a ref that survives StrictMode's remount
  // would let the throwaway first mount consume the jump while the real one skips
  // it, which makes deep links work in production but silently not in dev.
  useEffect(() => {
    const wanted = window.location.hash.split('/')[1]
    if (!wanted || !ids.includes(wanted)) return
    setActiveId(wanted)
    const jump = () =>
      document.getElementById(`doc-${wanted}`)?.scrollIntoView({ block: 'start', behavior: 'instant' })
    jump()
    document.fonts?.ready.then(jump)
  }, [ids])

  // Active TOC item + scroll depth. Picks the topmost section intersecting the
  // upper third of the viewport, which tracks reading position better than
  // "first visible". A scroll listener derives the dim-overlay depth from the
  // masthead's own travel: 0 at the top of the page, 1 once the "How ENZO
  // works" intro has scrolled clear off the top — i.e. the dim ramps in exactly
  // as the reader leaves the masthead and the documentation proper begins.
  //
  // Measured against the masthead's DOCUMENT position, not the viewport: an
  // earlier version compared rect.bottom to 66% of the viewport height, which
  // read 0.58 at scrollY 0 because the masthead is shorter than that on a
  // laptop, so the page loaded already half-dimmed.
  const introRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sections = ids.map((id) => document.getElementById(`doc-${id}`))
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        const id = visible?.target.getAttribute('data-doc-section')
        if (id) setActiveId(id)
      },
      { rootMargin: '-96px 0px -66% 0px' }
    )
    for (const el of sections) {
      if (el) io.observe(el)
    }

    // A scroll listener, not the observer above: an IntersectionObserver only
    // fires on threshold crossings, so it stops reporting once the masthead is
    // fully off-screen and the depth would freeze mid-ramp.
    const onScroll = () => {
      if (!onScrollDepth || !introRef.current) return
      const introBottomDoc = introRef.current.getBoundingClientRect().bottom + window.scrollY
      const progress = introBottomDoc > 0 ? Math.min(1, window.scrollY / introBottomDoc) : 1
      onScrollDepth(Math.max(0, progress))
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      io.disconnect()
      window.removeEventListener('scroll', onScroll)
    }
  }, [ids, onScrollDepth])

  const jumpTo = (id: string) => {
    setActiveId(id)
    // replaceState, not a hash assignment: the hash change would fire the app's
    // own hash listener and re-run routing for a scroll that already happened.
    window.history.replaceState(null, '', `#docs/${id}`)
    document.getElementById(`doc-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div
      data-section="homepage-docs"
      className="w-full max-w-6xl px-6 pb-24 pt-28"
      aria-label="Documentation"
    >
      {/* ── Masthead ── */}
      <div ref={introRef} className="text-center">
        <div className={`font-mono text-[10px] uppercase tracking-[0.3em] ${
          isLight ? 'text-indigo-500/80' : 'text-indigo-300/60'
        }`}>
          Documentation · Written for humans
        </div>
        <h1 className={`mt-5 font-garamond text-4xl font-normal sm:text-5xl ${
          isLight ? 'text-slate-900' : 'text-white'
        }`}>
          How ENZO works
        </h1>
        <p className={`mx-auto mt-5 max-w-2xl text-[15px] leading-[1.75] ${
          isLight ? 'text-slate-600' : 'text-white/55'
        }`}>
          Everything from your first key to the security model, in plain language.
          Each section starts with the plain explanation; the technical detail sits
          in a marked block below it, so read as far as you need and stop.
        </p>
        <button
          type="button"
          onClick={onBack}
          className={`mt-8 inline-flex items-center gap-2 rounded-full border px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] transition-all duration-300 ${
            isLight
              ? 'border-black/[0.12] text-slate-600 hover:border-black/25 hover:bg-black/[0.03]'
              : 'border-white/12 text-white/60 hover:border-white/25 hover:bg-white/5'
          }`}
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          Back to homepage
        </button>
      </div>

      <div className="mt-20 flex w-full gap-12">
        {/* ── Sidebar TOC ── */}
        <nav
          className="hidden w-56 shrink-0 lg:block"
          aria-label="Documentation sections"
        >
          <div className="sticky top-28">
            <div className={`font-mono text-[9px] uppercase tracking-[0.28em] ${
              isLight ? 'text-slate-400' : 'text-white/30'
            }`}>
              Contents
            </div>
            <ul className="mt-4 space-y-0.5">
              {DOC_SECTIONS.map((s) => {
                const active = s.id === activeId
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => jumpTo(s.id)}
                      aria-current={active ? 'true' : undefined}
                      className={`w-full border-l-2 py-1.5 pl-3 text-left text-[13px] leading-snug transition-all duration-200 ${
                        active
                          ? isLight
                            ? 'border-l-indigo-500/70 text-slate-900'
                            : 'border-l-indigo-300/70 text-white'
                          : isLight
                            ? 'border-l-black/[0.07] text-slate-500 hover:border-l-black/20 hover:text-slate-800'
                            : 'border-l-white/[0.07] text-white/45 hover:border-l-white/20 hover:text-white/80'
                      }`}
                    >
                      {s.title}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </nav>

        {/* ── Content ── */}
        <div className="min-w-0 flex-1">
          {/* Mobile contents — the sidebar is hidden below lg, and a nine-section
              document with no map is unusable on a phone. */}
          <div className="mb-14 lg:hidden">
            <div className={`font-mono text-[9px] uppercase tracking-[0.28em] ${
              isLight ? 'text-slate-400' : 'text-white/30'
            }`}>
              Contents
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {DOC_SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => jumpTo(s.id)}
                  className={`rounded-full border px-3 py-1 text-[11px] transition-colors ${
                    isLight
                      ? 'border-black/[0.08] bg-white/50 text-slate-600 hover:border-black/20'
                      : 'border-white/[0.09] bg-white/[0.04] text-white/55 hover:border-white/20'
                  }`}
                >
                  {s.title}
                </button>
              ))}
            </div>
          </div>

          {DOC_SECTIONS.map((s) => (
            <Section key={s.id} section={s} isLight={isLight} />
          ))}

          <div className={`border-t pt-8 ${isLight ? 'border-black/[0.07]' : 'border-white/[0.07]'}`}>
            <p className={`text-[13px] leading-relaxed ${isLight ? 'text-slate-500' : 'text-white/35'}`}>
              Something here wrong, missing, or out of date? Tell us and it gets
              fixed — these pages are written by hand and every claim on them is
              meant to be checkable against what the product actually does.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
})
