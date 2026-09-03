import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown } from 'lucide-react'

interface ResearchProgressProps {
  steps: string[]
  children?: React.ReactNode
}

/**
 * "Researching…" phase indicator — the distinct line shown WHILE the AI is
 * gathering sources. Just a single status line in the same style and size as a
 * normal AI reply, with a liquid "water flowing through it" effect (a bright
 * white current sweeps through the glyphs left→right). A small glass chevron
 * next to the text drops a liquid-glass panel listing how the AI is navigating.
 */
export const ResearchProgress: React.FC<ResearchProgressProps> = ({ steps, children }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'searching' | 'synthesizing'>('searching')
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [phraseIdx, setPhraseIdx] = useState(0)

  const SEARCH_PHRASES = [
    'working on it…',
    'fixing things up…',
    'connecting the dots…',
    'hunting for sources…',
    'squeezing the web…',
    'thinking in circles…',
  ]
  const SYNTH_PHRASES = ['synthesizing the findings…', 'writing the report…', 'typing it all up…']
  const phrases = phase === 'searching' ? SEARCH_PHRASES : SYNTH_PHRASES

  useEffect(() => {
    const t = window.setInterval(() => setPhraseIdx((i) => i + 1), 2400)
    return () => window.clearInterval(t)
  }, [])

  // Detect when the model begins writing (report streaming) → synthesizing phase.
  useEffect(() => {
    if (!children) return
    setPhase('synthesizing')
  }, [children])

  // Auto-follow the navigation ledger.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [steps, ledgerOpen])

  const statusText = phrases[phraseIdx % phrases.length]

  return (
    <div className="w-full select-none">
      {/* Status line — vertically aligned with the AI avatar (mt-1 matches the caller's avatar offset) */}
      <div className="flex items-center gap-2 mt-1">
        <motion.span
          key={statusText}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="inline-block text-white text-[14px] leading-[1.7] font-sans tracking-[-0.01em] rp-water"
        >
          {statusText}
        </motion.span>

        {/* Small glass chevron → drops the navigation panel */}
        <button
          type="button"
          onClick={() => setLedgerOpen((v) => !v)}
          aria-expanded={ledgerOpen}
          aria-label={ledgerOpen ? 'Hide AI navigation' : 'Show how the AI is navigating'}
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.06] backdrop-blur-sm text-white/60 transition-colors cursor-pointer hover:bg-white/[0.12] hover:text-white"
        >
          <motion.span
            animate={{ rotate: ledgerOpen ? 90 : 0 }}
            transition={{ duration: 0.18 }}
            className="flex items-center"
          >
            <ChevronDown size={11} strokeWidth={2.5} />
          </motion.span>
        </button>
      </div>

      {/* Live navigation panel — liquid glass, matching the terminal theme */}
      <AnimatePresence>
        {ledgerOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div
              ref={scrollRef}
              className="mt-2 max-h-[180px] overflow-y-auto scrollbar-thin rounded-2xl border border-white/[0.09] bg-white/[0.04] backdrop-blur-xl px-3 py-2.5 space-y-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.06)]"
            >
              {steps.length === 0 && (
                <div className="flex items-center gap-2 text-[11px] font-mono text-white/60">
Initializing research vector…
                </div>
              )}
              {steps.map((step, idx) => {
                const isSource = step.startsWith('🔍') && step.includes('\n')
                const [headLine, urlLine] = isSource ? step.split('\n', 2) : [step, '']
                const isLast = idx === steps.length - 1
                return (
                  <div key={idx} className="flex items-start gap-2 text-[11px] font-mono leading-relaxed">
                    <span className={`mt-[2px] shrink-0 ${isLast ? 'text-emerald-400' : 'text-emerald-500/50'}`}>
                      {isLast ? '▸' : '✓'}
                    </span>
                    <span className={`break-all whitespace-pre-wrap ${isLast ? 'text-white/70' : 'text-white/45'}`}>
                      {headLine}
                      {isSource && urlLine && (
                        <div className="ml-4 text-[10px] text-white/25 truncate">{urlLine}</div>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Streamed report draft */}
      {children && (
        <div className="mt-2">
          {children}
        </div>
      )}

      <style>{`
        /* Water flowing through the text, left → right.
           White liquid: one bright white current sweeps through the glyphs
           on a soft silver standing pool, slowly. */
        .rp-water {
          display: inline-block;
          background-image:
            linear-gradient(90deg,
              transparent 0%,
              rgba(255,255,255,0.25) 14%,
              rgba(255,255,255,1) 30%,
              rgba(224,236,255,0.75) 48%,
              rgba(255,255,255,0.45) 62%,
              transparent 80%),
            linear-gradient(180deg,
              rgba(255,255,255,0.72) 0%,
              rgba(255,255,255,0.88) 45%,
              rgba(255,255,255,1) 78%,
              rgba(222,228,240,1) 100%);
          background-size: 250% 100%, 100% 100%;
          background-repeat: no-repeat;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          -webkit-text-fill-color: transparent;
          text-shadow:
            0 0 14px rgba(255,255,255,0.28),
            0 0 3px rgba(255,255,255,0.2),
            0 1px 2px rgba(0,0,0,0.6);
          animation: rp-flow 4.5s linear infinite;
        }
        @keyframes rp-flow {
          0%   { background-position: 120% 0, 0 0; }
          100% { background-position: -130% 0, 0 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .rp-water { animation: none; background-position: 0% 0, 0 0; }
        }
      `}</style>
    </div>
  )
}