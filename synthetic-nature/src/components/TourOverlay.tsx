// ─── TourOverlay — an interactive guided tour of the workspace ──────────────────
//
// Unlike a static text overlay, this tour *interacts* with the workspace: it
// switches the nav tabs (Marketplace → Terminal → Vault), finds the real DOM
// element for the current step, and spots a circular highlight over it with a
// callout tooltip anchored beside it. The user sees the actual UI, not a
// description of it.

import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { motion } from 'framer-motion'
import * as keyVault from '../lib/keyVault'

export interface TourStep {
  id: 'welcome' | 'marketplace' | 'terminal' | 'vault' | 'done' | 'nav' | 'marketplace-search' | 'vault-save'
  title: string
  body: string
  icon: string
  /** Target tab to switch to when this step activates. */
  targetTab?: 'marketplace' | 'terminal' | 'vault'
  /** data-tour-step attribute of the element to spotlight (omitted for modal steps). */
  selector?: string
  /** Where to anchor the tooltip relative to the target element. */
  anchor?: 'top' | 'bottom' | 'left' | 'right'
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to ENZO',
    body: 'You\'re in. In the next few steps we\'ll point at the real controls so you know exactly where everything lives. You can skip any time.',
    icon: '★',
  },
  {
    id: 'nav',
    title: 'The three workspaces',
    body: 'Everything lives behind these three tabs. Marketplace is where you pick a model, Terminal is where you chat with it, and Vault is where your keys are kept safe on this device.',
    icon: 'NAV',
    targetTab: 'marketplace',
    selector: 'nav-marketplace',
    anchor: 'bottom',
  },
  {
    id: 'marketplace-search',
    title: 'Find your model',
    body: 'Search by name or filter by provider and task. The list updates live as you type, so the model you want is always a few keystrokes away.',
    icon: 'SRCH',
    targetTab: 'marketplace',
    selector: 'marketplace-search',
    anchor: 'bottom',
  },
  {
    id: 'marketplace',
    title: 'Pick a model',
    body: 'We\'ve highlighted the first model card so you can see what a selection looks like. Click any card to set it as your active model for the Terminal — the green dot means it\'s live and ready.',
    icon: 'MP',
    targetTab: 'marketplace',
    selector: 'model-card',
    anchor: 'bottom',
  },
  {
    id: 'terminal',
    title: 'Terminal',
    body: 'This is where you talk to your model. Type a prompt in this box and hit Enter — responses stream back token by token. Drag and drop files to attach them.',
    icon: 'TR',
    targetTab: 'terminal',
    selector: 'terminal-input',
    anchor: 'top',
  },
  {
    id: 'vault',
    title: 'Vault',
    body: 'Your API keys live here, sealed with AES-256-GCM on this device. They go out only to the ENZO backend you run and the provider it calls — never to any third party. Pick a provider and paste its key in this field.',
    icon: 'VAULT',
    targetTab: 'vault',
    selector: 'vault-key-input',
    anchor: 'top',
  },
  {
    id: 'vault-save',
    title: 'Save Lockbox',
    body: 'When the key is in, hit "Save Lockbox" to encrypt it and persist it locally. You can add as many providers as you like — they all show up here.',
    icon: 'LOCK',
    targetTab: 'vault',
    selector: 'vault-save',
    anchor: 'top',
  },
  {
    id: 'done',
    title: 'You\'re all set',
    body: 'That\'s the workspace: Marketplace to pick, Terminal to chat, Vault to manage keys. Hit any tab above to start, or open Docs from the footer.',
    icon: 'GO',
  },
]

interface TourOverlayProps {
  onComplete: () => void
  onStepTab?: (tab: 'marketplace' | 'terminal' | 'vault') => void
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export function TourOverlay({ onComplete, onStepTab }: TourOverlayProps) {
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [dontShowAgain, setDontShowAgain] = useState(() =>
    Boolean(keyVault.getItem('enzo.tour.dont-show-again'))
  )
  const panelRef = useRef<HTMLDivElement>(null)

  const cur = TOUR_STEPS[step]

  const onDontShowChange = (checked: boolean) => {
    if (checked) keyVault.setItem('enzo.tour.dont-show-again', '1')
    else keyVault.removeItem('enzo.tour.dont-show-again')
    setDontShowAgain(checked)
  }

  const measure = () => {
    if (!cur.selector) {
      setRect(null)
      return
    }
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-tour-step="${cur.selector}"]`
      )
      if (!el) {
        setRect(null)
        return
      }
      const r = el.getBoundingClientRect()
      const pad = 8
      setRect({
        top: r.top - pad,
        left: r.left - pad,
        width: r.width + pad * 2,
        height: r.height + pad * 2,
      })
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  useEffect(() => {
    if (cur.targetTab && onStepTab) onStepTab(cur.targetTab)
    const t = setTimeout(measure, cur.targetTab ? 120 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  useEffect(() => {
    const onResize = () => measure()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  useLayoutEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [step, rect])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') onComplete()
      else if (e.key === ' ') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  function goNext() {
    if (step < TOUR_STEPS.length - 1) setStep(step + 1)
    else onComplete()
  }

  function goBack() {
    if (step > 0) setStep(step - 1)
  }

  // ponytail: smart anchor — flip left↔right and top↔bottom when the tooltip
  // would overflow the viewport. Panel is ~360px wide, ~320px tall.
  const PANEL_W = 360
  const PANEL_H = 320
  const GAP = 16

  const tooltipStyle: React.CSSProperties = rect
    ? (() => {
        const a = cur.anchor
        const spaceRight = window.innerWidth - (rect.left + rect.width)
        const spaceBelow = window.innerHeight - (rect.top + rect.height)
        const spaceLeft = rect.left

        // vertical: if anchor is 'bottom' but not enough room below, flip to above
        const above = a === 'top' || (a === 'bottom' && spaceBelow < PANEL_H)

        // horizontal: if anchor is 'left' but not enough room on the right, flip to left
        const placeRight = a === 'left' && spaceRight < PANEL_W
        // if anchor is 'right' but not enough room on the left, flip to right
        const placeLeft = a === 'right' && spaceLeft < PANEL_W

        if (placeRight) {
          return {
            top: above ? Math.max(12, rect.top) : rect.top + rect.height + GAP,
            right: window.innerWidth - rect.left - rect.width - GAP,
          }
        }
        if (placeLeft) {
          return {
            top: above ? Math.max(12, rect.top) : rect.top + rect.height + GAP,
            left: rect.left - PANEL_W - GAP,
          }
        }
        if (above) {
          return {
            top: Math.max(12, rect.top - GAP),
            left: rect.left,
            transform: 'translateY(-100%)',
          }
        }
        return { top: rect.top + rect.height + GAP, left: rect.left }
      })()
    : {}

  return (
    <div className="fixed inset-0 z-[60]">
      {rect ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="pointer-events-none absolute rounded-2xl"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.72)',
            border: '1.5px solid rgba(255,255,255,0.5)',
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/72" />
      )}

      <motion.div
        ref={panelRef}
        key={step}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className={`absolute z-[61] w-[min(92vw,22rem)] rounded-3xl border border-white/10 bg-black/80 p-6 shadow-[0_0_60px_rggba(0,0,0,0.8)] backdrop-blur-xl ${
          rect ? '' : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2'
        }`}
        style={rect ? tooltipStyle : undefined}
      >
        <button
          onClick={onComplete}
          className="absolute top-4 right-4 font-mono-display text-[10px] uppercase tracking-widest text-white/40 hover:text-white/80 transition-colors"
          aria-label="Skip tour"
        >
          Skip
        </button>

        <div className="mb-5 flex items-center justify-center gap-1.5">
          {TOUR_STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 w-1.5 rounded-full transition-all duration-300 ${
                i < step ? 'bg-green-400/80' : i === step ? 'bg-white w-6' : 'bg-white/15'
              }`}
            />
          ))}
        </div>

        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 border border-white/10">
            <span className="font-mono-display text-[9px] font-bold text-white/70">
              {cur.icon}
            </span>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono-display text-xs uppercase tracking-widest text-white">
                {cur.title}
              </span>
              <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-white/50">
                {step + 1} / {TOUR_STEPS.length}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-white/55 font-light leading-relaxed">
              {cur.body}
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 font-mono-display text-[9px] uppercase tracking-wider text-white/40">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => onDontShowChange(e.target.checked)}
              className="h-3.5 w-3.5 rounded border border-white/20 bg-white/5 text-white/80 focus:outline-none focus:ring-1 focus:ring-white/40"
            />
            Don't show again
          </label>
          <div className="flex gap-1.5">
            <button
              onClick={goBack}
              disabled={step === 0}
              className="rounded-xl border border-white/10 px-3.5 py-2 font-mono-display text-xs uppercase tracking-widest text-white/35 transition-all hover:border-white/20 hover:text-white/70 disabled:opacity-35"
            >
              ← Back
            </button>
            <button
              onClick={goNext}
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 font-mono-display text-xs uppercase tracking-widest text-white/80 transition-all hover:bg-white/10"
            >
              {step < TOUR_STEPS.length - 1 ? 'Next →' : 'Done'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
