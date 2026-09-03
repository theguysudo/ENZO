import { useEffect, useRef, useState } from 'react'
import { useInView, useReducedMotion } from 'framer-motion'
import { Check, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLowPowerMode } from '@/hooks/useLowPowerMode'

/**
 * PricingSection — three tiers laid out exactly like every SaaS pricing page,
 * because that is the setup. Each Buy button routes to the 404, which is where
 * the truth lives: there is no checkout, ENZO is free, you pay your providers
 * directly. Nothing here is charged, so nothing here needs a payment flow.
 *
 * The reveal (PriceNumber below): the first time the grid scrolls into view,
 * each price gets a beat to play it straight, then a line cuts across the
 * digits and the number scrambles down to $0 — the price anyone actually
 * pays. Reduced-motion and low-power contexts skip the theater and render $0.
 *
 * Visual grammar is the flat neutral card grid, adapted to the homepage:
 * Garamond numerals and tier names, mono uppercase micro-type, the shared
 * `homepage-bento-tile` hairline (homepage-polish.css §12), and theme-aware
 * through `isLight`. The section heading lives in PlatformPricing, so this
 * renders the toggle, the grid, and the footnote only.
 */

type Tier = {
  name: string
  blurb: string
  /** [monthly, annual-equivalent] — annual is the 20% discounted monthly rate. */
  price: [string, string]
  unit: string
  featured?: boolean
  features: string[]
}

const TIERS: Tier[] = [
  {
    name: 'Starter',
    blurb: 'One machine, your keys, nothing leaving the box you own.',
    price: ['$0', '$0'],
    unit: 'forever',
    features: [
      'All nine provider gateways',
      'Full agent tool loop',
      'Keys encrypted at rest (AES-256-GCM)',
      'Community support',
    ],
  },
  {
    name: 'Pro',
    blurb: 'The tier everyone picks. It already has everything.',
    price: ['$29', '$23'],
    unit: 'per seat, per month',
    featured: true,
    features: [
      'Everything in Starter',
      'Memory that survives model switches',
      'Skills learned from public repositories',
      'Five modes — chat, thinking, research, coding, image',
      'Priority routing on provider fallback',
    ],
  },
  {
    name: 'Enterprise',
    blurb: 'Self-hosted behind your firewall, with the paperwork to match.',
    price: ['$99', '$79'],
    unit: 'per seat, per month',
    features: [
      'Everything in Pro',
      'Single binary, runs anywhere',
      'SSO and audit trail',
      'Dedicated support channel',
    ],
  },
]

/** Reveal timing — one shared trigger, cheap on purpose: a single
 * IntersectionObserver, one CSS transition per card, and a 50ms text
 * scramble. Nothing loops; the whole sequence runs once per page load. */
const REVEAL_HOLD_MS = 700    // beat the straight-faced prices get to play
const REVEAL_STAGGER_MS = 150 // left-to-right card stagger
const STRIKE_MS = 380         // time the cut line takes to cross the digits
const SCRAMBLE_FRAMES = 13
const SCRAMBLE_FRAME_MS = 50

type RevealPhase = 'priced' | 'striking' | 'retyping' | 'settled'

/**
 * PriceNumber — the pricing theater, timed. `priced` shows the tier's
 * SaaS-face number as-is. When `active` flips (grid first scrolls into view)
 * a line cuts across the digits, they scramble down, and the number settles
 * on $0. `snap` (reduced motion or low-power mode) skips straight to $0.
 */
function PriceNumber({
  price,
  active,
  snap,
  index,
  heading,
}: {
  price: string
  active: boolean
  snap: boolean
  index: number
  heading: string
}) {
  const [phase, setPhase] = useState<RevealPhase>(snap ? 'settled' : 'priced')
  const [scramble, setScramble] = useState<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (snap) {
      setPhase('settled')
      return
    }
    if (!active || startedRef.current) return
    startedRef.current = true

    let alive = true
    const timers: number[] = []
    const later = (ms: number, fn: () => void) =>
      timers.push(window.setTimeout(() => { if (alive) fn() }, ms))

    const base = REVEAL_HOLD_MS + index * REVEAL_STAGGER_MS
    later(base, () => setPhase('striking'))
    later(base + STRIKE_MS, () => {
      setPhase('retyping')
      let frame = 0
      const digits = price.replace('$', '')
      const iv = window.setInterval(() => {
        if (!alive) { clearInterval(iv); return }
        frame += 1
        if (frame >= SCRAMBLE_FRAMES) {
          clearInterval(iv)
          setScramble('$0')
          setPhase('settled')
          return
        }
        const keep = Math.max(1, Math.round(
          digits.length - (frame / SCRAMBLE_FRAMES) * (digits.length - 1),
        ))
        let out = ''
        for (let i = 0; i < keep; i++) out += String(Math.floor(Math.random() * 10))
        setScramble(`$${out}`)
      }, SCRAMBLE_FRAME_MS)
    })

    return () => {
      alive = false
      timers.forEach(clearTimeout)
    }
    // Deliberately not depending on `price`/`index`: the sequence starts at
    // most once (startedRef), and a billing toggle mid-reveal must not kill
    // running timers by re-triggering this effect's cleanup.
  }, [active, snap])

  const settled = phase === 'settled'
  const struck = phase === 'striking' || phase === 'retyping'
  const shown = settled ? '$0' : scramble ?? price

  return (
    <span
      className={cn(
        'relative inline-block transition-opacity duration-300',
        heading,
        struck ? 'opacity-60' : 'opacity-100',
      )}
    >
      <span className="font-garamond text-4xl font-normal leading-none tabular-nums">
        {shown}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute -inset-x-0.5 top-1/2 h-[1.5px] -rotate-3 rounded-full bg-current',
          'origin-left transition-all duration-[350ms] ease-out',
          struck ? 'scale-x-100 opacity-100' : 'scale-x-0 opacity-0',
          settled && 'opacity-0',
        )}
      />
    </span>
  )
}

export function PricingSection({
  isLight = false,
  onBuy,
}: {
  isLight?: boolean
  onBuy?: () => void
}) {
  const [isAnnual, setIsAnnual] = useState(true)

  // One observer on the tier grid fires the whole reveal, once, ever.
  const gridRef = useRef<HTMLDivElement>(null)
  const inView = useInView(gridRef, { once: true, amount: 0.2 })
  const snap = Boolean(useReducedMotion()) || useLowPowerMode()

  const heading = isLight ? 'text-slate-900' : 'text-white'
  const body = isLight ? 'text-slate-500' : 'text-white/[0.55]'
  const muted = isLight ? 'text-slate-400' : 'text-white/30'
  const rule = isLight ? 'bg-black/[0.07]' : 'bg-white/[0.08]'

  return (
    <div className="w-full">
      {/* Billing toggle — the punchline: both sides are zero */}
      <div className="mb-16 flex items-center justify-center gap-3">
        <span className={cn(
          'font-mono text-[10px] uppercase tracking-[0.22em]',
          !isAnnual ? heading : muted,
        )}>
          Monthly
        </span>
        <button
          type="button"
          onClick={() => setIsAnnual(!isAnnual)}
          role="switch"
          aria-checked={isAnnual}
          aria-label="Toggle billing cycle"
          className={cn(
            'relative flex h-6 w-11 cursor-pointer items-center rounded-full transition-colors',
            isLight ? 'bg-black/[0.08] hover:bg-black/[0.14]' : 'bg-white/[0.12] hover:bg-white/[0.2]',
          )}
        >
          <span
            className={cn(
              'absolute h-4 w-4 rounded-full transition-transform duration-200 ease-out',
              isLight ? 'bg-slate-900' : 'bg-white',
              isAnnual ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
        <span className={cn(
          'flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em]',
          isAnnual ? heading : muted,
        )}>
          Annually
          <span className={cn(
            'rounded-full px-2 py-0.5 text-[9px] tracking-[0.2em]',
            isLight ? 'bg-black/[0.05] text-slate-600' : 'bg-white/[0.08] text-white/70',
          )}>
            Save 20%
          </span>
        </span>
      </div>

      {/* Tier grid */}
      <div ref={gridRef} className="grid w-full grid-cols-1 gap-4 lg:grid-cols-3">
        {TIERS.map((tier, tierIndex) => (
          <div
            key={tier.name}
            className={cn(
              'homepage-bento-tile relative flex flex-col rounded-2xl border p-8 backdrop-blur-xl transition-colors',
              tier.featured
                ? isLight
                  ? 'border-black/[0.16] bg-white/[0.05] shadow-2xl'
                  : 'border-white/[0.22] bg-white/[0.04] shadow-2xl'
                : isLight
                  ? 'border-black/[0.06] bg-white/[0.03] hover:border-black/[0.14]'
                  : 'border-white/[0.06] bg-white/[0.03] hover:border-white/[0.16]',
            )}
          >
            {tier.featured && (
              <div
                aria-hidden="true"
                className={cn(
                  'absolute inset-x-8 top-0 h-px',
                  isLight ? 'bg-slate-900/50' : 'bg-white/80',
                )}
              />
            )}

            <div className="mb-6 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className={cn('font-garamond text-[23px] font-normal leading-snug', heading)}>
                  {tier.name}
                </h3>
                <p className={cn('mt-2 text-[13px] font-light leading-[1.75]', body)}>
                  {tier.blurb}
                </p>
              </div>
              {tier.featured && (
                <span className={cn(
                  'shrink-0 rounded-full px-2.5 py-1 font-mono text-[8px] uppercase tracking-[0.2em]',
                  isLight ? 'bg-slate-900 text-white' : 'bg-white text-slate-950',
                )}>
                  Most picked
                </span>
              )}
            </div>

            <div className="mb-8 flex items-baseline gap-1.5">
              <PriceNumber
                price={isAnnual ? tier.price[1] : tier.price[0]}
                active={inView}
                snap={snap}
                index={tierIndex}
                heading={heading}
              />
              <span className={cn('text-[13px] font-light', muted)}>
                / {tier.unit}{isAnnual && tier.unit.includes('month') ? ', billed annually' : ''}
              </span>
            </div>

            <button
              type="button"
              onClick={onBuy}
              className={cn(
                'mb-8 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border font-mono text-[11px] uppercase tracking-[0.2em] transition-all hover:-translate-y-0.5',
                tier.featured
                  ? isLight
                    ? 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800'
                    : 'border-white bg-white text-slate-950 hover:bg-white/90'
                  : isLight
                    ? 'border-black/12 text-slate-700 hover:border-black/25 hover:bg-black/[0.03]'
                    : 'border-white/12 text-white/85 hover:border-white/25 hover:bg-white/5',
              )}
            >
              Buy {tier.name}
              <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
            </button>

            <div className={cn('mb-6 h-px w-full', rule)} />

            <ul className="flex flex-col gap-4">
              {tier.features.map((feature) => (
                <li key={feature} className="flex items-start gap-3">
                  <Check
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 h-4 w-4 shrink-0',
                      tier.featured
                        ? isLight ? 'text-indigo-500' : 'text-indigo-300'
                        : isLight ? 'text-slate-400' : 'text-white/35',
                    )}
                  />
                  <span className={cn('text-[14px] font-light leading-snug', heading)}>
                    {feature}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Footnote — where the money actually goes */}
      <div className={cn(
        'mt-12 flex items-center justify-center gap-2.5 text-center font-mono text-[9px] uppercase tracking-[0.22em]',
        muted,
      )}>
        <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', isLight ? 'bg-slate-300' : 'bg-white/25')} />
        Overage tokens are billed at provider list price. Cancel anytime — we'll cope.
      </div>
    </div>
  )
}

export default PricingSection
