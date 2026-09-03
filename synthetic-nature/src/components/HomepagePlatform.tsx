import { memo, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { HomepageReveal } from './HomepageReveal'
import {
  ArrowUpRight,
  Activity,
  Check,
  Github,
  Heart,
  ShieldCheck,
} from 'lucide-react'

/**
 * Logged-out homepage platform sections — the "this is a product, not a
 * weekend repo" half of the landing page.
 *
 * Everything stated here is verifiable in the codebase, deliberately: the
 * gateway list is App.tsx's `providers`, the tool list is agent-tools.ts, the
 * mode list is TerminalSection's ChatMode, the resync interval is
 * model-sync.ts's SYNC_INTERVAL_MS. No invented customers, logos, or metrics.
 *
 * Visual grammar matches the existing homepage: mono eyebrow with wide
 * tracking, Garamond display heading, glass surfaces with a masked gradient
 * hairline (see homepage-polish.css §12). Theme-aware through `isLight`.
 */

// ─── Shared bits ────────────────────────────────────────────────────────────

/**
 * Section eyebrow with an optional spec-sheet index ("01" … "10") — a dim
 * mono number, a short hairline tick, then the label. inline-flex so it
 * still centers inside text-center parents and sits flush on left-aligned
 * ones; no layout below it moves.
 */
function Eyebrow({
  children,
  isLight,
  index,
}: {
  children: React.ReactNode
  isLight: boolean
  index?: string
}) {
  return (
    <div className={`inline-flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.3em] ${
      isLight ? 'text-slate-500' : 'text-white/[0.45]'
    }`}>
      {index && (
        <>
          <span className={`tracking-[0.3em] ${
            isLight ? 'text-slate-400' : 'text-white/[0.28]'
          }`}>
            {index}
          </span>
          <span
            aria-hidden="true"
            className={`h-px w-6 shrink-0 ${isLight ? 'bg-black/15' : 'bg-white/15'}`}
          />
        </>
      )}
      {children}
    </div>
  )
}

function SectionHeading({ children, isLight }: { children: React.ReactNode; isLight: boolean }) {
  return (
    <h2 className={`mt-5 font-garamond text-4xl sm:text-5xl font-normal ${
      isLight ? 'text-slate-900' : 'text-white'
    }`}>
      {children}
    </h2>
  )
}

// ─── 1 · Proof band — gateways routed + verifiable counters ─────────────────

const GATEWAYS = [
  'Groq',
  'OpenRouter',
  'NVIDIA NIM',
  'Hugging Face',
  'Google AI',
  'Cloudflare Workers AI',
  'Pollinations',
  'LLM7',
  'Puter',
]

const COUNTERS = [
  { target: 9, unit: 'gateways', note: 'Provider endpoints routable from one console' },
  { target: 9, unit: 'agent tools', note: 'Search, research, mail, calendar, documents' },
  { target: 5, unit: 'cognitive modes', note: 'Normal, thinking, research, coding, image' },
  { target: 0, unit: 'keys on our servers', note: 'Credentials stay in your browser, always' },
]

/** Animate a number from 0 up to `target` over `duration` ms. Fires once on mount. */
function useCountUp(target: number, duration = 1400): number {
  const [n, setN] = useState(0)
  const raf = useRef<number | null>(null)
  useEffect(() => {
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min((now - start) / duration, 1)
      setN(Math.round(target * t))
      if (t < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [target, duration])
  return n
}

export const PlatformProof = memo(function PlatformProof({ isLight }: { isLight: boolean }) {
  return (
    <HomepageReveal
      as="section"
      data-section="platform-proof"
      data-gsap-reveal
      className="homepage-proof w-full max-w-6xl px-6 pb-4 pt-10"
      aria-label="Platform reach"
    >
      {/* Gateway marks — section index 01 of the spec sheet */}
      <div className="text-center">
        <span className={`inline-flex items-center gap-3 font-mono text-[9px] uppercase tracking-[0.32em] ${
          isLight ? 'text-slate-400' : 'text-white/30'
        }`}>
          <span className={isLight ? 'text-slate-300' : 'text-white/[0.22]'}>
            01
          </span>
          <span
            aria-hidden="true"
            className={`h-px w-5 shrink-0 ${isLight ? 'bg-black/15' : 'bg-white/15'}`}
          />
          Routing live across
        </span>
      </div>

      <div className="homepage-gateway-rail mt-6 flex flex-wrap items-center justify-center gap-x-7 gap-y-3" data-parallax="0.04">
        {GATEWAYS.map((g) => (
          <span
            key={g}
            className={`font-mono-display text-[12px] uppercase tracking-[0.18em] transition-colors ${
              isLight
                ? 'text-slate-500 hover:text-slate-800'
                : 'text-white/40 hover:text-white/75'
            }`}
          >
            {g}
          </span>
        ))}
      </div>

      {/* Counters */}
      <div data-gsap-stagger className={`mt-14 grid grid-cols-2 gap-y-10 border-t pt-12 md:grid-cols-4 ${
        isLight ? 'border-black/[0.07]' : 'border-white/[0.07]'
      }`}>
        {COUNTERS.map((c) => {
          const value = useCountUp(c.target)
          return (
          <div key={c.unit} className="px-2 text-center">
            <div className={`font-garamond text-5xl font-normal leading-none ${
              isLight ? 'text-slate-900' : 'text-white'
            }`}>
              {value}
            </div>
            <div className={`mt-3 font-mono text-[9px] uppercase tracking-[0.24em] ${
              isLight ? 'text-slate-500' : 'text-white/[0.45]'
            }`}>
              {c.unit}
            </div>
            <p className={`mx-auto mt-2.5 max-w-[15rem] text-[12px] font-light leading-[1.6] ${
              isLight ? 'text-slate-500' : 'text-white/40'
            }`}>
              {c.note}
            </p>
          </div>
          )
        })}
      </div>
    </HomepageReveal>
  )
})

// ─── 2 · Capability bento ───────────────────────────────────────────────────

interface PaneLine {
  text: string
  /** Emerald "ok" accent — used once per pane, for the line that proves the
   *  claim (a delivered result, a stored key, a resynced catalog). */
  ok?: boolean
}

interface Capability {
  /** Console path, e.g. `enzo://router` — doubles as the tile's label. */
  path: string
  title: string
  body: string
  /** Mono micro-still: 2–3 lines of real runtime behaviour the pane "types". */
  lines: PaneLine[]
  chips?: string[]
  wide?: boolean
}

const CAPABILITIES: Capability[] = [
  {
    path: 'enzo://runtime',
    title: 'Agents that actually reach into your work',
    body: 'The terminal ships a native tool loop, not a chat box with a search button. The model decides when to call, the backend executes against your own credentials, and every call streams back into the transcript as a visible step.',
    lines: [
      { text: '→ web_search("groq rate limits today")' },
      { text: '← 10 results · 0.9 s · streamed' },
      { text: '✓ visible in transcript', ok: true },
    ],
    chips: [
      'web_search',
      'deep_research',
      'gmail_list',
      'gmail_send',
      'calendar_list',
      'calendar_create',
      'recommend_model',
      'compare_models',
      'document_assist',
    ],
    wide: true,
  },
  {
    path: 'enzo://modes',
    title: 'Five cognitive modes',
    body: 'Switch the posture of the run, not just the prompt. Each mode carries its own system framing, tool permissions, and streaming layout.',
    lines: [
      { text: 'normal · thinking · research ·' },
      { text: 'coding · image' },
      { text: '✓ framing + tools switch together', ok: true },
    ],
  },
  {
    path: 'enzo://catalog',
    title: 'Live model resync',
    body: 'The catalog re-syncs every six hours and caches to disk, carrying live per-provider status, context length, and input pricing — so what you see is what you can actually route to.',
    lines: [
      { text: 'resync every 6 h · cached to disk' },
      { text: 'status · context · input pricing' },
      { text: '✓ per route', ok: true },
    ],
  },
  {
    path: 'enzo://router',
    title: 'Auto-fallback routing',
    body: 'When a gateway rate-limits, drops tool support, or returns a malformed stream, the run re-lands on the next viable route instead of dying in front of you.',
    lines: [
      { text: 'groq → 429 rate limit' },
      { text: '→ openrouter · delivered', ok: true },
    ],
  },
  {
    path: 'enzo://vault',
    title: 'Browser-bound key vault',
    body: 'Bring your own developer tokens for all nine gateways. They are cached in your browser, masked in the UI, testable in place, and never synced, logged, or written to a server.',
    lines: [
      { text: 'OPENROUTER_KEY = sk-········7f2a' },
      { text: 'local · masked · testable' },
    ],
  },
  {
    path: 'enzo://themes',
    title: 'Cinematic theme engine',
    body: 'Live video and WebGL environments, a per-surface theme rail, and a lite mode that swaps the whole ambient layer for a static frame on low-power machines.',
    lines: [
      { text: 'video · webgl · rail · lite' },
      { text: '✓ lite swaps ambient for static', ok: true },
    ],
  },
]

const TRAFFIC = ['#ff5f57', '#febc2e', '#28c840']

function CapabilityTile({ cap, isLight, position }: { cap: Capability; isLight: boolean; position: number }) {
  return (
    <div
      className={`homepage-bento-tile relative flex flex-col rounded-2xl border backdrop-blur-xl transition-[border-color,transform] duration-200 ease-out hover:-translate-y-px ${
        cap.wide ? 'md:col-span-2' : ''
      } ${
        isLight
          ? 'border-black/[0.06] bg-black/[0.03] hover:border-black/[0.14]'
          : 'border-white/[0.06] bg-white/[0.03] hover:border-white/[0.16]'
      }`}
    >
      {/* Pane chrome: traffic dots + the console path this capability lives
          at, index flush right. Reads as a window into the real product. */}
      <div className={`flex items-center gap-2 border-b px-5 py-3 ${
        isLight ? 'border-black/[0.06]' : 'border-white/[0.07]'
      }`}>
        <span className="flex gap-1.5" aria-hidden="true">
          {TRAFFIC.map((c) => (
            <i key={c} className="h-2 w-2 rounded-full opacity-80" style={{ background: c }} />
          ))}
        </span>
        <span className={`ml-2 truncate font-mono text-[10px] tracking-[0.18em] ${
          isLight ? 'text-slate-500' : 'text-white/[0.45]'
        }`}>
          {cap.path}
        </span>
        <span className={`ml-auto shrink-0 font-mono text-[9px] tracking-[0.3em] ${
          isLight ? 'text-slate-300' : 'text-white/[0.22]'
        }`}>
          {String(position).padStart(2, '0')}
        </span>
      </div>

      {/* Pane body: a mono micro-still of the behaviour the tile claims —
          transcript arrows and real values, so the copy is shown, not told. */}
      <div className={`border-b px-5 py-4 font-mono text-[10.5px] leading-[1.9] ${
        isLight
          ? 'border-black/[0.06] text-slate-500'
          : 'border-white/[0.07] text-white/[0.42]'
      }`}>
        {cap.lines.map((line) => (
          <div
            key={line.text}
            className={line.ok ? (isLight ? 'text-emerald-600' : 'text-emerald-300/80') : undefined}
          >
            {line.text}
          </div>
        ))}
      </div>

      <div className="flex flex-1 flex-col p-7">
        <h3 className={`font-garamond text-[23px] font-normal leading-snug ${
          isLight ? 'text-slate-900' : 'text-white/[0.92]'
        }`}>
          {cap.title}
        </h3>

        <p className={`mt-3 max-w-xl text-[13px] font-light leading-[1.75] ${
          isLight ? 'text-slate-500' : 'text-white/[0.52]'
        }`}>
          {cap.body}
        </p>

        {cap.chips && (
          <div className="mt-6 flex flex-wrap gap-2">
            {cap.chips.map((chip) => (
              <span
                key={chip}
                className={`rounded-md border px-2.5 py-1 font-mono text-[10px] tracking-[0.08em] ${
                  isLight
                    ? 'border-black/[0.08] bg-white/50 text-slate-600'
                    : 'border-white/[0.09] bg-white/[0.04] text-white/60'
                }`}
              >
                {chip}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export const PlatformCapabilities = memo(function PlatformCapabilities({ isLight }: { isLight: boolean }) {
  return (
    <HomepageReveal
      as="section"
      id="capabilities"
      data-section="platform-capabilities"
      data-gsap-reveal
      className="cv-auto w-full max-w-6xl px-6 py-28"
      aria-labelledby="capabilities-title"
    >
      <div className="mx-auto max-w-2xl text-center">
        <Eyebrow isLight={isLight} index="03">Platform capabilities</Eyebrow>
        <h2 id="capabilities-title" data-gsap-words className={`mt-5 font-garamond text-4xl sm:text-5xl font-normal ${
          isLight ? 'text-slate-900' : 'text-white'
        }`}>
          Built like infrastructure, not like a wrapper
        </h2>
        <p className={`homepage-just mx-auto mt-5 max-w-xl text-[15px] font-light leading-[1.7] ${
          isLight ? 'text-slate-500' : 'text-white/[0.55]'
        }`}>
          Nine gateways, a real tool-calling loop, and a routing layer that keeps working when a
          provider does not. Every capability below runs on your keys, from your machine.
        </p>
      </div>

      <div className="mt-16 grid gap-5 md:grid-cols-2" data-gsap-stagger>
        {CAPABILITIES.map((cap, i) => (
          <CapabilityTile key={cap.title} cap={cap} isLight={isLight} position={i + 1} />
        ))}
      </div>
    </HomepageReveal>
  )
})

// ─── 3 · Security posture ───────────────────────────────────────────────────

const POSTURE = [
  {
    title: 'Keys stay on your machine',
    body: 'Provider tokens are held in local storage on the machine that entered them and proxied to providers by the Express backend you run. There is no key sync service, no third-party copy, and no telemetry path that could carry one.',
  },
  {
    title: 'Your own compute path',
    body: 'Requests are proxied by the Express backend you run, straight to the provider endpoint. Nothing is relayed through a shared multi-tenant inference layer.',
  },
  {
    title: 'Session auth, scoped',
    body: 'Sign-in issues a signed JWT for the session only. Google scopes for mail and calendar are requested at the moment a tool needs them, not up front.',
  },
  {
    title: 'Incognito runs',
    body: 'Any conversation can be run without persistence. Nothing is written to the session store, and the transcript dies with the tab.',
  },
]

export const PlatformSecurity = memo(function PlatformSecurity({ isLight }: { isLight: boolean }) {
  return (
    <HomepageReveal
      as="section"
      id="security"
      data-section="platform-security"
      data-gsap-reveal
      className="cv-auto w-full max-w-6xl px-6 py-28"
      aria-labelledby="security-title"
    >
      <div className="grid gap-14 md:grid-cols-[0.85fr_1fr] md:gap-20">
        <div>
          <Eyebrow isLight={isLight} index="06">Trust architecture</Eyebrow>
          <h2 id="security-title" data-gsap-words className={`mt-5 font-garamond text-4xl font-normal leading-tight ${
            isLight ? 'text-slate-900' : 'text-white'
          }`}>
            The safest place for a key is the one you never handed over
          </h2>
          <p className={`homepage-just mt-5 max-w-md text-[15px] font-light leading-[1.7] ${
            isLight ? 'text-slate-500' : 'text-white/[0.55]'
          }`}>
            Most AI consoles ask you to trust a vault you cannot inspect. ENZO removes the ask:
            the credential, the compute path, and the transcript all stay on infrastructure you
            already control.
          </p>

          <div className={`mt-8 inline-flex items-center gap-2.5 rounded-full border px-4 py-2 ${
            isLight ? 'border-emerald-600/25 bg-emerald-500/5' : 'border-emerald-300/20 bg-emerald-400/5'
          }`}>
            <ShieldCheck size={13} strokeWidth={1.9} className={isLight ? 'text-emerald-700' : 'text-emerald-300/85'} aria-hidden="true" />
            <span className={`font-mono text-[9px] uppercase tracking-[0.22em] ${
              isLight ? 'text-emerald-800' : 'text-emerald-200/80'
            }`}>
              Zero server-side key retention
            </span>
          </div>
        </div>

        <ul data-gsap-stagger className={`divide-y ${isLight ? 'divide-black/[0.07]' : 'divide-white/[0.07]'}`}>
          {POSTURE.map((p) => (
            <li key={p.title} className="flex gap-4 py-6 first:pt-0 last:pb-0">
              <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${
                isLight ? 'bg-black/[0.06] text-slate-600' : 'bg-white/[0.07] text-white/60'
              }`}>
                <Check size={11} strokeWidth={3} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 className={`text-[14px] font-normal ${isLight ? 'text-slate-800' : 'text-white/[0.88]'}`}>
                  {p.title}
                </h3>
                <p className={`mt-1.5 text-[13px] font-light leading-[1.7] ${
                  isLight ? 'text-slate-500' : 'text-white/[0.48]'
                }`}>
                  {p.body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </HomepageReveal>
  )
})

// ─── 4 · FAQ (native <details> — no accordion state to get wrong) ──────────

const FAQ = [
  {
    q: 'What exactly am I running?',
    a: 'A console and an Express routing backend. You sign in, add the provider keys you already have, and ENZO turns them into one catalog, one terminal, and one tool-calling agent loop across nine gateways.',
  },
  {
    q: 'Do you see my keys or my conversations?',
    a: 'No. Keys live in your browser’s local storage and are attached to requests your own backend makes. Conversations are stored in the session store you configure, and any run can be executed in incognito so nothing is written at all.',
  },
  {
    q: 'What does it cost to run a model?',
    a: 'Exactly what your provider charges you. There is no wrapper margin, no per-seat licence, and no token resale — the catalog surfaces each route’s real input pricing so you can pick on cost as well as capability.',
  },
  {
    q: 'What happens when a provider fails mid-run?',
    a: 'The router catches rate limits, unsupported tool-calling, and malformed streams, then re-lands the request on the next viable route. You see the fallback happen in the stream rather than losing the turn.',
  },
  {
    q: 'Which models can the agent tools use?',
    a: 'Any route that supports native tool calling. Mail, calendar, search, research, and document tools execute through the same loop, and the agent runs on the model and provider you selected — not a hidden default.',
  },
  {
    q: 'Can it run on a low-powered machine?',
    a: 'Yes. Lite mode replaces the live video and WebGL ambience with a static frame, and the console itself is a standard React build with no local inference requirement.',
  },
]

export const PlatformFAQ = memo(function PlatformFAQ({ isLight }: { isLight: boolean }) {
  return (
    <HomepageReveal
      as="section"
      id="faq"
      data-section="platform-faq"
      data-gsap-reveal
      className="cv-auto w-full max-w-4xl px-6 py-28"
      aria-labelledby="faq-title"
    >
      <div className="text-center">
        <Eyebrow isLight={isLight} index="07">Straight answers</Eyebrow>
        <SectionHeading isLight={isLight}>Questions worth asking first</SectionHeading>
      </div>

      <div data-gsap-stagger className={`mt-14 border-t ${isLight ? 'border-black/[0.07]' : 'border-white/[0.07]'}`}>
        {FAQ.map((item) => (
          <details
            key={item.q}
            className={`homepage-faq-item group border-b ${
              isLight ? 'border-black/[0.07]' : 'border-white/[0.07]'
            }`}
          >
            <summary className={`flex cursor-pointer list-none items-center gap-4 py-5 text-[15px] font-light transition-colors ${
              isLight ? 'text-slate-700 hover:text-slate-950' : 'text-white/75 hover:text-white'
            }`}>
              <span className="min-w-0 flex-1">{item.q}</span>
              <span
                aria-hidden="true"
                className={`homepage-faq-mark shrink-0 font-mono text-[15px] leading-none ${
                  isLight ? 'text-slate-400' : 'text-white/[0.35]'
                }`}
              >
                +
              </span>
            </summary>
            <p className={`homepage-just max-w-2xl pb-6 pr-8 text-[13.5px] font-light leading-[1.8] ${
              isLight ? 'text-slate-500' : 'text-white/[0.5]'
            }`}>
              {item.a}
            </p>
          </details>
        ))}
      </div>
    </HomepageReveal>
  )
})

// ─── 4.5 · SATIRICAL PRICING ─────────────────────────────────────────────────
// A pricing page that follows every SaaS convention — three named tiers, real
// numbers, a billing toggle, a "most picked" badge — and keeps a straight face
// until you press Buy. The reveal is the 404 it lands on (#404,
// ui/ghost-404-page.tsx): there is no checkout, because there is nothing to
// charge for. Do not spoil it in the heading; the click is the joke.

// We import here so the pricing page is a self-contained module — the main
// bundle only pulls it in when the section scrolls into view.
const LazyPricing = lazy(() => import('./ui/pricing-section'))

export const PlatformPricing = memo(function PlatformPricing({
  isLight,
  onBuy,
}: {
  isLight: boolean
  onBuy?: () => void
}) {
  return (
    <HomepageReveal
      as="section"
      id="pricing"
      data-section="platform-pricing"
      data-gsap-reveal
      className="w-full max-w-6xl px-6 py-28"
      aria-labelledby="pricing-title"
    >
      <div className="text-center">
        <Eyebrow isLight={isLight} index="08">Transparent pricing</Eyebrow>
        <SectionHeading isLight={isLight}>Plans that scale with the work</SectionHeading>
        <p className={`homepage-just mx-auto mt-5 max-w-xl text-[15px] font-light leading-[1.7] ${
          isLight ? 'text-slate-500' : 'text-white/[0.55]'
        }`}>
          Three tiers, one terminal. Pick a plan and press Buy — we dare you.
        </p>
      </div>

      <div className="mt-16">
        <Suspense fallback={<div className={`py-12 text-center font-mono text-[9px] uppercase tracking-[0.22em] ${isLight ? 'text-slate-400' : 'text-white/30'}`}>Loading pricing…</div>}>
          <LazyPricing isLight={isLight} onBuy={onBuy} />
        </Suspense>
      </div>
    </HomepageReveal>
  )
})

// ─── 5 · Closing CTA ────────────────────────────────────────────────────────

export const PlatformClosing = memo(function PlatformClosing({
  isLight,
  onAccess,
  onTour,
}: {
  isLight: boolean
  onAccess: () => void
  onTour: () => void
}) {
  return (
    <HomepageReveal
      as="section"
      data-section="platform-closing"
      data-gsap-reveal
      className="cv-auto w-full max-w-4xl px-6 py-32 text-center"
      aria-labelledby="closing-title"
    >
      <Eyebrow isLight={isLight} index="09">Bring your own keys</Eyebrow>
      <h2 id="closing-title" data-gsap-words className={`mx-auto mt-6 max-w-2xl font-garamond text-4xl sm:text-[3.4rem] font-normal leading-[1.05] ${
        isLight ? 'text-slate-900' : 'text-white'
      }`}>
        Your models, your keys, your machine
      </h2>
      <p className={`homepage-just mx-auto mt-6 max-w-lg text-[15px] font-light leading-[1.75] ${
        isLight ? 'text-slate-500' : 'text-white/[0.55]'
      }`}>
        Add one provider token and the catalog, terminal, and agent tools come online
        together — one console, wired to your own accounts.
      </p>

      <div className="mt-11 flex flex-wrap items-center justify-center gap-4">
        <button
          type="button"
          onClick={onAccess}
          className={`group inline-flex items-center gap-2 rounded-full px-8 py-3.5 font-mono text-[11px] uppercase tracking-[0.2em] transition-all hover:-translate-y-0.5 ${
            isLight
              ? 'bg-slate-900 text-white hover:bg-slate-800'
              : 'bg-white text-slate-950 hover:bg-white/90'
          }`}
        >
          Sign up
          <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </button>
        <button
          type="button"
          onClick={onTour}
          className={`inline-flex items-center gap-2 rounded-full border px-7 py-3.5 font-mono text-[11px] uppercase tracking-[0.2em] transition-all hover:-translate-y-0.5 ${
            isLight
              ? 'border-black/12 text-slate-700 hover:border-black/25 hover:bg-black/[0.03]'
              : 'border-white/12 text-white/85 hover:border-white/25 hover:bg-white/5'
          }`}
        >
          Take the tour
        </button>
      </div>

      <div className={`mt-9 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[9px] uppercase tracking-[0.22em] ${
        isLight ? 'text-slate-400' : 'text-white/30'
      }`}>
        <span className="inline-flex items-center gap-2">
          <Activity size={10} strokeWidth={2} aria-hidden="true" /> No wrapper margin
        </span>
        <span>Keys stay local</span>
        <span>Self-hosted</span>
      </div>
    </HomepageReveal>
  )
})

// ─── 6 · Thank-you rail — open-source work this project leaned on ───────────

/**
 * Credits, not endorsements. Each `blurb` is the repository's own published
 * description, copied rather than paraphrased, so nothing here claims a
 * relationship or an outcome that does not exist. Adding an entry is one line;
 * the rail resizes itself and the marquee distance is derived from content
 * width (see homepage-polish.css §15), so no measurement has to be updated.
 */
const THANKS = [
  {
    owner: 'ComposioHQ',
    repo: 'awesome-claude-skills',
    blurb: 'A curated list of awesome Claude Skills, resources, and tools for customizing Claude AI workflows.',
  },
  {
    owner: '12britz',
    repo: 'awesome-free-models',
    blurb: 'A curated list of free AI models, APIs, and tools you can use without paying a cent.',
  },
  {
    owner: 'nextlevelbuilder',
    repo: 'ui-ux-pro-max-skill',
    blurb: 'An AI skill that provides design intelligence for building professional UI/UX across multiple platforms.',
  },
  {
    owner: 'DietrichGebert',
    repo: 'ponytail',
    blurb: 'Makes your AI agent think like the laziest senior dev in the room. The best code is the code you never wrote.',
  },
  {
    owner: 'alirezarezvani',
    repo: 'claude-skills',
    blurb: 'A collection of Claude Code skills, agents, and commands spanning engineering, product, research, and business work.',
  },
]

function ThanksCard({
  entry,
  isLight,
  clone,
}: {
  entry: (typeof THANKS)[number]
  isLight: boolean
  /** Second copy of the track: hidden from assistive tech and skipped by Tab,
   *  because it is the same five links rendered twice to close the loop. */
  clone?: boolean
}) {
  return (
    <a
      href={`https://github.com/${entry.owner}/${entry.repo}`}
      target="_blank"
      rel="noreferrer noopener"
      tabIndex={clone ? -1 : undefined}
      className={`group mr-5 flex w-[19rem] shrink-0 flex-col rounded-2xl border p-5 backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 ${
        isLight
          ? 'border-black/[0.07] bg-white/50 hover:border-black/20'
          : 'border-white/[0.06] bg-white/[0.03] hover:border-white/20'
      }`}
    >
      <div className={`flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.22em] ${
        isLight ? 'text-slate-400' : 'text-white/30'
      }`}>
        <Github size={11} strokeWidth={1.75} aria-hidden="true" />
        {entry.owner}
        <ArrowUpRight
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          className="ml-auto opacity-0 transition-opacity group-hover:opacity-70"
        />
      </div>
      <div className={`mt-2.5 font-garamond text-[1.35rem] font-normal leading-tight ${
        isLight ? 'text-slate-900' : 'text-white/90'
      }`}>
        {entry.repo}
      </div>
      <p className={`mt-2.5 text-[12.5px] font-light leading-[1.65] ${
        isLight ? 'text-slate-600' : 'text-white/45'
      }`}>
        {entry.blurb}
      </p>
    </a>
  )
}

export const PlatformThanks = memo(function PlatformThanks({ isLight }: { isLight: boolean }) {
  return (
    <HomepageReveal
      as="section"
      data-section="platform-thanks"
      data-gsap-reveal
      className="cv-auto w-full py-24"
      aria-labelledby="thanks-title"
    >
      <div className="mx-auto max-w-6xl px-6 text-center">
        <Eyebrow isLight={isLight} index="10">
          <span className="inline-flex items-center gap-2">
            <Heart size={10} strokeWidth={2} aria-hidden="true" /> Thank you
          </span>
        </Eyebrow>
        <h2 id="thanks-title" data-gsap-words className={`mx-auto mt-5 max-w-2xl font-garamond text-3xl font-normal sm:text-4xl ${
          isLight ? 'text-slate-900' : 'text-white'
        }`}>
          Open work that made this quicker to build
        </h2>
        <p className={`mx-auto mt-5 max-w-xl text-[14.5px] font-light leading-[1.75] ${
          isLight ? 'text-slate-500' : 'text-white/[0.45]'
        }`}>
          Repositories and the people behind them whose published work we read, learned
          from, or built on while making ENZO. Every card links to the original.
        </p>
      </div>

      {/* Full-bleed rail. `overflow-hidden` is what keeps the doubled track from
          widening the page; the edge fade and the motion live in CSS.

          The card spacing is a right MARGIN on the card, not `gap` on the track,
          and that is load-bearing: it makes one copy of the list exactly half the
          track's width, so the CSS can loop on a flat `translateX(-50%)` with no
          measurement and no seam. With `gap` the two halves are separated by one
          extra gap that belongs to neither, and -50% lands mid-card. */}
      <div className="thanks-rail mt-12 w-full overflow-hidden">
        <div className="thanks-track flex">
          {THANKS.map((e) => (
            <ThanksCard key={e.repo} entry={e} isLight={isLight} />
          ))}
          <div className="flex" aria-hidden="true">
            {THANKS.map((e) => (
              <ThanksCard key={`${e.repo}-clone`} entry={e} isLight={isLight} clone />
            ))}
          </div>
        </div>
      </div>
    </HomepageReveal>
  )
})

// ─── 7 · Footer ─────────────────────────────────────────────────────────────

/** `target: 'access'` routes to the sign-in flow; anything else is a section id. */
const FOOTER_COLUMNS: Array<{ heading: string; links: Array<{ label: string; target: string }> }> = [
  {
    heading: 'Platform',
    links: [
      { label: 'Product tour', target: 'showcase' },
      { label: 'Capabilities', target: 'capabilities' },
      { label: 'Architecture', target: 'architecture' },
      { label: 'Model catalog', target: 'info' },
      { label: 'Documentation', target: 'docs' },
    ],
  },
  {
    // Every surface here lives behind sign-in, so each one sends you there.
    heading: 'Console',
    links: [
      { label: 'Marketplace', target: 'access' },
      { label: 'Agentic terminal', target: 'access' },
      { label: 'Developer vault', target: 'access' },
      { label: 'Catalog advisor', target: 'access' },
    ],
  },
  {
    heading: 'Trust',
    links: [
      { label: 'Security posture', target: 'security' },
      { label: 'Key custody', target: 'docs/security' },
      { label: 'Incognito runs', target: 'security' },
      { label: 'FAQ', target: 'faq' },
    ],
  },
]

export const PlatformFooter = memo(function PlatformFooter({
  onNavigate,
  onAccess,
}: {
  onNavigate: (id: string) => void
  onAccess: () => void
}) {
  return (
    <HomepageReveal as="footer" className="homepage-footer w-full border-t border-white/[0.06] bg-black/45 px-6 pt-16 pb-10 backdrop-blur-md">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          {/* Wordmark block */}
          <div>
            <div className="font-mono-display text-[15px] uppercase tracking-[0.4em] text-white/85">
              ENZO
            </div>
            <p className="mt-4 max-w-[17rem] text-[12.5px] font-light leading-[1.75] text-white/35">
              A private command center for modern AI — nine provider gateways, a real agent
              runtime, and credentials that stay on the machine you run it on.
            </p>
            <div className="mt-6 inline-flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.22em] text-white/30">
              Catalog resyncs every 6 hours
            </div>
          </div>

          {FOOTER_COLUMNS.map((col) => (
            <div key={col.heading}>
              <div className="font-mono text-[9px] uppercase tracking-[0.28em] text-white/45">
                {col.heading}
              </div>
              <ul className="mt-5 space-y-3">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <button
                      type="button"
                      onClick={() => (link.target === 'access' ? onAccess() : onNavigate(link.target))}
                      className="text-[12.5px] font-light text-white/40 transition-colors hover:text-white/80"
                    >
                      {link.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-white/[0.06] pt-8 font-mono text-[9px] uppercase tracking-[0.26em] text-white/25 sm:flex-row">
          <span>© 2026 ENZO</span>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <span>Keys remain in local storage</span>
            <span>No wrapper margin</span>
            <button
              type="button"
              onClick={() => onNavigate('hero')}
              className="transition-colors hover:text-white/70"
            >
              Back to top
            </button>
          </div>
        </div>
      </div>
    </HomepageReveal>
  )
})
