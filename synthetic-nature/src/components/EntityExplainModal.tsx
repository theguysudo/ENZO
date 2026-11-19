/**
 * EntityExplainModal.tsx — the "what IS this node" overlay.
 *
 * Clicking a node in the investigation graph opens this panel over the graph:
 * the model explains the node in detail from that node's own evidence, every
 * [E#] it cites is a link into the evidence ledger, and a small chat box at
 * the bottom lets the user ask follow-up doubts about the SAME node (the
 * follow-ups are answered from that node's evidence only — never from general
 * knowledge).
 *
 * The parent owns the request (it has the vault token and the provider key);
 * this component owns the presentation and the GSAP entrance/exit.
 *
 * Motion: a short backdrop fade + panel rise (GSAP), with the same
 * prefers-reduced-motion contract as the rest of the app — a reduced-motion
 * user gets the panel instantly, never a fade.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { gsap } from 'gsap'
import { X, Send, Loader2, ExternalLink, AlertTriangle } from 'lucide-react'
import { ReportBody } from './IntelligenceMarkdown'

export interface ExplainEvidence {
  id: string
  claim: string
  quote: string
  quoteVerified: boolean
  host: string
  url: string
  status: 'supported' | 'unverified' | 'disputed'
  sourceDate?: string
}

export interface ExplainEntity {
  id: string
  name: string
  kind: string
  summary?: string
  aliases?: string[]
}

export interface ExplainAnswer {
  explanation?: string
  answer?: string
  evidenceIds?: string[]
  error?: string
}

const STATUS_DOT: Record<string, string> = {
  supported: 'bg-emerald-400/80',
  unverified: 'bg-white/30',
  disputed: 'bg-[#f0968a]',
}

export default function EntityExplainModal({
  entity,
  evidence,
  ask,
  onClose,
  onJumpEvidence,
  onJumpUrl,
}: {
  entity: ExplainEntity | null
  evidence: ExplainEvidence[]
  ask: (entityId: string, question?: string) => Promise<ExplainAnswer>
  onClose: () => void
  onJumpEvidence: (id: string) => void
  onJumpUrl: (url: string) => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [explanation, setExplanation] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState(false)
  const [thread, setThread] = useState<Array<{ q: string; a: string }>>([])

  const reducedMotion = () => typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /* ── entrance + exit ─────────────────────────────────────────────────────── */

  useEffect(() => {
    const panel = panelRef.current
    const backdrop = backdropRef.current
    if (!panel || !backdrop) return
    if (reducedMotion()) {
      gsap.set(panel, { opacity: 1, y: 0, scale: 1 })
      return
    }
    const ctx = gsap.context(() => {
      gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.22, ease: 'power2.out' })
      gsap.fromTo(
        panel,
        { opacity: 0, y: 28, scale: 0.97 },
        { opacity: 1, y: 0, scale: 1, duration: 0.42, ease: 'power3.out' },
      )
    }, panel)
    return () => ctx.revert()
  }, [])

  const close = useCallback(() => {
    const panel = panelRef.current
    const backdrop = backdropRef.current
    if (!panel || !backdrop || reducedMotion()) { onClose(); return }
    gsap.timeline({ onComplete: onClose })
      .to(panel, { opacity: 0, y: 16, scale: 0.985, duration: 0.2, ease: 'power2.in' })
      .to(backdrop, { opacity: 0, duration: 0.18, ease: 'power1.in' }, '<')
  }, [onClose])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  /* ── the explanation itself ──────────────────────────────────────────────── */

  useEffect(() => {
    if (!entity) return
    let alive = true
    setLoading(true)
    setError(null)
    setThread([])
    ask(entity.id, '')
      .then((r) => {
        if (!alive) return
        if (r.error) { setError(r.error); setExplanation(''); return }
        setExplanation(r.explanation || r.answer || '')
      })
      .catch((err) => { if (alive) setError(String(err?.message ?? err)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [entity, ask])

  const askDoubt = useCallback(async () => {
    const question = draft.trim()
    if (!question || !entity || asking) return
    setDraft('')
    setAsking(true)
    try {
      const r = await ask(entity.id, question)
      if (r.error) { setError(r.error); return }
      const answer = r.answer || r.explanation || ''
      setThread((t) => [...t, { q: question, a: answer }])
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setAsking(false)
    }
  }, [ask, asking, draft, entity])

  useEffect(() => {
    if (thread.length === 0) return
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [thread])

  if (!entity) return null

  return createPortal(
    <div ref={backdropRef} className="fixed inset-0 z-[9990] overflow-hidden bg-black/70 backdrop-blur-sm">
      <div className="absolute inset-4 flex justify-center overflow-hidden">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Explain ${entity.name}`}
        className="relative flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/12 bg-[#0b0b0c]/95 shadow-[0_24px_80px_rgba(0,0,0,0.65)]"
      >
        {/* ── header ── */}
        <div className="flex shrink-0 items-start gap-4 border-b border-white/[0.07] px-5 py-4 sm:px-6 sm:py-5">
          <div className="min-w-0 flex-1">
            <div className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">
              {entity.kind} · explained from {evidence.length} claim{evidence.length === 1 ? '' : 's'}
            </div>
            <h2 className="mt-1 break-words text-xl font-medium text-white/95">{entity.name}</h2>
            {entity.aliases && entity.aliases.length > 0 && (
              <div className="mt-1 break-words font-mono text-[10px] text-white/50">also: {entity.aliases.join(', ')}</div>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            className="shrink-0 cursor-pointer rounded-full border border-white/15 p-2 text-white/60 transition-colors hover:border-white/35 hover:text-white"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,1fr)] overflow-hidden lg:grid-cols-[minmax(0,1fr)_280px] lg:grid-rows-1">
          {/* ── explanation + doubts ── */}
          <div ref={scrollRef} className="min-h-0 min-w-0 overflow-y-auto px-5 py-5 scrollbar-thin sm:px-6">
            {loading && (
              <div className="flex items-center gap-2 text-[13px] text-white/50">
                <Loader2 size={14} className="animate-spin" /> Reading the evidence ledger…
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-[#f0968a]/25 bg-[#f0968a]/[0.06] px-4 py-3 text-[13px] text-[#f0b0a6]">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {!loading && !error && explanation && (
              <div className="text-white/80">
                <ReportBody text={explanation} onCite={onJumpEvidence} onJumpUrl={onJumpUrl} />
              </div>
            )}

            {/* doubt thread */}
            {thread.length > 0 && (
              <div className="mt-6 space-y-4 border-t border-white/[0.07] pt-5">
                {thread.map((t, i) => (
                  <div key={i} className="space-y-2">
                    <div className="text-[12.5px] text-white/85">
                      <span className="mr-2 font-mono text-[10px] uppercase tracking-widest text-white/35">you</span>
                      {t.q}
                    </div>
                    <div className="border-l border-white/15 pl-3 text-[13px] leading-relaxed text-white/70">
                      <ReportBody text={t.a} onCite={onJumpEvidence} onJumpUrl={onJumpUrl} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* doubt chat box */}
            <div className="mt-6 border-t border-white/[0.07] pt-4">
              <div className="mb-2 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">
                Ask about this node
              </div>
              <form
                onSubmit={(e) => { e.preventDefault(); void askDoubt() }}
                className="flex flex-col gap-2 sm:flex-row sm:items-center"
              >
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="e.g. why is this linked to that company?"
                  className="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/40 px-4 py-2.5 text-[13px] text-white placeholder-white/25 outline-none transition-colors focus:border-white/35"
                  disabled={asking}
                />
                <button
                  type="submit"
                  disabled={asking || !draft.trim()}
                  className="inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 font-mono-display text-[10px] uppercase tracking-[0.2em] text-black transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {asking ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Ask
                </button>
              </form>
              <div className="mt-2 text-[11px] leading-relaxed text-white/35">
                Answers come from this node's own evidence — every claim is cited, and gaps are called out instead of guessed.
              </div>
            </div>
          </div>

          {/* ── evidence links ── */}
          <aside className="min-h-0 overflow-y-auto border-t border-white/[0.07] px-5 py-5 scrollbar-thin lg:border-l lg:border-t-0">
            <div className="mb-2 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">
              Supporting evidence ({evidence.length})
            </div>
            {evidence.length === 0 ? (
              <div className="text-[12px] text-white/45">No claims are attached to this node yet.</div>
            ) : (
              <div className="space-y-1.5">
                {evidence.map((ev) => (
                  <button
                    key={ev.id}
                    type="button"
                    onClick={() => onJumpEvidence(ev.id)}
                    className="block w-full cursor-pointer rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2 text-left transition-colors hover:border-white/25"
                    title={`Open ${ev.id} in the evidence ledger`}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[ev.status] ?? 'bg-white/30'}`} />
                      <span className="font-mono text-[10px] text-white/60">[{ev.id}]</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-white/45">{ev.host}</span>
                      <ExternalLink size={9} className="shrink-0 text-white/30" />
                    </span>
                    <span className="mt-1 block break-words text-[12px] leading-snug text-white/70">
                      {ev.claim.length > 150 ? `${ev.claim.slice(0, 148)}…` : ev.claim}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        </div>
      </div>
      </div>
    </div>,
    document.body,
  )
}
