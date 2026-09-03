import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import TerminalSection from './components/TerminalSection'
import { DrawLineText } from './components/ui/draw-line-text'
import { TactileButton } from './components/ui/tactile-button'
import { LiquidButton } from './components/ui/liquid-button'
import MorphPanel from './components/ui/ai-input'
import { HeaderThemeSelector } from './components/HeaderThemeSelector'
import { AutoWallpaper, emitWallpaperChanged } from './components/AutoWallpaper'
import FilmGrain from './components/FilmGrain'
import { LowPowerToggle } from './components/LowPowerToggle'
import HomeVignette from './components/HomeVignette'
import HomepageScrollDim from './components/HomepageScrollDim'
import HomepageScrollAnimations from './components/HomepageScrollAnimations'
import { useCraftHomepageFlag } from './hooks/useCraftHomepageFlag'
import { useLowPowerMode } from './hooks/useLowPowerMode'
import { HomepageFeatureCard } from './components/HomepageFeatureCard'
import { HomepageFeatureShowcase } from './components/HomepageFeatureShowcase'
import ModernLoginSignup from './components/ui/modern-login-signup'
import { GOOGLE_AUTH } from './lib/variant'
import {
  PlatformCapabilities,
  PlatformClosing,
  PlatformFAQ,
  PlatformFooter,
  PlatformPricing,
  PlatformProof,
  PlatformSecurity,
  PlatformThanks,
} from './components/HomepagePlatform'
import { HomepageReveal } from './components/HomepageReveal'
import { fadeIn } from './lib/gsapTransitions'
import { mintVaultToken } from './lib/vaultToken'
import { getProviderKeys, saveProviderKeys, clearAllProviderKeys } from './lib/keyStore'
import * as keyVault from './lib/keyVault'
import { sealRecovery, downloadRecovery, RECOVERY_EXT } from './lib/vaultRecovery'

// ─── Logo ────────────────────────────────────────────────────────────────────
function TypingBrand() {
  return (
    <span className="flex items-center gap-2">
      <DrawLineText
        text="ENZO"
        fontSize={16}
        strokeWidth={1}
        color="white"
        letterSpacing={4}
        className="font-display"
      />
    </span>
  )
}
import { ThemeSelector } from './components/ThemeSelector'
import { HomepageThemeRenderer, ThemeVideoWarmup, HOMEPAGE_THEMES, type HomepageTheme } from './themes/homepage'
import { MarketplaceThemeRenderer, WORKSPACE_THEMES, type WeatherType } from './themes/marketplace'
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useSpring,
  useTransform,
} from 'framer-motion'
import {
  Menu,
  X,
  Lock,
  ArrowRight,
  Wifi,
  RefreshCw,
} from 'lucide-react'
import { animate, stagger } from 'animejs'
import { OnboardingView, type OnbStep } from './components/OnboardingView'
import { HomepageDocs } from './components/HomepageDocs'
import { DocsDimOverlay } from './components/DocsDimOverlay'
import { TourOverlay } from './components/TourOverlay'
import { NotFound } from './components/ui/ghost-404-page'

// 'docs' and '404' render in place of the homepage sections rather than as a
// fixed overlay, so the nav bar (and its theme rail) stays live behind them.
// 'auth' is the Google identity login — docker variant builds (GOOGLE_AUTH=false)
// never reach it; their Login button opens provider-key onboarding instead.
type AppView = 'home' | 'auth' | 'loading' | 'onboarding' | 'docs' | '404'

// ─── Constants ────────────────────────────────────────────────────────────────

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface CatalogModel {
  id: string
  name: string
  provider: 'OpenRouter' | 'Groq' | 'Pollinations' | 'HuggingFace' | 'NVIDIA' | 'LLM7' | 'Google' | 'Puter' | 'Cloudflare'
  type: 'text' | 'image' | 'multimodal' | 'image-gen'
  free: boolean
  context_length: number
  description: string
  tags: string[]
  moderated: boolean
  pricing_prompt: string
  added_date: string
  max_output: number
  health?: {
    status: 'online' | 'degraded' | 'offline' | 'n/a' | 'unknown'
    latencyMs: number
    checkedAt: string
    error?: string
  } | null
}

// ─── Model Catalogue ──────────────────────────────────────────────────────────

// ─── Shared model-list fetch (deduped + cached) ───────────────────────────────
// Every model card needs to know which models the backend reports as available.
// Without sharing, each card fetched /api/v1/models independently — 15+ identical
// requests per page on mount and every poll tick, which becomes a request storm
// (especially loud when the backend is down). This caches the response for a
// short window and collapses concurrent callers onto a single in-flight request.
const MODELS_ENDPOINT = '/api/v1/models'

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function modelHealthState(h: CatalogModel['health']): string {
  if (!h) return 'unverified'
  switch (h.status) {
    case 'online': return '● online'
    case 'degraded': return '● degraded'
    case 'offline': return `● offline (${h.error || 'unreachable'})`
    case 'n/a': return 'not probed (image generation)'
    default: return 'unverified'
  }
}
const MODELS_CACHE_TTL = 5000 // ms

let modelsCache: { data: any[]; ts: number } | null = null
let modelsInFlight: Promise<any[]> | null = null

async function fetchModelsShared(force = false): Promise<any[]> {
  const now = Date.now()
  if (!force && modelsCache && now - modelsCache.ts < MODELS_CACHE_TTL) {
    return modelsCache.data
  }
  if (modelsInFlight) return modelsInFlight

  modelsInFlight = (async () => {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      // Send the user's own provider keys so the backend live-merges keyed
      // providers (esp. Groq) into the catalog even if the server key is dead.
      const res = await fetch(MODELS_ENDPOINT, {
        signal: controller.signal,
        headers: {
          'x-groq-key': keyVault.getItem('enzo.keys.groq') || '',
          'x-openrouter-key': keyVault.getItem('enzo.keys.openrouter') || keyVault.getItem('enzo-openrouter-key') || '',
          'x-nvidia-key': keyVault.getItem('enzo-nvidia-key') || keyVault.getItem('enzo.keys.nvidia') || '',
          'x-llm7-key': keyVault.getItem('enzo.keys.llm7') || '',
          'x-google-key': keyVault.getItem('enzo.keys.google') || '',
          'x-puter-key': keyVault.getItem('enzo.keys.puter') || '',
          'x-cloudflare-key': keyVault.getItem('enzo.keys.cloudflare') || '',
          'x-cloudflare-account': keyVault.getItem('enzo.keys.cloudflareAccount') || '',
        },
      })
      clearTimeout(timeout)
      if (!res.ok) throw new Error(`models endpoint ${res.status}`)
      const body = await res.json()
      const data = Array.isArray(body.data) ? body.data : []
      modelsCache = { data, ts: Date.now() }
      return data
    } finally {
      modelsInFlight = null
    }
  })()

  return modelsInFlight
}

const CATALOG_MODELS: CatalogModel[] = [
  {
    id: 'llama-3.3-70b',
    name: 'LLaMA-3.3-70B',
    provider: 'Groq',
    type: 'text',
    free: true,
    context_length: 128000,
    description: 'Expansive general knowledge. Default driver for general inquiries.',
    tags: ['General Chat', 'Reasoning'],
    moderated: true,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-01',
    max_output: 4096,
  },
  {
    id: 'qwen3-32b',
    name: 'QWEN3-32B',
    provider: 'Groq',
    type: 'text',
    free: true,
    context_length: 32768,
    description: 'High-performance coding assistant. Excels at syntax and refactoring.',
    tags: ['Coding'],
    moderated: true,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-02',
    max_output: 8192,
  },
  {
    id: 'llama-3.1-8b-instant',
    name: 'LLaMA-3.1-8B Instant',
    provider: 'Groq',
    type: 'text',
    free: true,
    context_length: 131072,
    description: 'Superfast low-latency context processor. Perfect for instant replies.',
    tags: ['General Chat'],
    moderated: true,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-15',
    max_output: 4096,
  },
  {
    id: 'minimax-m3',
    name: 'MINIMAX-M3',
    provider: 'Pollinations',
    type: 'text',
    free: true,
    context_length: 64000,
    description: 'Deep creative reasoning and immersive narrative generation.',
    tags: ['Creative'],
    moderated: false,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-03',
    max_output: 4096,
  },
  {
    id: 'meta/llama-3.3-70b-instruct',
    name: 'LLaMA-3.3-70B-Instruct',
    provider: 'NVIDIA',
    type: 'text',
    free: false,
    context_length: 131072,
    description: 'State-of-the-art 70B reasoning model from Meta, optimized on NVIDIA NIM.',
    tags: ['Reasoning'],
    moderated: true,
    pricing_prompt: 'Free tier via credits',
    added_date: '2026-06-04',
    max_output: 8192,
  },
  {
    id: 'nvidia/llama-3.1-nemotron-70b-instruct',
    name: 'LLaMA-3.1-Nemotron-70B',
    provider: 'NVIDIA',
    type: 'text',
    free: true,
    context_length: 131072,
    description: 'NVIDIA custom alignment model. Ideal for math, coding and reasoning.',
    tags: ['General Chat', 'Reasoning'],
    moderated: true,
    pricing_prompt: 'Free tier via credits',
    added_date: '2026-06-18',
    max_output: 4096,
  },
  {
    id: 'mistralai/mixtral-8x22b-instruct-v0.1',
    name: 'Mixtral 8x22B Instruct',
    provider: 'NVIDIA',
    type: 'text',
    free: true,
    context_length: 65536,
    description: 'High-performance sparse mixture-of-experts model on NVIDIA NIM.',
    tags: ['General Chat', 'Coding'],
    moderated: true,
    pricing_prompt: 'Free tier via credits',
    added_date: '2026-06-19',
    max_output: 8192,
  },
  {
    id: 'deepseek-r1',
    name: 'DeepSeek-R1',
    provider: 'OpenRouter',
    type: 'text',
    free: false,
    context_length: 65536,
    description: 'Uncensored logic engine. Advanced logic, mathematics and thinking chains.',
    tags: ['Reasoning', 'Uncensored'],
    moderated: false,
    pricing_prompt: '$0.0015 / 1K',
    added_date: '2026-06-05',
    max_output: 16384,
  },
  {
    id: 'deepseek-r1-distill-llama-70b',
    name: 'DeepSeek-R1 Distill LLaMA-70B (Free)',
    provider: 'OpenRouter',
    type: 'text',
    free: true,
    context_length: 131072,
    description: 'DeepSeek R1 reasoning chain distill on LLaMA-70B. Pure thinking speed.',
    tags: ['Reasoning', 'General Chat'],
    moderated: true,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-20',
    max_output: 8192,
  },
  {
    id: 'flux-schnell',
    name: 'FLUX.1 Schnell',
    provider: 'HuggingFace',
    type: 'image-gen',
    free: true,
    context_length: 0,
    description: 'Ultra-fast photorealistic text-to-image generator.',
    tags: ['Image Gen'],
    moderated: true,
    pricing_prompt: '0 / gen',
    added_date: '2026-06-06',
    max_output: 0,
  },
  {
    id: 'stable-diffusion-3.5',
    name: 'Stable Diffusion 3.5 Large',
    provider: 'HuggingFace',
    type: 'image-gen',
    free: true,
    context_length: 0,
    description: 'High-fidelity creative image generation with prompt compliance.',
    tags: ['Image Gen'],
    moderated: true,
    pricing_prompt: '0 / gen',
    added_date: '2026-06-21',
    max_output: 0,
  },
  {
    id: 'aura-flow',
    name: 'AuraFlow v0.3',
    provider: 'HuggingFace',
    type: 'image-gen',
    free: true,
    context_length: 0,
    description: 'Text-to-image diffusion model based on Flow Matching architectures.',
    tags: ['Image Gen'],
    moderated: false,
    pricing_prompt: '0 / gen',
    added_date: '2026-06-22',
    max_output: 0,
  },
  {
    id: 'phi-3-medium',
    name: 'Phi-3 Medium',
    provider: 'OpenRouter',
    type: 'text',
    free: true,
    context_length: 8192,
    description: 'Lightweight, instruction-tuned local execution intelligence.',
    tags: ['General Chat'],
    moderated: true,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-07',
    max_output: 2048,
  },
  {
    id: 'phi-3.5-mini-instruct',
    name: 'Phi-3.5 Mini Instruct (Free)',
    provider: 'OpenRouter',
    type: 'text',
    free: true,
    context_length: 131072,
    description: 'State-of-the-art lightweight reasoning model with long context.',
    tags: ['General Chat', 'Reasoning'],
    moderated: true,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-23',
    max_output: 4096,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'OpenRouter',
    type: 'multimodal',
    free: true,
    context_length: 1048576,
    description: 'Massive context processing capability. Multimodal audio/video translation.',
    tags: ['Vision', 'General Chat'],
    moderated: true,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-08',
    max_output: 8192,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'OpenRouter',
    type: 'multimodal',
    free: false,
    context_length: 2097152,
    description: 'Premium multimodal logic processor. Exceptional code writing and analysis.',
    tags: ['Vision', 'Coding', 'Reasoning'],
    moderated: true,
    pricing_prompt: '$0.007 / 1K',
    added_date: '2026-06-24',
    max_output: 8192,
  },
  {
    id: 'claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'OpenRouter',
    type: 'text',
    free: false,
    context_length: 200000,
    description: 'Gold standard for analytical writing and multi-file code editing.',
    tags: ['Coding', 'Reasoning'],
    moderated: true,
    pricing_prompt: '$0.003 / 1K',
    added_date: '2026-06-09',
    max_output: 8192,
  },
  {
    id: 'gemma-2-9b-it',
    name: 'Gemma-2-9B IT (Free)',
    provider: 'OpenRouter',
    type: 'text',
    free: true,
    context_length: 8192,
    description: 'Google highly performant open-source instruction-tuned model.',
    tags: ['General Chat'],
    moderated: true,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-25',
    max_output: 4096,
  },
  {
    id: 'llama-3.1-8b-instruct-free',
    name: 'LLaMA-3.1-8B Instruct (Free)',
    provider: 'OpenRouter',
    type: 'text',
    free: true,
    context_length: 128000,
    description: 'Meta lightweight model routed via free high-speed APIs.',
    tags: ['General Chat'],
    moderated: true,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-26',
    max_output: 4096,
  },
  {
    id: 'qwen-2.5-72b-instruct-free',
    name: 'QWEN-2.5-72B Instruct (Free)',
    provider: 'OpenRouter',
    type: 'text',
    free: true,
    context_length: 32768,
    description: 'Top-tier Alibaba open LLM. Incredible logical depth, coding and math.',
    tags: ['General Chat', 'Coding', 'Reasoning'],
    moderated: true,
    pricing_prompt: '0 / M tokens',
    added_date: '2026-06-27',
    max_output: 4096,
  },
  {
    id: 'command-r-plus',
    name: 'Command R Plus',
    provider: 'OpenRouter',
    type: 'text',
    free: false,
    context_length: 128000,
    description: 'Cohere flagship model built for advanced RAG tasks and tool execution.',
    tags: ['General Chat', 'Coding'],
    moderated: true,
    pricing_prompt: '$0.0025 / 1K',
    added_date: '2026-06-28',
    max_output: 8192,
  },
  {
    id: 'mistral-large',
    name: 'Mistral Large 2',
    provider: 'OpenRouter',
    type: 'text',
    free: false,
    context_length: 128000,
    description: 'Flagship European LLM. Strong multilingual capabilities and structural output.',
    tags: ['General Chat', 'Reasoning'],
    moderated: true,
    pricing_prompt: '$0.002 / 1K',
    added_date: '2026-06-29',
    max_output: 8192,
  },
]

// ─── Helper function to scroll smoothly ──────────────────────────────────────

const scrollToSection = (id: string) => {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth' })
  }
}

// ─── Homepage Hero ───────────────────────────────────────────────────────────

function WelcomeCorrection() {
  const [text, setText] = useState('')
  const [isFinal, setIsFinal] = useState(false)

  useEffect(() => {
    let cancelled = false
    let currentText = ''
    const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))
    const type = async (value: string, speed = 72) => {
      for (const character of value) {
        if (cancelled) return
        currentText += character
        setText(currentText)
        await wait(speed)
      }
    }
    const erase = async (speed = 38) => {
      while (!cancelled && currentText.length > 0) {
        currentText = currentText.slice(0, -1)
        setText(currentText)
        await wait(speed)
      }
    }

    const run = async () => {
      await type('Welcmo to ENZO')
      await wait(620)
      await erase()
      await type('Welocme to ENZO')
      await wait(620)
      await erase()
      await type('Welcom to ENZO')
      await wait(620)
      await erase()
      await type('sorry…', 100)
      await wait(820)
      await erase(48)
      await type('Welcome to ENZO', 88)
      if (!cancelled) setIsFinal(true)
    }

    void run()
    return () => { cancelled = true }
  }, [])

  return (
    <span className={isFinal ? 'welcome-correction is-final' : 'welcome-correction'} aria-live="polite">
      {text}<span className="welcome-cursor" aria-hidden="true" />
    </span>
  )
}

function HomepageHero({
  theme,
  onExplore,
  onAccess,
}: {
  theme: HomepageTheme
  onExplore: () => void
  onAccess: () => void
}) {
  const heroRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const targets = Array.from(heroRef.current?.querySelectorAll<HTMLElement>('[data-hero-reveal]') ?? [])
    if (!targets.length) return

    const entrance = animate(targets, {
      opacity: [0, 1],
      translateY: [28, 0],
      scale: [0.985, 1],
      delay: stagger(105),
      duration: 850,
      ease: 'outExpo',
    })

    return () => {
      entrance.cancel()
    }
  }, [])

  const isLight = theme === 'anime-sky'

  return (
    <section
      ref={heroRef}
      id="hero"
      data-section="homepage-hero"
      className={`home-hero ${
        isLight
          ? 'home-hero-sky'
          : 'home-hero-dark'
      }`}
      aria-labelledby="home-hero-title"
    >
      {!theme.startsWith('anime-') && <div className="home-orbit home-orbit-one" aria-hidden="true" />}
      {!theme.startsWith('anime-') && <div className="home-orbit home-orbit-two" aria-hidden="true" />}

      <div className="home-hero-inner">
        <h1 id="home-hero-title" data-hero-reveal className="home-title">
          <WelcomeCorrection />
        </h1>

        <p data-hero-reveal className="home-lede">
          The command center for frontier AI without frontier lock-in — every model routable,
          every key yours, every request leaving from your own machine.
        </p>

        <div data-hero-reveal className="home-actions">
          <LiquidButton type="button" onClick={onExplore} className="min-h-[3.15rem] px-6">
            Explore the system <ArrowRight size={16} strokeWidth={1.75} />
          </LiquidButton>
          <button type="button" onClick={onAccess} className="home-secondary-button">
            Sign up
          </button>
        </div>

        <div data-hero-reveal className="home-hero-microcopy">
          <span>No wrapper margin</span>
          <span>Keys stored on your device</span>
          <span>Runs on your infrastructure</span>
        </div>
      </div>

      <div data-hero-reveal className="home-scroll-cue" aria-hidden="true">
        <span /> Scroll to calibrate
      </div>
    </section>
  )
}

// ─── Homepage feature cards (logged-out landing) ────────────────────────────

const HOMEPAGE_FEATURES = [
  {
    index: '01',
    label: 'Direct Node Gateway',
    title: 'Bypass the Middleman',
    body: 'Connect directly to premium model provider endpoints (Groq, OpenRouter, NVIDIA NIM, HuggingFace). By routing requests from your local machine, you chat with top-tier AI models at raw developer rates with zero wrapper markups.',
  },
  {
    index: '02',
    label: 'Safe Custody',
    title: 'Browser-Bound Keys',
    body: "Your provider keys are encrypted with AES-256-GCM before they ever touch your browser's storage, under a key the browser will not let any JavaScript export — not ours, and not an attacker's. Turn on a passphrase and nothing usable is left at rest at all. We never sync, store, or log your keys.",
  },
  {
    index: '03',
    label: 'Search Optimization',
    title: 'Search That Never Dead-Ends',
    body: 'Save limits and time. A fast local heuristic decides whether a question actually needs the live web before spending a call on it. When it does, four backends are tried in order — Exa, DuckDuckGo, Bing, then a model with its own browsing — so a dead endpoint costs you result quality, never the feature.',
  },
  {
    index: '04',
    label: 'Stream Engineering',
    title: 'SSE Event Streaming',
    body: 'Watch tokens generate in real time. The Express backend pipes chat completions via Server-Sent Events (SSE) events, sending reasoning chains and text deltas directly to your layout console as they emit.',
  },
] as const

const SANDBOX_PROMPTS = [
  {
    title: "01 · One ask, answered",
    desc: "Plain English in, a finished answer out — the backend reads intent, calls the weather tool for your area, and never makes you write an API.",
    prompt: "hi hows weather in my area",
    code: `// Backend: how ENZO answers a plain-English ask
async function handleAsk(prompt, session) {
  const intent = await classify(prompt);
  // intent → { tool: "weather", needsLocation: true }

  const place = await session.geo();      // your area, from your machine
  const weather = await tools.weather(place);

  // no raw JSON dumped on you — one human answer:
  return compose(intent.model, weather);
}`,
    output: "[Router] intent → weather · location resolved → New Delhi, IN\n[Gateway] → llama-3.3-70b (Groq) · direct node · 61ms\n[Tool] live weather fetched for your area\n\nHey! It's 28°C and mostly cloudy in New Delhi right now, with\nlight winds around 12 km/h and no rain expected today — clear\nto head out, maybe carry a light jacket for the evening."
  },
  {
    title: "02 · Auto fallback",
    desc: "A provider dies mid-answer, the gateway swaps lanes mid-stream, and the reply you read never once stops or breaks.",
    prompt: "Explain how JWT signing works — one clean answer",
    code: `// Backend: failover chain, invisible to you
async function streamWithFallback(prompt) {
  const lanes = [groq, openrouter, nvidia];

  for (const lane of lanes) {
    try {
      return await gateway.stream(lane, prompt);
    } catch (err) {
      telemetry.laneDown(lane, err); // mark, move on
    }
  }
}`,
    output: "[Stream] groq · llama-3.3-70b … token 214/640\n[Fallback] groq rate-limited → openrouter lane joined mid-sentence\n[Stream] openrouter · resumed at token 215 … done 640/640\n\nYou gave one prompt, you got one answer. Header, payload and\nsignature explained start to finish — streamed in a single\nunbroken reply, no pause, no retry, no error on your screen."
  },
  {
    title: "03 · Skill memory",
    desc: "The console remembers how your last project worked and re-uses the pattern instead of making you re-teach it.",
    prompt: "build me webpage which has same database calling system like last project",
    code: `// Backend: recall the skill, apply it, don't relearn it
const prior = await memory.recall("database-calling");
// → { project: "portfolio-site", skill: "supabase-pool" }

app.get("/api/posts", async (req, res) => {
  // same calling system as your last project:
  const db = prior.skill.pool(process.env.SUPABASE_URL);
  const rows = await db.from("posts").select("*");
  res.json(rows);
});`,
    output: "[Memory] hit → recalled skill: supabase-pool (from portfolio-site)\n[Apply] wiring that exact database calling system into the page\n[Build] webpage + db layer assembled in one shot\n\nDelivered — your new webpage ships with the same database\ncalling system as your last project: pooled Supabase client,\ncached connection, same /api/posts contract. It remembered\nhow you built it last time, so you never re-explained it."
  }
]

function CodexSandboxSimulator({ isLight }: { isLight: boolean }) {
  const [activeIdx, setActiveIdx] = useState(0)
  const [displayedCode, setDisplayedCode] = useState("")
  const [isTyping, setIsTyping] = useState(false)
  const [activeTab, setActiveTab] = useState<'code' | 'output'>('code')

  const selected = SANDBOX_PROMPTS[activeIdx]

  useEffect(() => {
    let active = true
    setIsTyping(true)
    setActiveTab('code')
    setDisplayedCode("")
    
    let currentText = ""
    const codeText = selected.code
    let charIndex = 0
    
    const interval = setInterval(() => {
      if (!active) return
      if (charIndex < codeText.length) {
        currentText += codeText.substring(charIndex, charIndex + 4)
        setDisplayedCode(currentText)
        charIndex += 4
      } else {
        clearInterval(interval)
        setIsTyping(false)
      }
    }, 12)

    return () => {
      active = false
      clearInterval(interval)
    }
  }, [activeIdx])

  return (
    <div className="grid gap-8 lg:grid-cols-12 text-left mt-8">
      {/* Left side: Prompts */}
      <div className="lg:col-span-5 space-y-4">
        {SANDBOX_PROMPTS.map((item, idx) => {
          const isActive = activeIdx === idx
          return (
            <button
              key={idx}
              onClick={() => setActiveIdx(idx)}
              className="w-full rounded-2xl border p-5 text-left transition-[background-color,border-color,transform] duration-150 ease-out hover:-translate-y-px"
              style={{
                background: isActive 
                  ? (isLight ? 'rgba(255, 255, 255, 0.90)' : 'rgba(255, 255, 255, 0.06)')
                  : 'transparent',
                borderColor: isActive
                  ? (isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.16)')
                  : (isLight ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.05)'),
              }}
            >
              <div className={`font-mono text-[9px] uppercase tracking-[0.3em] ${isLight ? 'text-slate-500' : 'text-white/[0.45]'}`}>
                {item.title}
              </div>
              <h4 className={`font-garamond text-base sm:text-lg font-normal mt-2 ${isLight ? 'text-slate-800' : 'text-white'}`}>
                {item.prompt}
              </h4>
              <p className={`text-xs font-light mt-2 leading-relaxed ${isLight ? 'text-slate-500' : 'text-white/40'}`}>
                {item.desc}
              </p>
            </button>
          )
        })}
      </div>

      {/* Right side: Sandbox IDE Console */}
      <div 
        className="lg:col-span-7 flex flex-col rounded-2xl border overflow-hidden shadow-2xl min-h-[360px]"
        style={{
          background: isLight ? 'rgba(255, 255, 255, 0.92)' : 'rgba(10, 12, 22, 0.88)',
          borderColor: isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.10)',
        }}
      >
        {/* IDE Header */}
        <div className={`flex items-center justify-between border-b px-5 py-3 ${isLight ? 'border-black/5 bg-slate-50' : 'border-white/5 bg-black/40'}`}>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-green-500/80" />
            <span className={`ml-2 font-mono text-[10px] tracking-wider ${isLight ? 'text-slate-400' : 'text-white/40'}`}>SANDBOX_SIMULATOR.TS</span>
          </div>
          <div className={`flex gap-1 p-0.5 rounded-lg border font-mono text-[9px] ${isLight ? 'bg-slate-200/50 border-black/5' : 'bg-black/30 border-white/5'}`}>
            <button
              onClick={() => setActiveTab('code')}
              className={`px-2.5 py-1 rounded-md transition-colors duration-150 ${
                activeTab === 'code' 
                  ? (isLight ? 'bg-white text-slate-800 shadow-sm' : 'bg-white/10 text-white') 
                  : (isLight ? 'text-slate-400 hover:text-slate-800' : 'text-white/40 hover:text-white')
              }`}
            >
              CODE
            </button>
            <button
              onClick={() => setActiveTab('output')}
              className={`px-2.5 py-1 rounded-md transition-colors duration-150 ${
                activeTab === 'output' 
                  ? (isLight ? 'bg-white text-slate-800 shadow-sm' : 'bg-white/10 text-white') 
                  : (isLight ? 'text-slate-400 hover:text-slate-800' : 'text-white/40 hover:text-white')
              }`}
            >
              OUTPUT
            </button>
          </div>
        </div>

        {/* IDE Editor Viewport */}
        <div className="flex-1 p-5 font-mono text-[11px] leading-relaxed overflow-auto max-h-[300px]">
          {activeTab === 'code' ? (
            <pre className={`whitespace-pre-wrap ${isLight ? 'text-slate-700' : 'text-[#a5b4fc]'}`}>
              <code>
                {displayedCode}
                {isTyping && <span className="animate-pulse">|</span>}
              </code>
            </pre>
          ) : (
            <pre className={`whitespace-pre-wrap ${isLight ? 'text-emerald-700' : 'text-emerald-400'}`}>
              <code>{selected.output}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── App Component ────────────────────────────────────────────────────────────

function App() {
  const [activeModel, setActiveModel] = useState<CatalogModel>(CATALOG_MODELS[0])
  const [selectedHandoff, setSelectedHandoff] = useState<CatalogModel | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [appView, setAppView] = useState<AppView>('home')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [activeTab, setActiveTab] = useState<'marketplace' | 'terminal' | 'vault'>('marketplace')
  const [onboardingStep, setOnboardingStep] = useState<OnbStep>(1)
  const [catalog, setCatalog] = useState<CatalogModel[]>(CATALOG_MODELS)
  const [showTour, setShowTour] = useState(() => {
    // "enzo.tour.dont-show-again" is a UI preference, not a secret — read it
    // directly from localStorage so it survives reload. (keyVault only decrypts
    // managed keys like "enzo.keys.*"; a boolean flag would never be populated
    // in its in-memory map and would read back as null every time.)
    return !localStorage.getItem('enzo.tour.dont-show-again')
  })

  // Docs dim overlay scroll depth (0 → 1 past the "How ENZO works" masthead)
  const [docsDimDepth, setDocsDimDepth] = useState(0)

  // Homepage atmosphere — first registry entry ('nebula') is the default, so the
  // shader background loads for first-time visitors and whenever the saved
  // value is missing or no longer a registered theme (e.g. old 'space-dark').
  const [homepageTheme, setHomepageTheme] = useState<HomepageTheme>(() => {
    const saved = localStorage.getItem('enzo.theme')
    return HOMEPAGE_THEMES.some((theme) => theme.id === saved)
      ? (saved as HomepageTheme)
      : HOMEPAGE_THEMES[0].id
  })

  const isLightTheme = useMemo(() => {
    return homepageTheme === 'anime-sky'
  }, [homepageTheme])

  // Theme commit, deferred off the click. Swapping themes tears down one
  // WebGL/video pipeline and cold-loads the next scene's multi-MB mp4 —
  // doing that synchronously made the rail click itself feel laggy. The
  // state change (and its whole-tree re-render) waits one idle tick so the
  // click paints first; rail drag also lands here, once, on release.
  const commitHomepageTheme = useCallback((id: string) => {
    const next = () => setHomepageTheme(id as HomepageTheme)
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(next, { timeout: 100 })
    } else {
      requestAnimationFrame(next)
    }
  }, [])

  // ponytail: gesture control lives unwired in features/gesture/ — see its
  // README. The listener that used to sit here was dead on arrival: it waited for
  // a 'gesture-detected' event that nothing in the codebase has ever dispatched,
  // and the module it was meant to pair with routes tab/theme changes through a
  // callback registry nobody registers with. Re-add it in that folder, beside the
  // emitter, so the event names are always edited in one place.

  const refreshCatalog = useCallback(async (hard = false) => {
    // Clear in-memory modelsCache to force load updated keys' models
    modelsCache = null
    try {
      // Hard refresh: tell the backend to re-scrape every provider and rebuild
      // its on-disk cache before we read it (manual "Refresh" button).
      if (hard) {
        try {
          await fetch('/api/models/refresh', {
            method: 'POST',
            headers: {
              'x-groq-key': keyVault.getItem('enzo.keys.groq') || '',
              'x-nvidia-key': keyVault.getItem('enzo-nvidia-key') || keyVault.getItem('enzo.keys.nvidia') || '',
              'x-hf-key': keyVault.getItem('enzo.keys.huggingface') || '',
            },
          })
        } catch (e) {
          console.warn('Hard catalog refresh failed, falling back to cached fetch:', e)
        }
      }
      const data = await fetchModelsShared(true)
      if (data.length > 0) {
        const liveList = data.map((m: any) => {
          let provider = m.provider || 'OpenRouter'
          if (provider.toLowerCase() === 'groq') provider = 'Groq'
          else if (provider.toLowerCase() === 'openrouter') provider = 'OpenRouter'
          else if (provider.toLowerCase() === 'pollinations') provider = 'Pollinations'
          else if (provider.toLowerCase() === 'huggingface') provider = 'HuggingFace'
          else if (provider.toLowerCase() === 'nvidia') provider = 'NVIDIA'
          else if (provider.toLowerCase() === 'llm7') provider = 'LLM7'
          else if (provider.toLowerCase() === 'google' || provider.toLowerCase() === 'gemini') provider = 'Google'
          else if (provider.toLowerCase() === 'puter') provider = 'Puter'
          else if (provider.toLowerCase() === 'cloudflare') provider = 'Cloudflare'

          return {
            id: m.id,
            name: m.name,
            provider: provider,
            type: m.type || 'text',
            free: !!m.free,
            context_length: m.context_length || 0,
            description: m.description || '',
            tags: Array.isArray(m.tags) ? m.tags : ['General Chat'],
            moderated: !!m.moderated,
            pricing_prompt: m.pricing_prompt || '0 / M tokens',
            added_date: m.added_date || '2026-06-01',
            max_output: m.max_output || 4096,
          }
        })
        if (liveList.length > 0) {
          setCatalog(liveList)
        }
      }
    } catch (err) {
      console.warn("Could not load live catalog models from backend:", err)
    }
  }, [])

  // Live Catalog Polling: Auto-refresh models from server every 30 seconds
  // Initial load does a HARD refresh (full backend re-scrape) to pick up new/decommissioned models
  useEffect(() => {
    refreshCatalog(true)
    const interval = setInterval(() => refreshCatalog(false), 30000)
    return () => clearInterval(interval)
  }, [refreshCatalog])

  // Check if user has already onboarded (both OR and NVIDIA keys are compulsory) and handle OAuth callbacks
  useEffect(() => {
    const hasOpenRouter = !!(
      keyVault.getItem('enzo.keys.openrouter') ||
      keyVault.getItem('enzo-openrouter-key')
    )
    const hasNvidia = !!(
      keyVault.getItem('enzo-nvidia-key') ||
      keyVault.getItem('enzo.keys.nvidia')
    )
    const hasGoogle = !!(
      keyVault.getItem('enzo.keys.google') ||
      keyVault.getItem('enzo.keys.gemini')
    )

    if (hasOpenRouter && hasNvidia && hasGoogle) {
      setIsLoggedIn(true)
      setAppView('home')
    } else if (hasOpenRouter && hasNvidia && !hasGoogle) {
      // OR + NVIDIA done but Google AI Studio key missing → land on step 3
      setIsLoggedIn(false)
      setOnboardingStep(3)
      setAppView('onboarding')
    } else if (hasOpenRouter && !hasNvidia) {
      setIsLoggedIn(false)
      setOnboardingStep(2)
      setAppView('onboarding')
    } else if (localStorage.getItem('enzo.auth.token')) {
      // Google OAuth sign-up completed, but the compulsory OR/NVIDIA keys
      // aren't set yet — keep the user moving through the sign-up process
      // instead of dropping them back on the marketing homepage.
      setIsLoggedIn(false)
      setOnboardingStep(1)
      setAppView('onboarding')
    } else {
      setIsLoggedIn(false)
    }

    // Handle OAuth callbacks
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (code) {
      const orVerifier = sessionStorage.getItem('enzo.oauth.code_verifier')
      const hfVerifier = sessionStorage.getItem('enzo.oauth.hf_code_verifier')

      if (orVerifier) {
        // Consume the verifier and strip the code from the URL *synchronously*
        // before the async exchange. OAuth codes are single-use, and React
        // StrictMode double-invokes this effect in dev — without this, the
        // second run replays the already-consumed code, the exchange fails,
        // and the catch below would bounce the user back to the homepage.
        sessionStorage.removeItem('enzo.oauth.code_verifier')
        window.history.replaceState({}, document.title, window.location.pathname)
        setAppView('loading')
        fetch("https://openrouter.ai/api/v1/auth/keys", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code,
            code_verifier: orVerifier,
            code_challenge_method: "S256",
          }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP error ${res.status}`)
            return res.json()
          })
          .then((data) => {
            if (data.key) {
              keyVault.setItem("enzo.keys.openrouter", data.key.trim())
              keyVault.setItem("enzo-openrouter-key", data.key.trim())

              // OpenRouter connected, but NVIDIA is still missing & compulsory!
              setIsLoggedIn(false)
              setOnboardingStep(2) // Move directly to NVIDIA NIM setup (Step 2)
              setAppView('onboarding')
            } else {
              throw new Error("API key not returned")
            }
          })
          .catch((err) => {
            console.error("OpenRouter OAuth exchange failed:", err)
            // Stay in onboarding so the user can retry rather than losing all
            // progress back to the marketing homepage.
            setIsLoggedIn(false)
            setOnboardingStep(1)
            setAppView('onboarding')
          })
      } else if (hfVerifier) {
        // Same single-use guard as OpenRouter above.
        const hfState = sessionStorage.getItem('enzo.oauth.hf_state')
        sessionStorage.removeItem('enzo.oauth.hf_code_verifier')
        sessionStorage.removeItem('enzo.oauth.hf_state')
        window.history.replaceState({}, document.title, window.location.pathname)
        setAppView('loading')
        // This code is redeemed by our server, so verify it came back from the
        // authorize request this browser started before spending it.
        if (hfState && params.get('state') !== hfState) {
          console.error('HuggingFace OAuth state mismatch — ignoring this code')
          setOnboardingStep(3)
          setAppView('onboarding')
          return
        }
        fetch("/api/v1/auth/hf-exchange", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code,
            code_verifier: hfVerifier,
            client_id: import.meta.env.VITE_HF_CLIENT_ID,
            redirect_uri: window.location.origin + window.location.pathname,
          }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP error ${res.status}`)
            return res.json()
          })
          .then((data) => {
            if (data.access_token) {
              keyVault.setItem("enzo.keys.huggingface", data.access_token.trim())
              keyVault.setItem("enzo-huggingface-key", data.access_token.trim())
              // Deliberately NOT setIsLoggedIn(true): HuggingFace is step 3 and
              // does not satisfy the compulsory OpenRouter + NVIDIA gate. Finishing
              // onboarding is what grants access (handleOnboardingDone).
              setOnboardingStep(3)
              setAppView('onboarding')
            } else {
              throw new Error("access token not returned")
            }
          })
          .catch((err) => {
            console.error("HuggingFace OAuth exchange failed:", err)
            // HuggingFace is optional; keep the user in onboarding instead of
            // dropping them on the homepage.
            setOnboardingStep(3)
            setAppView('onboarding')
          })
      }
    }
  }, [])

  // Hosted: opens the Google identity login. Docker variant: identity OAuth is
  // removed, so Login goes straight to provider-key onboarding — the app's
  // actual login gate (App never verifies identity; the keys are the account).
  const handleLogin = () => setAppView(GOOGLE_AUTH ? 'auth' : 'onboarding')
  const handleOnboardingDone = () => {
    setIsLoggedIn(true)
    setAppView('home')
    setActiveTab('marketplace')
  }
  const handleSignOut = () => {
    // Full sign-out: every provider key (plus its legacy alias), the vault
    // session token, and the auth JWT. Leaving keys behind would keep a shared
    // machine "signed in" for chat while the UI says signed out.
    clearAllProviderKeys()
    sessionStorage.removeItem('enzo.vault.token')
    sessionStorage.removeItem('enzo.vault.mintBlocked')
    localStorage.removeItem('enzo.auth.token')
    setIsLoggedIn(false)
    setAppView('home')
  }

  // Interactive Forest Background state for Marketplace section (persisted)
  const [mBackgroundVideoId, setMBackgroundVideoId] = useState<string>(() => {
    const saved = localStorage.getItem('enzo.workspace.theme')
    // Fall back to the registry's first entry, not a hardcoded id: the lite
    // image ships only that theme, and hardcoding 'purple_flowers' here made a
    // fresh full-build user request a video the registry's default never named.
    return WORKSPACE_THEMES.some((t) => t.id === saved) ? (saved as string) : WORKSPACE_THEMES[0].id
  })
  const [mWeather, setMWeather] = useState<WeatherType>('clear')

  // Persist workspace backdrop selection
  useEffect(() => {
    localStorage.setItem('enzo.workspace.theme', mBackgroundVideoId)
  }, [mBackgroundVideoId])

  // Persist homepage theme selection
  useEffect(() => {
    if (HOMEPAGE_THEMES.some((t) => t.id === homepageTheme)) {
      localStorage.setItem('enzo.theme', homepageTheme)
    }
  }, [homepageTheme])

  const handlePreloadRequest = (videoSrc: string) => {
    // Create a temporary video element in the background to start preloading/buffering
    const tempVideo = document.createElement('video')
    tempVideo.src = videoSrc
    tempVideo.preload = 'auto'
  }

  // ─── Real Vault Keys syncing ────────────────────────────────────────────────
  const [vaultKeys, setVaultKeys] = useState<Record<string, string>>({})

  useEffect(() => {
    // The vault is a GUI of the local device store — read through keyVault so the
    // form reflects exactly what chat requests will send. No server read needed:
    // in BYOK mode keys never live server-side. keyVault.init() (awaited in
    // main.tsx) has already decrypted everything and rebuilt from the IndexedDB
    // mirror if localStorage was swept.
    setVaultKeys(getProviderKeys())
  }, [appView])

  // 🐴 ponytail: tour temporarily unwired — auto-trigger disabled until the
  // tour is revisited. The effect below is intentionally short-circuited so
  // showTour never flips to true on first render; keep it inert, do not delete
  // the TourOverlay component or its data-tour-step markup (see AGENTS.md /
  // "always-verify-with-browser-preview"). Re-enable by removing this guard.
  useEffect(() => {
    // intentionally no-op: tour is parked, not removed.
    return
    // eslint-disable-next-line no-unreachable
    if (showTour) return
    if (!isLoggedIn || appView !== 'home' || activeTab !== 'marketplace') return
    // "enzo.tour.dont-show-again" is a UI pref stored in plain localStorage
    // (keyVault only manages "enzo.keys.*"), so read it directly here.
    if (localStorage.getItem('enzo.tour.dont-show-again')) return
    setShowTour(true)
  }, [isLoggedIn, appView, activeTab, showTour])

  // Docs shares the homepage's theme background and light-mode palette, so both
  // are "themed home surfaces". They are NOT the same craft surface, though —
  // see the useCraftHomepageFlag call below.
  const isThemedHomeSurface = (appView === 'home' || appView === 'docs' || appView === '404') && !isLoggedIn
  const isWorkspaceSurface =
    appView === 'home' && isLoggedIn && (activeTab === 'marketplace' || activeTab === 'terminal' || activeTab === 'vault')

  // Craft-polish blast-radius firewall. The value matters: "home" also arms the
  // rules that style the homepage's own sections, "docs" arms only the shared
  // chrome (nav, footer, scrollbar, selection, light-theme contrast). Docs needs
  // the chrome — most visibly the 10px scrollbar, since a different gutter width
  // moves the centre-anchored nav sideways between the two views — but must not
  // inherit section styling onto running prose. See homepage-polish.css header.
  useCraftHomepageFlag(isThemedHomeSurface, appView === 'docs' ? 'docs' : 'home')

  // Low-end devices (or reduced-motion / manual Lite mode) skip the full-screen
  // WebGL video background — its 60fps decode+blend loop is the heaviest runtime
  // cost. A static gradient keeps the look without the GPU/battery drain.
  const lowPower = useLowPowerMode()

  // ── Docs + 404 deep linking ──
  // #docs, #docs/<section> and #404 open their view on a cold load and survive
  // the back button. HomepageDocs owns scrolling to the section; this only owns
  // which view is mounted. Runs on mount and on every hash change, so Back out
  // of either returns to the homepage rather than leaving a stale view behind.
  useEffect(() => {
    const syncFromHash = () => {
      const hash = window.location.hash
      const isDocs = hash.startsWith('#docs')
      const is404 = hash.startsWith('#404')
      // Never steal the view mid-auth: the OAuth callback also arrives via hash.
      setAppView((prev) => {
        if (isDocs) return 'docs'
        if (is404) return '404'
        return prev === 'docs' || prev === '404' ? 'home' : prev
      })
    }
    syncFromHash()
    window.addEventListener('hashchange', syncFromHash)
    return () => window.removeEventListener('hashchange', syncFromHash)
  }, [])

  // The pricing grid's Buy buttons all land here. There is no checkout to
  // build, so the "payment flow" is one pushState into the 404.
  const open404 = () => {
    setMenuOpen(false)
    window.history.pushState(null, '', '#404')
    setAppView('404')
    window.scrollTo({ top: 0 })
  }

  const openDocs = (section?: string) => {
    setMenuOpen(false)
    // pushState, so Back returns to the homepage instead of leaving the app.
    window.history.pushState(null, '', section ? `#docs/${section}` : '#docs')
    setAppView('docs')
    // HomepageDocs reads the hash on mount and scrolls itself; from the top is
    // the right starting point when no section was asked for.
    if (!section) window.scrollTo({ top: 0 })
  }

  // The footer's link targets are scroll ids, except the two that open Docs.
  const footerNavigate = (target: string) =>
    target === 'docs' || target.startsWith('docs/')
      ? openDocs(target.slice(5) || undefined)
      : goToSection(target)

  // True whenever a hash-routed view has replaced the homepage sections. The
  // scroll targets do not exist while one is mounted, so anything that wants to
  // scroll has to unmount it first — see goToSection.
  const isSubView = appView === 'docs' || appView === '404'

  // scrollToSection is a no-op when the target is not in the DOM, which silently
  // swallowed every nav click made from a sub-view. Route the homepage's own
  // links through here instead so they always land.
  const goToSection = (id: string) => {
    setMenuOpen(false)
    if (isSubView) leaveDocs(id)
    else scrollToSection(id)
  }

  // Returns to the homepage from any hash-routed sub-view (docs, 404).
  const leaveDocs = (thenScrollTo?: string) => {
    setMenuOpen(false)
    window.history.pushState(null, '', window.location.pathname)
    setAppView('home')
    // The homepage sections mount in this same commit, so the scroll target does
    // not exist yet — wait one frame for it.
    if (thenScrollTo) requestAnimationFrame(() => scrollToSection(thenScrollTo))
    else window.scrollTo({ top: 0 })
  }

  return (
    <div className={`relative min-h-screen text-white ${isThemedHomeSurface && isLightTheme ? 'light-theme-mode' : ''}`}>
      {/* ── Background layers — segregated per domain view ── */}
      {lowPower ? (
        // Static gradient stand-in for the WebGL video themes on weak devices.
        <div
          className="fixed inset-0 z-0"
          aria-hidden="true"
          style={{
            background: isThemedHomeSurface && isLightTheme
              ? 'linear-gradient(160deg,#e8ecf5 0%,#c9d3e8 100%)'
              : 'radial-gradient(1200px 800px at 70% -10%,#12172a 0%,#0a0c16 55%,#06070c 100%)',
          }}
        />
      ) : isThemedHomeSurface ? (
        <>
          {/* First-visit warm-up: pulls every theme video into the HTTP
              cache in the background so later theme switches are instant.
              Renders nothing; guards itself (save-data, 2G, low-power). */}
          <ThemeVideoWarmup />
          <HomepageThemeRenderer theme={homepageTheme} />
          {appView === 'docs' && (
            <DocsDimOverlay depth={docsDimDepth} />
          )}
          <HomepageScrollDim />
            <HomepageScrollAnimations />
          <HomeVignette tone={isLightTheme ? 'light' : 'dark'} />
          <FilmGrain />
        </>
      ) : isWorkspaceSurface ? (
        <MarketplaceThemeRenderer
          backgroundVideoId={mBackgroundVideoId}
          weather={mWeather}
          onPreloadRequest={handlePreloadRequest}
        />
      ) : (
        <div className="fixed inset-0 z-0 bg-[#06070c]" aria-hidden="true" />
      )}

      {/* Unsplash auto-wallpaper layer (unplugged for now to avoid mixing with video themes) */}
      <AutoWallpaper active={false} />


      {/* ── Auth / Onboarding overlay views ── */}
      <AnimatePresence>
        {appView === 'auth' && GOOGLE_AUTH && (
          <AuthView
            onBack={() => setAppView('home')}
          />
        )}
        {appView === 'loading' && (
          <motion.div
            ref={fadeIn}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/95 backdrop-blur-xl px-4 text-center font-mono-display"
          >
            <div className="space-y-4">
              <div className="h-10 w-10 mx-auto rounded-xl border border-white/20 border-t-white animate-spin" />
              <div className="text-[10px] uppercase tracking-[0.25em] text-white/50">negotiating handshake protocols…</div>
              <div className="text-[9px] uppercase tracking-widest text-white/30">setting up local cache container</div>
            </div>
          </motion.div>
        )}
        {appView === 'onboarding' && (
          <OnboardingView
            initialStep={onboardingStep}
            onDone={handleOnboardingDone}
          />
        )}
      </AnimatePresence>

      {/* ── Floating Liquid Glass Navigation Bar ── */}
      <nav className="fixed top-4 left-1/2 -translate-x-1/2 z-40 w-[92%] md:w-[85%] max-w-6xl rounded-full border border-white/10 bg-[#06070c]/60 backdrop-blur-2xl px-6 py-2.5 shadow-[0_8px_32px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] flex items-center justify-between transition-all duration-300 ring-1 ring-white/[0.03]">
        <div className="w-full flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              if (!isLoggedIn) {
                setAppView('home')
                scrollToSection('hero')
              }
            }}
            className="flex shrink-0 items-center gap-1 focus:outline-none"
          >
            <TypingBrand />
          </button>

          {/* Desktop links (dynamically centered between brand and right controls) */}
          <div className="hidden min-w-0 flex-1 items-center justify-center gap-1 md:flex">
            {isLoggedIn ? (
              <>
                {(['marketplace', 'terminal', 'vault'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    data-tour-step={`nav-${tab}`}
                    className={`relative font-mono-display text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 rounded-full transition-all duration-300 ${
                      activeTab === tab
                        ? 'text-white'
                        : 'text-white/45 hover:text-white/90'
                    }`}
                  >
                    {activeTab === tab && (
                      <motion.span
                        layoutId="nav-active-pill"
                        transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                        className="absolute inset-0 rounded-full bg-white/10 border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                      />
                    )}
                    <span className="relative z-10">{tab}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <button
                  onClick={() => (isSubView ? leaveDocs() : scrollToSection('hero'))}
                  aria-current={isSubView ? undefined : 'page'}
                  className={`font-mono-display text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 rounded-full hover:text-white hover:bg-white/5 transition-all duration-300 ${
                    isSubView ? 'text-white/60' : 'text-white bg-white/5'
                  }`}
                >
                  Home
                </button>
                <button
                  onClick={() => openDocs()}
                  aria-current={appView === 'docs' ? 'page' : undefined}
                  className={`font-mono-display text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 rounded-full hover:text-white hover:bg-white/5 transition-all duration-300 ${
                    appView === 'docs' ? 'text-white bg-white/5' : 'text-white/60'
                  }`}
                >
                  Docs
                </button>
                <button
                  onClick={() => goToSection('pricing')}
                  className="font-mono-display text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 rounded-full hover:text-white hover:bg-white/5 transition-all duration-300 text-white/60"
                >
                  Pricing
                </button>
              </>
            )}
          </div>

          {/* Right: Login / Sign out / Theme selector.
              `min-w-0` instead of `shrink-0`: at phone width the eleven-slot theme
              rail overflowed this row and pushed the hamburger off the right edge,
              making the mobile menu unopenable. Every child here is shrink-0 except
              the rail's scroll wrapper, so the rail is the only thing that gives
              ground. At md+ nothing overflows, so none of this engages and the
              desktop nav geometry is bit-for-bit what it was. */}
          <div className="flex min-w-0 items-center gap-2">
            {isLoggedIn && isWorkspaceSurface && (
              <HeaderThemeSelector
                activeId={mBackgroundVideoId}
                onChange={setMBackgroundVideoId}
              />
            )}
            {isLoggedIn ? (
              <button
                onClick={handleSignOut}
                className="font-mono-display shrink-0 uppercase text-white/45 text-[11px] tracking-[0.18em] px-3 py-1.5 rounded-full hover:text-white hover:bg-white/5 transition-all"
              >
                Sign out
              </button>
            ) : (
              <TactileButton
                label="Login"
                mode={isLightTheme ? 'light' : 'dark'}
                width={124}
                height={40}
                fontSize={10}
                onClick={handleLogin}
                className="shrink-0"
              />
            )}
            {/* Homepage theme selector - only show on homepage (not logged in).
                The rail is one slot per theme (eleven of them, ~330px), which does
                not fit a phone alongside the brand and the login pill. It scrolls
                horizontally rather than being dropped below md, because losing
                theme switching on mobile is worse than a swipe. Its scrollbar is
                hidden because homepage-polish.css §9 styles ::-webkit-scrollbar to
                10px, which would otherwise sit under the rail. `flex` on the wrapper
                is not cosmetic: the rail is inline-flex, so a block wrapper adds a
                7px line box under it and grows the whole nav by 2px. */}
            {!isLoggedIn && (
              <div className="flex min-w-0 shrink overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:overflow-visible">
                <ThemeSelector
                  themes={HOMEPAGE_THEMES}
                  activeThemeId={homepageTheme}
                  onChange={commitHomepageTheme}
                />
              </div>
            )}
            {/* Mobile hamburger */}
            <button
              className="flex shrink-0 items-center justify-center text-white/80 transition-colors hover:text-white md:hidden"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Toggle menu"
            >
              {menuOpen ? <X size={22} /> : <Menu size={22} />}
            </button>
          </div>
        </div>
      </nav>
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            className="mobile-menu-glass fixed left-4 right-4 top-16 z-50 flex flex-col items-center gap-5 rounded-2xl py-8 md:hidden"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            {isLoggedIn ? (
              <>
                <button
                  onClick={() => { setMenuOpen(false); setActiveTab('marketplace') }}
                  className="font-light uppercase tracking-widest text-white/90 hover:text-white text-sm"
                  style={{ letterSpacing: '0.25em' }}
                >
                  Marketplace
                </button>
                <button
                  onClick={() => { setMenuOpen(false); setActiveTab('terminal') }}
                  className="font-light uppercase tracking-widest text-white/90 hover:text-white text-sm"
                  style={{ letterSpacing: '0.25em' }}
                >
                  Terminal
                </button>
                <button
                  onClick={() => { setMenuOpen(false); setActiveTab('vault') }}
                  className="font-light uppercase tracking-widest text-white/90 hover:text-white text-sm"
                  style={{ letterSpacing: '0.25em' }}
                >
                  Vault
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => (isSubView ? leaveDocs() : (setMenuOpen(false), scrollToSection('hero')))}
                  className="font-light uppercase tracking-widest text-white/90 hover:text-white text-sm"
                  style={{ letterSpacing: '0.25em' }}
                >
                  Home
                </button>
                <button
                  onClick={() => openDocs()}
                  className="font-light uppercase tracking-widest text-white/90 hover:text-white text-sm"
                  style={{ letterSpacing: '0.25em' }}
                >
                  Docs
                </button>
                <button
                  onClick={() => goToSection('pricing')}
                  className="font-light uppercase tracking-widest text-white/90 hover:text-white text-sm"
                  style={{ letterSpacing: '0.25em' }}
                >
                  Pricing
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── MAIN CONTENT ─── */}
      <div className="relative z-10 flex flex-col items-center w-full" style={{ transform: 'translateZ(0)' }}>
        {!isLoggedIn ? (
          appView === '404' ? (
            <NotFound
              onHome={() => leaveDocs()}
              onDocs={() => openDocs()}
            />
          ) : appView === 'docs' ? (
            <HomepageDocs isLight={isLightTheme} onBack={() => leaveDocs()} onScrollDepth={setDocsDimDepth} />
          ) : (
          <>
            <HomepageHero
              theme={homepageTheme}
              onExplore={() => scrollToSection('showcase')}
              onAccess={handleLogin}
            />

            {/* 1.2. PROOF BAND — gateways routed + verifiable platform counters */}
            <PlatformProof isLight={isLightTheme} />

            {/* 1.5. FEATURE SHOWCASE — GitHub-style product tour with promo shots */}
            <HomepageFeatureShowcase isLight={isLightTheme} onAccess={handleLogin} />

            {/* 1.8. CAPABILITY BENTO — tool runtime, modes, gesture, routing, custody */}
            <PlatformCapabilities isLight={isLightTheme} />

            {/* 2. INFO SECTION — the four console surfaces, up close */}
            <section
              id="info"
              data-section="byo-ai-paradigm"
              data-gsap-reveal
              className="w-full max-w-6xl px-6 py-28"
            >
              <div className="text-center">
                <div className={`inline-flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.3em] ${isLightTheme ? 'text-slate-500' : 'text-white/[0.45]'}`}>
                  <span className={`tracking-[0.3em] ${isLightTheme ? 'text-slate-400' : 'text-white/[0.28]'}`}>
                    04
                  </span>
                  <span
                    aria-hidden="true"
                    className={`h-px w-6 shrink-0 ${isLightTheme ? 'bg-black/15' : 'bg-white/15'}`}
                  />
                  The console, up close
                </div>
                <h2 data-gsap-words className={`mt-5 font-garamond text-4xl sm:text-5xl font-normal text-white ${isLightTheme ? '!text-slate-900' : ''}`}>What you're actually running</h2>
                <p className={`homepage-just mx-auto mt-5 max-w-xl text-[15px] font-light leading-[1.7] ${isLightTheme ? 'text-slate-500' : 'text-white/[0.55]'}`}>
                  Four surfaces ship inside the console — the marketplace you pick models in, the
                  terminal you run them from, the vault that holds your keys, and the advisor that
                  routes a question to the right model.
                </p>
              </div>

              {/* Divider label — frames the engineering notes below */}
              <div className={`mt-20 flex items-center gap-5 ${isLightTheme ? 'text-slate-500' : 'text-white/[0.40]'}`}>
                <span className={`h-px flex-1 ${isLightTheme ? 'bg-black/[0.10]' : 'bg-white/[0.10]'}`} aria-hidden="true" />
                <span className="font-mono text-[9px] uppercase tracking-[0.3em]">
                  Under the hood
                </span>
                <span className={`h-px flex-1 ${isLightTheme ? 'bg-black/[0.10]' : 'bg-white/[0.10]'}`} aria-hidden="true" />
              </div>
              <p className={`font-playfair mx-auto mt-4 max-w-md text-center text-[14px] italic leading-[1.7] ${isLightTheme ? 'text-slate-500' : 'text-white/[0.45]'}`}>
                Four engineering decisions the console makes so you don't have to.
              </p>

              <div className="mt-10 grid gap-6 md:grid-cols-2" data-gsap-stagger>
                {HOMEPAGE_FEATURES.map((feature) => (
                  <HomepageFeatureCard
                    key={feature.index}
                    index={feature.index}
                    label={feature.label}
                    title={feature.title}
                    body={feature.body}
                    isLight={isLightTheme}
                  />
                ))}
              </div>
            </section>

            {/* Hairline rule between editorial sections — wipes in from center */}
            <hr
              aria-hidden="true"
              data-gsap-rule
              className={`w-full max-w-6xl border-0 border-t px-6 ${
                isLightTheme ? 'border-black/[0.08]' : 'border-white/[0.08]'
              }`}
            />

            {/* 3. SANDBOX DEMOS — request lifecycle, fallback, memory — typed out live */}
            <section
              id="architecture"
              data-section="project-architecture"
              data-gsap-reveal
              className="w-full max-w-6xl px-6 py-28"
            >
              <div className="text-center">
                <div className={`inline-flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.3em] ${isLightTheme ? 'text-slate-500' : 'text-white/[0.45]'}`}>
                  <span className={`tracking-[0.3em] ${isLightTheme ? 'text-slate-400' : 'text-white/[0.28]'}`}>
                    05
                  </span>
                  <span
                    aria-hidden="true"
                    className={`h-px w-6 shrink-0 ${isLightTheme ? 'bg-black/15' : 'bg-white/15'}`}
                  />
                  The engine room
                </div>
              </div>

              {/* Embedded Live Sandbox IDE Simulator */}
              <CodexSandboxSimulator isLight={isLightTheme} />
            </section>

            {/* 4. TRUST ARCHITECTURE — key custody, compute path, session scope */}
            <PlatformSecurity isLight={isLightTheme} />

            {/* 5. FAQ — native <details>, no accordion state */}
            <PlatformFAQ isLight={isLightTheme} />

            {/* 5.5. SATIRICAL PRICING */}
            <PlatformPricing isLight={isLightTheme} onBuy={open404} />

            {/* 6. CLOSING CTA */}
            <PlatformClosing
              isLight={isLightTheme}
              onAccess={handleLogin}
              onTour={() => scrollToSection('showcase')}
            />

            {/* 7. THANK-YOU RAIL — credits for the open-source work this leaned
                   on. Sits after the CTA and before the footer, which is where a
                   reader expects acknowledgements and where it cannot compete
                   with the conversion path above it. */}
            <PlatformThanks isLight={isLightTheme} />
          </>
          )
        ) : (
          <div className="w-full max-w-7xl px-5 pt-28 pb-20">
            {activeTab === 'marketplace' && (
              <MarketplaceSection
                catalog={catalog}
                onSelectModel={(m) => setSelectedHandoff(m)}
                activeModelId={activeModel.id}
                onGoToTerminal={() => setActiveTab('terminal')}
                onGoToVault={() => setActiveTab('vault')}
                backgroundVideoId={mBackgroundVideoId}
                weather={mWeather}
                onChangeWeather={setMWeather}
                onPreloadRequest={handlePreloadRequest}
                onRefreshCatalog={() => refreshCatalog(true)}
              />
            )}

            {activeTab === 'terminal' && (
              <TerminalSection
                activeModel={activeModel}
                setActiveModel={setActiveModel}
                catalog={catalog}
                onRefreshCatalog={() => refreshCatalog(true)}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
              />
            )}

            {activeTab === 'vault' && (
              <VaultSection
                keys={vaultKeys}
                setKeys={setVaultKeys}
                onSaveSuccess={refreshCatalog}
              />
            )}
          </div>
        )}

        {/* 5. FOOTER — landing gets the full sitemap footer, workspace keeps the thin bar */}
        {!isLoggedIn ? (
          <PlatformFooter onNavigate={footerNavigate} onAccess={handleLogin} />
        ) : (
          <HomepageReveal as="footer" className="w-full border-t border-white/5 py-16 px-6 text-center font-mono-display text-[10px] uppercase tracking-[0.3em] text-white/30 bg-black/40 backdrop-blur-md">
            <div className="mx-auto max-w-6xl flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                © 2026 ENZO
              </div>
              <div className="flex gap-6">
                <button type="button" onClick={() => scrollToSection('hero')} className="hover:text-white transition-colors">Wander</button>
                <span>Keys remain in local storage</span>
              </div>
            </div>
          </HomepageReveal>
        )}
      </div>


      {/* Lite-mode toggle (static background for low-end PCs) */}
      <LowPowerToggle />

      {/* ─── Handoff Modal ─── */}
      <HandoffModal
        model={selectedHandoff}
        onClose={() => setSelectedHandoff(null)}
        onLaunch={(m) => {
          // Explicit "Launch workspace": signal the terminal that this model was
          // deliberately chosen from the marketplace, so it mints a brand-new
          // session instead of restoring the user's previous conversation
          // (which otherwise happens on the terminal's fresh mount).
          try {
            window.sessionStorage.setItem('enzo.workspace.launched-model', m.id)
          } catch {
            /* ignore */
          }
          setActiveModel(m)
          setSelectedHandoff(null)
          setActiveTab('terminal')
        }}
      />

      {/* 🐴 ponytail: TourOverlay kept but not mounted — tour is parked
          (auto-trigger effect above is disabled too). Restore by reverting
          this guard and the effect guard. */}
      {false && showTour && (
        <TourOverlay
          onComplete={() => {
            localStorage.setItem('enzo.tour.dont-show-again', '1')
            setShowTour(false)
          }}
          onStepTab={setActiveTab}
        />
      )}

    </div>
  )
}




function CatalogAdvisor({
  onSelectModel,
  catalog
}: {
  onSelectModel: (m: CatalogModel) => void
  catalog: CatalogModel[]
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([
    { role: 'assistant', text: `Hey, I'm your ENZO advisor. Tell me what you're building or playing with and I'll suggest a good model for it. And if you're not sure yet, we can just chat about it.` }
  ])
  const [followUpText, setFollowUpText] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = window.setTimeout(() => {
      const end = chatEndRef.current
      const container = end?.parentElement
      if (end && container) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
      }
    }, 60)
    return () => window.clearTimeout(id)
  }, [messages, isLoading])

  // True multi-turn: the full conversation is sent on every request, so the user
  // can naturally ask follow-ups ("why that one?", "something cheaper?", "no, for my phone")
  // and the advisor answers with full context.
  const sendAdvisorQuery = async (userText: string) => {
    if (!userText.trim() || isLoading) return
    setIsOpen(true)
    // Snapshot history before appending the new user message — React state updates
    // are async, and the backend expects the user prompt passed separately.
    const history = messages.map(m => ({ role: m.role, content: m.text }))
    setMessages(prev => [...prev, { role: 'user', text: userText }])
    setIsLoading(true)

    try {
      // Pass vault keys in body so the backend can pick a working provider
      const keys = {
        nvidiaKey: keyVault.getItem('enzo-nvidia-key') || keyVault.getItem('enzo.keys.nvidia') || '',
        openrouterKey: keyVault.getItem('enzo.keys.openrouter') || '',
        providerKeys: {
          groq: keyVault.getItem('enzo.keys.groq') || '',
          openrouter: keyVault.getItem('enzo.keys.openrouter') || '',
          nvidia: keyVault.getItem('enzo.keys.nvidia') || '',
        },
      }
      const res = await fetch('/api/catalog-recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userText,
          messages: history,
          ...keys,
        })
      })
      if (res.ok) {
        const data = await res.json()
        setMessages(prev => [...prev, { role: 'assistant', text: data.reply }])
      } else {
        const errDetail = await res.text()
        throw new Error(errDetail)
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', text: `Advisor error: ${err.message || err}` }])
    } finally {
      setIsLoading(false)
    }
  }

  const handleFollowUpSubmit = () => {
    if (!followUpText.trim() || isLoading) return
    sendAdvisorQuery(followUpText)
    setFollowUpText('')
  }

  const hasConversation = messages.length > 1 || isLoading

  return (
    <div className="w-full max-w-2xl mx-auto font-mono-display flex flex-col items-center">
      {/* Expanded conversation log container */}
      <AnimatePresence>
        {isOpen && hasConversation && (
          <motion.div
            key="advisor-log"
            initial={{ height: 0, opacity: 0, marginBottom: 0 }}
            animate={{ height: 'auto', opacity: 1, marginBottom: 16 }}
            exit={{ height: 0, opacity: 0, marginBottom: 0 }}
            transition={{
              height: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.3, ease: 'easeOut' },
              marginBottom: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
            }}
            className="w-full rounded-3xl liquid-glass-panel shadow-2xl overflow-hidden border border-white/10 flex flex-col"
          >
            {/* Header with Title & Reset Chat button */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10 bg-white/[0.03]">
              <span className="text-[10px] uppercase tracking-widest text-emerald-400 font-bold">Catalog AI Advisor</span>
              <button
                type="button"
                onClick={() => {
                  setMessages([{ role: 'assistant', text: `Hey, I'm your ENZO advisor. Tell me what you're building or playing with and I'll suggest a good model for it. And if you're not sure yet, we can just chat about it.` }])
                  setIsOpen(false)
                }}
                className="text-[9px] uppercase tracking-widest text-white/40 hover:text-white/80 transition-colors font-bold cursor-pointer"
              >
                Reset Chat
              </button>
            </div>

            {/* Message log */}
            <div className="max-h-[280px] p-5 overflow-y-auto space-y-4 scrollbar-thin text-[12px] leading-relaxed scroll-smooth flex-1 border-b border-white/5">
              {messages.map((m, idx) => (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: 'easeOut' }}
                  className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`inline-block p-3.5 rounded-2xl border max-w-[85%] ${
                    m.role === 'user'
                      ? 'bg-white/10 border-white/15 text-white/95 rounded-br-sm backdrop-blur-md shadow-sm'
                      : 'bg-emerald-400/10 border-emerald-400/20 text-emerald-100 rounded-bl-sm backdrop-blur-md shadow-sm'
                  }`}>
                    {m.text}
                    {(() => {
                      const match = m.text.match(/"([^"]+)"/g)
                      if (match) {
                        const matchedModels = match
                          .map(s => s.replace(/"/g, ''))
                          .filter(id => catalog.some(cm => cm.id === id || cm.id.includes(id)))
                        if (matchedModels.length > 0) {
                          return (
                            <div className="mt-3 flex flex-col gap-1.5 border-t border-white/10 pt-2.5">
                              {matchedModels.map(id => {
                                const found = catalog.find(cm => cm.id === id || cm.id.includes(id))
                                if (!found) return null
                                return (
                                  <button
                                    key={id}
                                    type="button"
                                    onClick={() => onSelectModel(found)}
                                    className="w-full text-center liquid-glass py-2 rounded-xl text-[9px] uppercase tracking-widest font-bold text-white transition-all active:scale-[0.97]"
                                  >
                                    Launch {found.name}
                                  </button>
                                )
                              })}
                            </div>
                          )
                        }
                      }
                      return null
                    })()}
                  </div>
                </motion.div>
              ))}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="inline-flex items-center gap-2 p-3 rounded-2xl border border-white/5 bg-white/5 text-white/50">
                    <span className="flex gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-white/50 animate-[bounce_1s_infinite_0ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-white/50 animate-[bounce_1s_infinite_150ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-white/50 animate-[bounce_1s_infinite_300ms]" />
                    </span>
                    Thinking…
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Integrated follow-up typing area */}
            <div className="p-3 bg-white/[0.02] flex items-center gap-2">
              <input
                type="text"
                value={followUpText}
                onChange={(e) => setFollowUpText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleFollowUpSubmit()
                  }
                }}
                placeholder='Ask a follow-up… e.g. "why that one?", "something cheaper?"'
                disabled={isLoading}
                className="flex-1 bg-white/[0.04] border border-white/10 rounded-xl px-4 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-emerald-500/30 transition-colors disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleFollowUpSubmit}
                disabled={isLoading || !followUpText.trim()}
                className="px-4 py-2 bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 rounded-xl text-xs uppercase tracking-wider font-bold hover:bg-emerald-500/30 transition-colors disabled:opacity-30 disabled:pointer-events-none active:scale-[0.97] cursor-pointer"
              >
                Send
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* MorphPanel AI Input Advisor - only shown when there is no active conversation log */}
      {!hasConversation && (
        <MorphPanel
          onSubmitMessage={(msg) => sendAdvisorQuery(msg)}
          placeholder="Describe your workflow or goal to get an instant model recommendation…"
          label="Ask Catalog AI Advisor"
        />
      )}
    </div>
  )
}

// ─── Sub-Component: MarketplaceSection ───────────────────────────────────────────

function MarketplaceSection({
  catalog,
  onSelectModel,
  activeModelId,
  onGoToTerminal,
  onGoToVault,
  backgroundVideoId,
  weather,
  onChangeWeather,
  onRefreshCatalog,
}: {
  catalog: CatalogModel[]
  onSelectModel: (m: CatalogModel) => void
  activeModelId: string
  onGoToTerminal: () => void
  onGoToVault: () => void
  backgroundVideoId: string
  weather: WeatherType
  onChangeWeather: (weather: WeatherType) => void
  onPreloadRequest: (videoSrc: string) => void
  onRefreshCatalog?: () => Promise<void> | void
}) {
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [freeOnly, setFreeOnly] = useState<'All' | 'Free' | 'Paid'>('All')
  const [uncensoredOnly, setUncensoredOnly] = useState(false)
  const [onlineOnly, setOnlineOnly] = useState(false)
  const [sortBy, setSortBy] = useState<'name' | 'ctx' | 'free' | 'rec'>('free')
  const [page, setPage] = useState(1)

  // Auto Wallpaper (Unsplash) — persisted under enzo.wallpaper.* for AutoWallpaper
  const [wpAuto, setWpAuto] = useState(() => localStorage.getItem('enzo.wallpaper.auto') === 'true')
  const [wpQuery, setWpQuery] = useState(() => localStorage.getItem('enzo.wallpaper.query') || 'nature landscape 4k')
  const [wpInterval, setWpInterval] = useState(() => localStorage.getItem('enzo.wallpaper.interval') || 'daily')

  // First-run: a new user has never seen the cache key. Seed a wallpaper so the
  // layer paints before the periodic refresh resolves, but do NOT mark it fresh
  // (no `enzo.wallpaper.last` write) so the real fetch still fires immediately.

  // Set of model ids/names reported live by the backend, refreshed every 5 min
  // (same cadence as the per-card ping). Powers the "Online Only" filter.
  const [onlineKeys, setOnlineKeys] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    const refresh = async (force = false) => {
      try {
        const data = await fetchModelsShared(force)
        if (cancelled) return
        const keys = new Set<string>()
        for (const m of data) {
          if (m.id) keys.add(m.id)
          if (m.name) keys.add(m.name)
        }
        setOnlineKeys(keys)
      } catch {
        if (!cancelled) setOnlineKeys(new Set())
      }
    }
    refresh()
    const interval = setInterval(() => refresh(true), 5 * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const tasks = ['Reasoning', 'Coding', 'Creative', 'Vision', 'General Chat', 'Image Gen']
  const providers = ['Groq', 'OpenRouter', 'Pollinations', 'HuggingFace', 'NVIDIA', 'LLM7', 'Google', 'Puter', 'Cloudflare']

  // Reset page on search filter updates
  useEffect(() => {
    setPage(1)
  }, [search, selectedTask, selectedProvider, freeOnly, uncensoredOnly, onlineOnly])

  // Filter logic
  const filtered = useMemo(() => {
    let list = [...catalog]



    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q)
      )
    }

    if (selectedTask) {
      list = list.filter((m) => m.tags.includes(selectedTask))
    }

    if (selectedProvider) {
      list = list.filter((m) => m.provider === selectedProvider)
    }

    if (freeOnly === 'Free') {
      list = list.filter((m) => m.free)
    } else if (freeOnly === 'Paid') {
      list = list.filter((m) => !m.free)
    }

    if (uncensoredOnly) {
      list = list.filter((m) => m.tags.includes('Uncensored') || !m.moderated)
    }

    if (onlineOnly) {
      list = list.filter((m) => onlineKeys.has(m.id) || onlineKeys.has(m.name))
    }

    // Sort logic
    if (sortBy === 'ctx') {
      list.sort((a, b) => b.context_length - a.context_length)
    } else if (sortBy === 'free') {
      list.sort((a, b) => (a.free === b.free ? a.name.localeCompare(b.name) : a.free ? -1 : 1))
    } else if (sortBy === 'rec') {
      // Recommended: coding capable → reasoning → tool-calling (Coding tag covers
      // both) → vision → larger context → name. Scores follow real metadata only.
      const score = (m: CatalogModel): number => {
        const tags = m.tags || []
        let s = 0
        if (tags.includes('Coding')) s += 1000
        if (tags.includes('Reasoning')) s += 500
        if (tags.includes('Vision')) s += 200
        if (tags.includes('General Chat')) s += 50
        s += Math.min(m.context_length, 512000) / 512000
        return s
      }
      list.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name))
    }

    return list
  }, [catalog, search, selectedTask, selectedProvider, freeOnly, uncensoredOnly, onlineOnly, onlineKeys, sortBy])

  // Pagination bounds
  const modelsPerPage = 15
  const totalPages = Math.ceil(filtered.length / modelsPerPage)
  const paginatedModels = useMemo(() => {
    return filtered.slice((page - 1) * modelsPerPage, page * modelsPerPage)
  }, [filtered, page])

  return (
    <div className="space-y-10">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between items-start text-left">
        <div>
          <div className="font-mono-display text-[9px] uppercase tracking-[0.25em] text-white/40 mb-1">
            // 02 · Catalog
          </div>
          <h2 className="font-garamond text-3xl md:text-5xl font-normal text-white">
            Unified Catalog.
          </h2>
          <p className="font-light text-xs text-white/50 leading-relaxed mt-2 max-w-xl">
            Explore dynamic model routing across OpenRouter, Groq, Pollinations and Hugging Face. Select architectures directly.
          </p>
        </div>
        <div className="flex flex-col md:flex-row items-center gap-3">
          <button
            onClick={async () => {
              if (refreshing || !onRefreshCatalog) return
              setRefreshing(true)
              try {
                await onRefreshCatalog()
              } finally {
                setRefreshing(false)
              }
            }}
            disabled={refreshing}
            title="Clear cache & fetch fresh models from all providers"
            className="liquid-glass rounded-full px-5 py-2 font-mono-display text-[10px] uppercase tracking-widest text-white hover:bg-white/5 transition-all flex items-center gap-2 disabled:opacity-60 disabled:cursor-wait"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Syncing…' : 'Refresh'}
          </button>
          <button
            onClick={onGoToTerminal}
            className="liquid-glass rounded-full px-5 py-2 font-mono-display text-[10px] uppercase tracking-widest text-white hover:bg-white/5 transition-all"
          >
            Terminal →
          </button>
          {!(keyVault.getItem('enzo.keys.huggingface') || keyVault.getItem('enzo-huggingface-key')) && (
            <button
              onClick={onGoToVault}
              className="backdrop-blur-lg bg-gradient-to-tr from-transparent via-[rgba(121,121,121,0.16)] to-transparent rounded-md py-2 px-6 duration-700 font-mono-display text-[10px] uppercase tracking-widest text-white border border-cyan-400/40 shadow-[0_0_10px_rgba(34,211,238,0.25)] hover:border-cyan-300 hover:shadow-[0_0_16px_rgba(34,211,238,0.5)] transition-all animate-pulse"
            >
              Setup HuggingFace ↗
            </button>
          )}
          {!keyVault.getItem('enzo.keys.llm7') && (
            <button
              onClick={onGoToVault}
              className="liquid-glass rounded-full px-5 py-2 font-mono-display text-[10px] uppercase tracking-widest text-violet-300 hover:bg-white/5 transition-all"
              title="LLM7 models require a free token from dash.llm7.io — there is no anonymous tier."
            >
              Add LLM7 Key ↗
            </button>
          )}
          {!keyVault.getItem('enzo.keys.google') && !keyVault.getItem('enzo.keys.gemini') && (
            <button
              onClick={onGoToVault}
              className="liquid-glass rounded-full px-5 py-2 font-mono-display text-[10px] uppercase tracking-widest text-orange-300 hover:bg-white/5 transition-all"
              title="Google Gemini models require a free key from aistudio.google.com — no anonymous tier."
            >
              Add Google Key ↗
            </button>
          )}
          {!keyVault.getItem('enzo.keys.puter') && (
            <button
              onClick={onGoToVault}
              className="backdrop-blur-lg bg-gradient-to-tr from-transparent via-[rgba(121,121,121,0.16)] to-transparent rounded-md py-2 px-6 duration-700 font-mono-display text-[10px] uppercase tracking-widest text-white border border-cyan-400/40 shadow-[0_0_10px_rgba(34,211,238,0.25)] hover:border-cyan-300 hover:shadow-[0_0_16px_rgba(34,211,238,0.5)] transition-all"
              title="Puter models need an auth token from puter.com/dashboard (user-pays free monthly credits)."
            >
              Add Puter Token ↗
            </button>
          )}
          <input
            type="text"
            placeholder="Search catalog models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-tour-step="marketplace-search"
            className="rounded-full bg-white/5 border border-white/10 px-4 py-2 font-mono-display text-xs text-white placeholder:text-white/20 focus:border-white/30 focus:outline-none w-64 shadow-inner"
          />
          <div className="font-mono-display text-[9px] text-white/40">
            {filtered.length.toString().padStart(2, '0')} / {catalog.length} active
          </div>
        </div>
      </div>

      {/* Catalog Advisor — Claude-style chatbox at top */}
      <CatalogAdvisor
        onSelectModel={onSelectModel}
        catalog={catalog}
      />

      {/* Filter Sidebar + Grid */}
      <div className="grid gap-8 lg:grid-cols-[240px_1fr]">
        {/* Filters Panel */}
        <div className="mobile-menu-glass rounded-3xl p-5 border border-white/10 flex flex-col gap-6 self-start">
          {/* Task filter */}
          <div>
            <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50 mb-2">
              Task
            </div>
            <div className="flex flex-wrap gap-1.5">
              <FilterChip active={!selectedTask} onClick={() => setSelectedTask(null)}>
                All
              </FilterChip>
              {tasks.map((t) => (
                <FilterChip key={t} active={selectedTask === t} onClick={() => setSelectedTask(t)}>
                  {t}
                </FilterChip>
              ))}
            </div>
          </div>

          {/* Provider filter */}
          <div>
            <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50 mb-2">
              Provider
            </div>
            <div className="flex flex-wrap gap-1.5">
              <FilterChip active={!selectedProvider} onClick={() => setSelectedProvider(null)}>
                All
              </FilterChip>
              {providers.map((p) => (
                <FilterChip
                  key={p}
                  active={selectedProvider === p}
                  onClick={() => setSelectedProvider(p)}
                >
                  {p}
                </FilterChip>
              ))}
            </div>
          </div>

          {/* Pricing tier */}
          <div>
            <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50 mb-2">
              Pricing Tier
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(['All', 'Free', 'Paid'] as const).map((tier) => (
                <FilterChip key={tier} active={freeOnly === tier} onClick={() => setFreeOnly(tier)}>
                  {tier}
                </FilterChip>
              ))}
            </div>
          </div>

          {/* Extra option toggles */}
          <div className="border-t border-white/5 pt-4 space-y-3">
            <button
              onClick={() => setOnlineOnly(!onlineOnly)}
              className={`flex items-center gap-2 rounded-full px-3 py-1 font-mono-display text-[9px] uppercase tracking-widest transition-all border ${
                onlineOnly
                  ? 'border-green-500/40 text-green-400 bg-green-500/10 shadow-lg'
                  : 'border-white/10 text-white/60 hover:border-green-500/20 hover:text-green-400'
              }`}
            >
              <Wifi size={11} strokeWidth={2.5} className={onlineOnly ? 'text-green-400' : 'text-white/40'} />
              Online Only
            </button>

            <button
              onClick={() => setUncensoredOnly(!uncensoredOnly)}
              className={`flex items-center gap-2 rounded-full px-3 py-1 font-mono-display text-[9px] uppercase tracking-widest transition-all border ${
                uncensoredOnly
                  ? 'border-red-500/40 text-red-400 bg-red-500/10 shadow-lg'
                  : 'border-white/10 text-white/60 hover:border-red-500/20 hover:text-red-400'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${uncensoredOnly ? 'bg-red-400 animate-pulse' : 'bg-white/40'}`}
              />
              Uncensored Only
            </button>

            <div className="flex items-center gap-2">
              <span className="font-mono-display text-[9px] uppercase tracking-widest text-white/50">
                Sort:
              </span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="bg-transparent text-[9px] font-mono-display uppercase tracking-wider text-white border border-white/10 rounded-md px-2 py-0.5 focus:outline-none"
              >
                <option value="free" className="bg-[#0b0b0b]">Free First</option>
                <option value="rec" className="bg-[#0b0b0b]">Recommended</option>
                <option value="name" className="bg-[#0b0b0b]">Name</option>
                <option value="ctx" className="bg-[#0b0b0b]">Context Size</option>
              </select>
            </div>

            {/* Auto Wallpaper (Unsplash) settings */}
            <div className="border-t border-white/5 pt-4 space-y-3 text-left">
              <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50">
                Auto Wallpaper (Unsplash)
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = !wpAuto
                  setWpAuto(next)
                  localStorage.setItem('enzo.wallpaper.auto', next ? 'true' : 'false')
                  emitWallpaperChanged()
                }}
                className={`rounded-full px-3 py-1 font-mono-display text-[9px] uppercase tracking-wider transition-all border ${
                  wpAuto
                    ? 'bg-white border-white text-black shadow-inner font-semibold'
                    : 'border-white/10 text-white/60 hover:border-white/20 hover:text-white hover:bg-white/5'
                }`}
              >
                {wpAuto ? 'Wallpaper: On' : 'Wallpaper: Off'}
              </button>
              <div>
                <label className="font-mono-display text-[8px] uppercase tracking-wider text-white/40 block mb-1">
                  Query
                </label>
                <input
                  type="text"
                  value={wpQuery}
                  onChange={(e) => {
                    setWpQuery(e.target.value)
                    localStorage.setItem('enzo.wallpaper.query', e.target.value)
                  }}
                  placeholder="nature landscape 4k"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 font-mono-display text-[10px] text-white focus:outline-none focus:border-white/20 placeholder:text-white/25"
                />
              </div>
              <div>
                <label className="font-mono-display text-[8px] uppercase tracking-wider text-white/40 block mb-1">
                  Refresh
                </label>
                <select
                  value={wpInterval}
                  onChange={(e) => {
                    setWpInterval(e.target.value)
                    localStorage.setItem('enzo.wallpaper.interval', e.target.value)
                  }}
                  className="w-full bg-[#0d0d18]/60 border border-white/10 rounded-lg px-2.5 py-1.5 font-mono-display text-[10px] text-white focus:outline-none focus:border-white/20"
                >
                  <option value="visit" className="bg-[#0b0b0b]">Every visit</option>
                  <option value="hourly" className="bg-[#0b0b0b]">Hourly</option>
                  <option value="daily" className="bg-[#0b0b0b]">Daily</option>
                </select>
              </div>
            </div>

            {/* Environment Controller */}
            <div className="border-t border-white/5 pt-4 space-y-4 text-left">
              <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/30 select-none">
                Backdrop — use the selector on the right edge →
              </div>

              {/* Weather controls - only show for Default Particles (spring_day) */}
              {backgroundVideoId === 'spring_day' && (
                <div>
                  <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50 mb-2">
                    WebGL Weather
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(['clear', 'rain', 'snow', 'fog'] as const).map((w) => (
                      <FilterChip
                        key={w}
                        active={weather === w}
                        onClick={() => onChangeWeather(w)}
                      >
                        {w}
                      </FilterChip>
                    ))}
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>

        {/* Model cards grid */}
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {paginatedModels.map((m) => {
            const isActive = activeModelId === m.id
            return (
              <InteractiveModelCard
                key={m.id}
                model={m}
                isActive={isActive}
                onSelect={() => onSelectModel(m)}
                tourStep={m.id === catalog[0]?.id ? 'model-card' : undefined}
              />
            )
          })}
          {paginatedModels.length === 0 && (
            <div className="col-span-full py-16 text-center font-mono-display text-xs text-white/40 border border-white/5 rounded-3xl">
              No matching intelligence models found.
            </div>
          )}

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="col-span-full flex items-center justify-between border-t border-white/5 pt-6 mt-4">
              <button
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(p - 1, 1))}
                className="rounded-full bg-white/5 border border-white/10 px-5 py-2.5 font-mono-display text-[10px] uppercase tracking-widest text-white hover:bg-white/10 transition-all disabled:opacity-30"
              >
                ← Previous Page
              </button>
              <div className="font-mono-display text-[10px] text-white/40 uppercase tracking-widest">
                Page {page} / {totalPages}
              </div>
              <button
                disabled={page === totalPages}
                onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                className="rounded-full bg-white/5 border border-white/10 px-5 py-2.5 font-mono-display text-[10px] uppercase tracking-widest text-white hover:bg-white/10 transition-all disabled:opacity-30"
              >
                Next Page →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  onMouseEnter,
  onFocus,
  children,
}: {
  active: boolean
  onClick: () => void
  onMouseEnter?: () => void
  onFocus?: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onFocus={onFocus}
      className={`rounded-full px-2.5 py-0.5 font-mono-display text-[9px] uppercase tracking-wider transition-all border ${
        active
          ? 'bg-white border-white text-black shadow-inner font-semibold'
          : 'border-white/10 text-white/60 hover:border-white/20 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

function InteractiveModelCard({
  model,
  isActive,
  onSelect,
  tourStep,
}: {
  model: CatalogModel
  isActive: boolean
  onSelect: () => void
  tourStep?: string
}) {
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const rx = useSpring(useTransform(my, [-0.5, 0.5], [8, -8]), { stiffness: 120, damping: 12 })
  const ry = useSpring(useTransform(mx, [-0.5, 0.5], [-10, 10]), { stiffness: 120, damping: 12 })

  // Model activity ping state
  const [isOnline, setIsOnline] = useState<boolean | null>(null)
  const [isPinging, setIsPinging] = useState(false)

  // Check model availability using the shared, deduped models fetch so all
  // cards ride a single request instead of hammering the endpoint each.
  useEffect(() => {
    let cancelled = false

    const checkModel = async (force = false) => {
      if (!cancelled) setIsPinging(true)
      try {
        const data = await fetchModelsShared(force)
        if (cancelled) return
        const modelExists = data.some((m: any) => m.id === model.id || m.name === model.name)
        setIsOnline(modelExists)
      } catch {
        // If backend is unreachable, assume offline
        if (!cancelled) setIsOnline(false)
      } finally {
        if (!cancelled) setIsPinging(false)
      }
    }

    checkModel()

    // Re-ping every 5 minutes; force a fresh fetch so the check reflects live
    // availability rather than a stale short-lived cache entry.
    const interval = setInterval(() => checkModel(true), 5 * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [model.id, model.name])

  const handle = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    mx.set((e.clientX - r.left) / r.width - 0.5)
    my.set((e.clientY - r.top) / r.height - 0.5)
  }

  const reset = () => {
    mx.set(0)
    my.set(0)
  }

  const [isHovered, setIsHovered] = useState(false)

  const providerColor: Record<CatalogModel['provider'], string> = {
    Groq: 'text-cyan-400',
    OpenRouter: 'text-pink-400',
    Pollinations: 'text-yellow-400',
    HuggingFace: 'text-sky-400',
    NVIDIA: 'text-green-400',
    LLM7: 'text-violet-400',
    Google: 'text-orange-400',
    Puter: 'text-emerald-400',
    Cloudflare: 'text-indigo-400',
  }

  const friendlyType: Record<string, string> = {
    text: 'Text',
    multimodal: 'Multimodal',
    'image-gen': 'Image Gen',
  }

  const TAG_COLORS: Record<string, string> = {
    'General Chat': 'bg-white/[0.04] text-white/70 border-white/10',
    Reasoning: 'bg-violet-500/15 text-violet-300 border-violet-500/25',
    Coding: 'bg-sky-500/15 text-sky-300 border-sky-500/25',
    Vision: 'bg-green-500/15 text-green-300 border-green-500/25',
    'Image Gen': 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/25',
    Creative: 'bg-rose-500/15 text-rose-300 border-rose-500/25',
    Fast: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
    Uncensored: 'bg-red-500/15 text-red-300 border-red-500/25',
    New: 'bg-yellow-400/15 text-yellow-300 border-yellow-400/25',
    Multilingual: 'bg-teal-500/15 text-teal-300 border-teal-500/25',
  }

  const getCardTelemetry = (m: CatalogModel) => {
    const name = m.name.toLowerCase()
    const id = m.id.toLowerCase()

    let speed = 'Moderate'
    let strengths = 'General Chat, QA'
    let weaknesses = 'Complex reasoning'

    if (id.includes('llama-3.3') || id.includes('70b') || name.includes('70b')) {
      speed = 'Fast (LPU/GPU accelerated)'
      strengths = 'Complex reasoning, math synthesis, logic checks'
      weaknesses = 'Time-to-first-token is slightly higher than 8B'
    } else if (id.includes('8b') || name.includes('8b') || id.includes('3b') || name.includes('3b')) {
      speed = 'Ultra-Fast (Under 10ms latency)'
      strengths = 'General instructions, spelling check, outline drafts'
      weaknesses = 'Deep coding loops, complex logical proofs'
    } else if (id.includes('deepseek') || name.includes('deepseek') || id.includes('r1')) {
      speed = 'Deep Thinking (COT thinking cycle)'
      strengths = 'Logical debugging, step-by-step math proofing'
      weaknesses = 'Slow response time due to reasoning chain'
    } else     if (id.includes('qwen') || name.includes('qwen')) {
      speed = 'Fast'
      strengths = 'Exceptional multilingual coding, script files'
      weaknesses = 'Verbosity in short-answer prompts'
    } else if (id.includes('codestral') || name.includes('codestral') || id.includes('gpt-oss') || name.includes('gpt-oss')) {
      speed = 'Fast'
      strengths = 'Coding, codegen, debugging, instruction following'
      weaknesses = 'Narrower general knowledge than flagship models'
    } else if (id.includes('minimax') || name.includes('minimax')) {
      speed = 'Moderate'
      strengths = 'Agentic, long-context reasoning'
      weaknesses = 'Slower for trivial single-shot replies'
    }

    return { speed, strengths, weaknesses }
  }

  return (
    <motion.div
      onMouseMove={handle}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        reset()
        setIsHovered(false)
      }}
      style={{ rotateX: rx, rotateY: ry, transformStyle: 'preserve-3d' }}
      data-tour-step={tourStep}
      className={`group relative rounded-2xl p-5 border transition-all backdrop-blur-md ${
        isActive
          ? 'bg-white/[0.08] border-white/30 shadow-lg'
          : 'bg-black/[0.06] border-white/5 hover:border-white/15'
      }`}
    >
      {/* Interactive Telemetry Card Hover Tooltip */}
      <AnimatePresence>
        {isHovered && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 6 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute bottom-full left-0 mb-3 w-[290px] bg-[#0c0d14]/95 border border-white/20 rounded-xl p-4 shadow-[0_20px_50px_rgba(0,0,0,0.9)] backdrop-blur-2xl text-xs space-y-3 z-50 select-none text-left pointer-events-none"
          >
            <div>
              <div className="text-[9px] uppercase tracking-widest text-white/40">Model Telemetry</div>
              <div className="text-sm font-semibold text-white mt-0.5 truncate">{model.name}</div>
              <div className="text-[10px] text-white/50 mt-0.5">{model.provider} · {model.free ? 'FREE' : 'PAID'}</div>
            </div>

            {/* Provider Key Setup / Credentials status */}
            {(() => {
              const prov = (model.provider || '').toLowerCase()
              const isHf = prov === 'huggingface' || prov === 'hf' || model.id.startsWith('hf/')
              const isNvidia = prov === 'nvidia' || model.id.startsWith('nvidia/')
              const isOr = prov === 'openrouter' || model.id.startsWith('openrouter/')
              const isLlm7 = prov === 'llm7' || prov === 'llm7.io' || model.id.startsWith('llm7/')
              const isGoogle = prov === 'google' || prov === 'gemini' || model.id.startsWith('google/')
              const isPuter = prov === 'puter' || model.id.startsWith('puter/')
              const isCloudflare = prov === 'cloudflare' || model.id.startsWith('cloudflare/')

              let keyStatus: { hasKey: boolean; name: string; isOptional?: boolean } | null = null
              if (isHf) {
                const hasKey = !!(keyVault.getItem('enzo.keys.huggingface') || keyVault.getItem('enzo-huggingface-key'))
                keyStatus = { hasKey, name: 'Hugging Face' }
              } else if (isNvidia) {
                const hasKey = !!(keyVault.getItem('enzo.keys.nvidia') || keyVault.getItem('enzo-nvidia-key'))
                keyStatus = { hasKey, name: 'NVIDIA NIM' }
              } else if (isOr) {
                const hasKey = !!(keyVault.getItem('enzo.keys.openrouter') || keyVault.getItem('enzo-openrouter-key'))
                keyStatus = { hasKey, name: 'OpenRouter' }
              } else if (isLlm7) {
                const hasKey = !!keyVault.getItem('enzo.keys.llm7')
                keyStatus = { hasKey, name: 'LLM7' }
              } else if (isGoogle) {
                const hasKey = !!keyVault.getItem('enzo.keys.google')
                keyStatus = { hasKey, name: 'Google' }
              } else if (isPuter) {
                const hasKey = !!keyVault.getItem('enzo.keys.puter')
                keyStatus = { hasKey, name: 'Puter' }
              } else if (isCloudflare) {
                const hasKey = !!keyVault.getItem('enzo.keys.cloudflare')
                keyStatus = { hasKey, name: 'Cloudflare' }
              }

              if (!keyStatus) return null

              return (
                <div className={`p-1.5 rounded border text-[9px] font-mono ${
                  keyStatus.hasKey
                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                    : keyStatus.isOptional
                      ? 'bg-white/5 border-white/10 text-white/50'
                      : 'bg-amber-500/10 border-amber-500/20 text-amber-200'
                }`}>
                  <span>{keyStatus.name}: {keyStatus.hasKey ? '✓ Active' : keyStatus.isOptional ? '⚠️ Optional (anonymous free tier)' : '⚠️ Missing Key'}</span>
                </div>
              )
            })()}

            <div className="space-y-2 pt-2 border-t border-white/[0.06] text-[10px]">
              {model.health && (
                <div>
                  <span className="text-[8px] uppercase tracking-wider text-white/30 block">Health</span>
                  <span className={`font-medium ${model.health.status === 'online' ? 'text-emerald-400' : model.health.status === 'degraded' ? 'text-amber-400' : model.health.status === 'offline' ? 'text-red-400' : 'text-white/50'}`}>
                    {modelHealthState(model.health)} · checked {timeAgo(model.health.checkedAt)}
                  </span>
                </div>
              )}
              <div>
                <span className="text-[8px] uppercase tracking-wider text-white/30 block">Latency / Speed</span>
                <span className="text-white/80 font-medium">
                  {model.health && (model.health.status === 'online' || model.health.status === 'degraded')
                    ? `Measured ${formatLatency(model.health.latencyMs)} (real probe)`
                    : getCardTelemetry(model).speed}
                </span>
              </div>
              <div>
                <span className="text-[8px] uppercase tracking-wider text-white/30 block">Key Strengths</span>
                <span className="text-white/80 leading-relaxed block">{getCardTelemetry(model).strengths}</span>
              </div>
              <div>
                <span className="text-[8px] uppercase tracking-wider text-white/30 block">Limitations</span>
                <span className="text-white/80 leading-relaxed block">{getCardTelemetry(model).weaknesses}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Activity Ping Indicator + measured latency */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        {model.health && (model.health.status === 'online' || model.health.status === 'degraded') && (
          <span
            title={`live ${modelHealthState(model.health)} · checked ${timeAgo(model.health.checkedAt)}`}
            className={`font-mono text-[9px] font-bold ${model.health.status === 'online' ? 'text-emerald-400/90' : 'text-amber-400/90'}`}
          >
            {formatLatency(model.health.latencyMs)}
          </span>
        )}
        {isPinging ? (
          <span className="w-2 h-2 rounded-full bg-yellow-400/50 animate-pulse" />
        ) : (
          <>
            <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-400' : 'bg-red-400'}`} />
            {isOnline && (
              <span className="absolute w-2 h-2 rounded-full bg-green-400 animate-ping opacity-75" />
            )}
          </>
        )}
      </div>

      <div className="flex items-start justify-between" style={{ transform: 'translateZ(30px)' }}>
        <div>
          <div className={`font-mono-display text-[9px] uppercase tracking-widest ${providerColor[model.provider]}`}>
            {model.provider}
          </div>
          <div className="mt-1 font-sans font-bold text-lg truncate max-w-[150px] text-white" title={model.name}>
            {model.name}
          </div>
        </div>
        <span className={`px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-widest rounded-md ${
          model.free ? 'bg-yellow-400/10 text-yellow-400 border border-yellow-400/20' : 'bg-white/10 text-white/50'
        }`}>
          {model.free ? 'FREE' : model.pricing_prompt}
        </span>
      </div>

      <p className="mt-3 text-xs font-sans font-medium text-white/80 leading-relaxed line-clamp-2 h-8" style={{ transform: 'translateZ(20px)' }}>
        {model.description}
      </p>

      {/* Attributes grid */}
      <div className="mt-4 grid grid-cols-2 gap-2 font-sans text-[9px] uppercase tracking-widest" style={{ transform: 'translateZ(20px)' }}>
        <div className="border border-white/5 rounded-lg px-2 py-1 bg-white/[0.01]">
          <span className="text-white/40 text-[7px] block font-semibold">Context</span>
          <span className="text-white font-bold">{model.context_length > 0 ? `${(model.context_length / 1000).toFixed(0)}K` : '—'}</span>
        </div>
        <div className="border border-white/5 rounded-lg px-2 py-1 bg-white/[0.01]">
          <span className="text-white/40 text-[7px] block font-semibold">Type</span>
          <span className="text-white font-bold truncate block">{friendlyType[model.type] || model.type}</span>
        </div>
      </div>

      {/* Classification tags */}
      {Array.isArray(model.tags) && model.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1" style={{ transform: 'translateZ(20px)' }}>
          {model.tags
            .filter((t) => t !== 'Puter' && t !== 'Free' && t !== 'Cloudflare')
            .map((tag) => (
              <span
                key={tag}
                className={`px-1.5 py-0.5 font-mono-display text-[7px] uppercase tracking-wider rounded border ${
                  TAG_COLORS[tag] || 'bg-white/[0.04] text-white/70 border-white/10'
                }`}
              >
                {tag}
              </span>
            ))}
        </div>
      )}

      <button
        onClick={onSelect}
        style={{ transform: 'translateZ(40px)' }}
        className="mt-5 w-full border-t border-white/5 pt-3 font-mono-display text-[10px] uppercase tracking-widest text-white/60 hover:text-white transition-colors text-left flex justify-between items-center"
      >
        <span>Launch workspace</span>
        <ArrowRight size={10} />
      </button>
    </motion.div>
  )
}

// ─── Sub-Component: VaultSection ───────────────────────────────────────────────

function VaultSection({
  keys,
  setKeys,
  onSaveSuccess,
}: {
  keys: Record<string, string>
  setKeys: (k: Record<string, string>) => void
  onSaveSuccess?: () => Promise<void>
}) {
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState(false)

  // Passphrase mode. keyVault holds the real state; these mirror it for render.
  const [ppOn, setPpOn] = useState(keyVault.hasPassphrase())
  const [ppForm, setPpForm] = useState<'on' | 'off' | null>(null)
  const [ppInput, setPpInput] = useState('')
  const [ppConfirm, setPpConfirm] = useState('')
  const [ppBusy, setPpBusy] = useState(false)
  const [ppNote, setPpNote] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null)

  const providers: { id: string; label: string; placeholder: string; link: string }[] = [
    { id: 'openrouter', label: 'OpenRouter Aggregator', placeholder: 'sk-or-v1-…', link: 'https://openrouter.ai/keys' },
    { id: 'huggingface', label: 'Hugging Face Hub', placeholder: 'hf_…', link: 'https://huggingface.co/settings/tokens' },
    { id: 'nvidia', label: 'NVIDIA NIM Catalog', placeholder: 'nvapi-…', link: 'https://build.nvidia.com' },
    { id: 'groq', label: 'Groq Cloud Platform', placeholder: 'gsk_…', link: 'https://console.groq.com/keys' },
    { id: 'exa', label: 'Exa Web Search Index', placeholder: 'exa-api-key-…', link: 'https://dashboard.exa.ai' },
    { id: 'llm7', label: 'LLM7 API', placeholder: 'paste token from dash.llm7.io', link: 'https://dash.llm7.io' },
    { id: 'google', label: 'Google AI Studio (Gemini)', placeholder: 'AIza…', link: 'https://aistudio.google.com/apikey' },
    { id: 'puter', label: 'Puter.js Gateway', placeholder: 'puter-auth-token', link: 'https://puter.com/dashboard' },
    { id: 'cloudflare', label: 'Cloudflare Workers AI', placeholder: 'API token (dash.cloudflare.com/profile/api-tokens)', link: 'https://dash.cloudflare.com/profile/api-tokens' },
    { id: 'cloudflareAccount', label: 'Cloudflare Account ID', placeholder: 'account id — auto-detected if blank', link: 'https://dash.cloudflare.com' },
  ]

  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [testState, setTestState] = useState<Record<string, { testing?: boolean; valid?: boolean; detail?: string }>>({})

  const handleTestKey = async (provider: string, value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    setTestState((prev) => ({ ...prev, [provider]: { testing: true } }))
    try {
      const res = await fetch('/api/vault/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key: trimmed }),
      })
      const data = await res.json()
      setTestState((prev) => ({
        ...prev,
        [provider]: { valid: data?.valid === true, detail: data?.detail },
      }))
    } catch {
      setTestState((prev) => ({ ...prev, [provider]: { valid: false, detail: 'Test request failed' } }))
    }
  }

  // Both directions re-seal every stored key under the new master before the old
  // one is deleted, so the only failure mode left is "IndexedDB is unavailable",
  // which keyVault reports by throwing.
  const applyPassphraseMode = async (turnOn: boolean) => {
    setPpBusy(true)
    setPpNote(null)
    try {
      if (turnOn) {
        if (ppInput !== ppConfirm) throw new Error('The two passphrases do not match.')
        // The rule lives in keyVault.passcodeError — the old `length < 8` here
        // accepted "password" as an 8-character secret.
        const rejected = keyVault.passcodeError(ppInput)
        if (rejected) throw new Error(rejected)
        await keyVault.enablePassphrase(ppInput)
        // Sealed only after the passcode is live, so a failed enable never leaves
        // a recovery file for a passcode that was never set. Same order as
        // components/VaultGate.tsx.
        const file = downloadRecovery(await sealRecovery(ppInput))
        setPpNote({
          kind: 'ok',
          text: `✓ Keys re-sealed. Recovery file ${file} saved to your downloads — keep it somewhere safe and private, it can open this vault on its own. You will be asked for this passcode next time ENZO loads.`,
        })
      } else {
        await keyVault.disablePassphrase()
        setPpNote({ kind: 'ok', text: '✓ Back to this-device encryption. No prompt on load, and any recovery file you saved is now dead — delete it.' })
      }
      setPpOn(turnOn)
      setPpForm(null)
      setPpInput('')
      setPpConfirm('')
    } catch (e) {
      setPpNote({ kind: 'err', text: e instanceof Error ? e.message : 'Could not change passphrase mode.' })
    } finally {
      setPpBusy(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)

    try {
      // 1. Source of truth: the user's device store (hosted/BYOK mode). Keys
      // never need to leave the browser — they're sent per-request with chat.
      const stored = saveProviderKeys(keys)

      // 2. Opportunistic server .env sync — only meaningful for self-hosted
      // single-operator setups that still run with server-side keys + a mintable
      // session token. On a keyless public host the token can't mint, so the
      // device store above is final and that's expected — never a silent lie.
      let envSaved = false
      // A previous failed mint may have flagged mintBlocked — invalidate it and
      // any stale cached token so THIS save re-attempts server sync cleanly.
      sessionStorage.removeItem('enzo.vault.mintBlocked')
      sessionStorage.removeItem('enzo.vault.token')
      const vaultToken = await mintVaultToken()
      if (vaultToken) {
        try {
          const res = await fetch('/api/vault/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-vault-token': vaultToken },
            body: JSON.stringify({ keys }),
          })
          const data = await res.json()
          if (data.success) {
            envSaved = true
            if (onSaveSuccess) {
              await onSaveSuccess()
            }
          }
        } catch {
          /* server sync unavailable — device copy is authoritative */
        }
      }

      if (stored.length === 0) {
        setSavedMsg('Keys cleared from this device')
      } else if (envSaved) {
        setSavedMsg('✓ Saved on this device + server .env / catalog refreshed')
      } else {
        setSavedMsg(`✓ Saved on this device (${stored.length} key${stored.length === 1 ? '' : 's'}) — server runs BYOK`)
      }
    } finally {
      setSaving(false)
      setSaved(true)
      setTimeout(() => {
        setSaved(false)
        setSavedMsg('')
      }, 3000)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="font-mono-display text-[9px] uppercase tracking-[0.25em] text-white/40">
          // 03 · Lockbox
        </div>
        <h2 className="mt-1 font-garamond text-3xl font-normal md:text-5xl text-white">
          Developer Key Vault.
        </h2>
        <p className="mt-2 max-w-xl font-light text-xs text-white/50 leading-relaxed">
          Bring your own developer tokens to bypass pooled access quotas. Secrets are encrypted with AES-256-GCM and stay inside your local browser context.
        </p>
      </div>

      <div className="mobile-menu-glass rounded-3xl border border-white/10 overflow-hidden">
        {/* Header bar */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5 bg-white/[0.02]">
          <div className="flex items-center gap-2 font-mono-display text-[10px] uppercase tracking-widest text-white/70">
            <Lock size={12} className="text-yellow-400" />
            <span>vault.enzo://local-encryption</span>
          </div>
          <span
            className={`font-mono-display text-[9px] uppercase tracking-widest ${
              keyVault.isEncrypted() ? 'text-white/30' : 'text-amber-400/70'
            }`}
          >
            {!keyVault.isEncrypted()
              ? 'unencrypted — indexeddb blocked'
              : ppOn
                ? 'aes-256-gcm · passphrase'
                : 'aes-256-gcm · this device'}
          </span>
        </div>

        {/* Inputs */}
        <div className="divide-y divide-white/5">
          {providers.map((p) => (
            <div key={p.id} className="grid md:grid-cols-[200px_1fr_auto] items-center gap-4 px-5 py-4">
              <div className="font-mono-display text-xs uppercase tracking-widest text-white/80">
                {p.label}
              </div>
              <div className="relative w-full">
                <input
                  type={reveal[p.id] ? 'text' : 'password'}
                  value={keys[p.id] ?? ''}
                  onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })}
                  placeholder={p.placeholder}
                  data-tour-step={p.id === 'openrouter' ? 'vault-key-input' : undefined}
                  className="w-full rounded-lg bg-white/5 border border-white/10 px-4 py-2 font-mono-display text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-white/20"
                />
                {testState[p.id] && !testState[p.id]?.testing && (
                  <span
                    className={`mt-1 block font-mono-display text-[9px] uppercase tracking-widest ${
                      testState[p.id]?.valid ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {testState[p.id]?.valid ? '✓ key valid' : `✗ ${testState[p.id]?.detail || 'invalid key'}`}
                  </span>
                )}
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => handleTestKey(p.id, keys[p.id] ?? '')}
                  disabled={!((keys[p.id] ?? '').trim()) || testState[p.id]?.testing === true}
                  title={testState[p.id]?.detail}
                  className="rounded-full bg-white/5 px-3 py-1.5 font-mono-display text-[9px] uppercase tracking-widest text-white hover:bg-white/10 transition-all disabled:opacity-40 cursor-pointer"
                >
                  {testState[p.id]?.testing ? 'Testing…' : 'Test'}
                </button>
                <a
                  href={p.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Get ${p.label} key`}
                  className="rounded-full border border-white/10 px-3 py-1.5 font-mono-display text-[9px] uppercase tracking-widest text-white/50 hover:text-white hover:border-white/25 transition-all"
                >
                  Get Token ↗
                </a>
                <button
                  onClick={() => setReveal({ ...reveal, [p.id]: !reveal[p.id] })}
                  className="rounded-full bg-white/5 px-3 py-1.5 font-mono-display text-[9px] uppercase tracking-widest text-white hover:bg-white/10 transition-all"
                >
                  {reveal[p.id] ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Passphrase mode — opt-in. Default is a key this browser holds and
            cannot export, so this row is the only place it is ever mentioned. */}
        <div className="space-y-3 border-t border-white/10 px-5 py-4 bg-white/[0.01]">
          {/* The nudge to set one, here in the vault rather than over the
              homepage. No sign-in check needed: this section only renders once
              sign-up is done (activeTab === 'vault' is behind isLoggedIn), so
              the only conditions left are "has keys" and "no passcode yet" —
              anything earlier is a prompt about nothing. */}
          {!ppOn && !ppForm && keyVault.isEncrypted() && keyVault.hasStoredKeys() && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
              <p className="max-w-xl font-light text-[11px] leading-relaxed text-amber-200/75">
                <span className="font-mono-display text-[9px] uppercase tracking-widest text-amber-300">Recommended · </span>
                Set a passcode to protect these keys. They are encrypted already, but anything that can run script in this browser can still open them — with a passcode, nothing can read them without you. A {RECOVERY_EXT} recovery file downloads at the same time; keep it safe and it is your way back if you forget the passcode.
              </p>
              <button
                onClick={() => { setPpNote(null); setPpForm('on') }}
                disabled={ppBusy}
                className="rounded-full bg-amber-400/15 px-4 py-1.5 font-mono-display text-[9px] uppercase tracking-widest text-amber-200 hover:bg-amber-400/25 transition-all disabled:opacity-40 cursor-pointer"
              >
                Set passcode
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-xl">
              <div className="flex items-center gap-2 font-mono-display text-[10px] uppercase tracking-widest text-white/80">
                <span>Passphrase lock</span>
                {ppOn && <span className="text-emerald-400">· on</span>}
              </div>
              <p className="mt-1 font-light text-[11px] leading-relaxed text-white/45">
                {ppOn
                  ? 'Your keys are sealed with your passphrase. Nothing left on this device can open them without it, so you type it once each time you open ENZO. The recovery file you saved is the way back if you forget it.'
                  : `Your keys are already encrypted with a key this browser holds and cannot hand out — no prompt, nothing to remember. Turn this on to seal them with a passphrase instead, so nothing usable stays on disk at all. A ${RECOVERY_EXT} recovery file downloads at the same time, and it is the only way back if you forget the passphrase.`}
              </p>
            </div>
            <button
              onClick={() => {
                setPpNote(null)
                setPpForm(ppForm ? null : ppOn ? 'off' : 'on')
              }}
              disabled={ppBusy || !keyVault.isEncrypted()}
              title={keyVault.isEncrypted() ? undefined : 'Needs IndexedDB, which this browser context has disabled.'}
              className="rounded-full bg-white/5 px-4 py-1.5 font-mono-display text-[9px] uppercase tracking-widest text-white hover:bg-white/10 transition-all disabled:opacity-40 cursor-pointer"
            >
              {ppForm ? 'Cancel' : ppOn ? 'Turn off' : 'Turn on'}
            </button>
          </div>

          {ppForm === 'on' && (
            <form
              onSubmit={(e) => { e.preventDefault(); void applyPassphraseMode(true) }}
              className="flex flex-wrap items-center gap-2"
            >
              <input
                type="password"
                autoFocus
                value={ppInput}
                onChange={(e) => setPpInput(e.target.value)}
                placeholder="8-digit passcode, or a 12+ char passphrase"
                className="min-w-[200px] flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono-display text-[11px] text-white placeholder:text-white/25 outline-none focus:border-white/25"
              />
              <input
                type="password"
                value={ppConfirm}
                onChange={(e) => setPpConfirm(e.target.value)}
                placeholder="Confirm"
                className="min-w-[160px] flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 font-mono-display text-[11px] text-white placeholder:text-white/25 outline-none focus:border-white/25"
              />
              <button
                type="submit"
                disabled={ppBusy || !ppInput}
                className="liquid-glass rounded-full px-5 py-2 font-mono-display text-[10px] uppercase tracking-widest text-white/90 disabled:opacity-50 cursor-pointer"
              >
                {ppBusy ? 'Sealing…' : 'Seal vault'}
              </button>
            </form>
          )}

          {ppForm === 'off' && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5">
              <span className="font-light text-[11px] text-white/55">
                This puts the encryption key back on this device. Keys stay encrypted; the prompt goes away.
              </span>
              <button
                onClick={() => void applyPassphraseMode(false)}
                disabled={ppBusy}
                className="rounded-full bg-white/10 px-4 py-1.5 font-mono-display text-[9px] uppercase tracking-widest text-white hover:bg-white/20 transition-all disabled:opacity-50 cursor-pointer"
              >
                {ppBusy ? 'Re-sealing…' : 'Confirm'}
              </button>
            </div>
          )}

          {ppNote && (
            <div
              className={`font-mono-display text-[10px] ${
                ppNote.kind === 'err' ? 'text-red-400' : 'text-emerald-400'
              }`}
            >
              {ppNote.text}
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center justify-between border-t border-white/10 px-5 py-4 bg-white/[0.01]">
          <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/40">
            {saved ? (savedMsg || '✓ Keys saved on this device') : 'Keys are stored locally on this device and sent per-request'}
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            data-tour-step="vault-save"
            className="liquid-glass rounded-full px-6 py-2.5 font-mono-display text-xs uppercase tracking-widest text-white/90 disabled:opacity-50 flex items-center gap-2 cursor-pointer"
          >
            {saving ? 'Saving…' : 'Save Lockbox'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-Component: HandoffModal ────────────────────────────────────────────────

const HANDOFF_STEPS = [
  'Verifying key vault credentials…',
  'Negotiating handshake protocol…',
  'Initializing cognitive container cache…',
  'Mapping default model config…',
  'Routing thought vectors to processor…',
  'Connection successful.',
]

function HandoffModal({
  model,
  onClose,
  onLaunch,
}: {
  model: CatalogModel | null
  onClose: () => void
  onLaunch: (m: CatalogModel) => void
}) {
  const [stepIdx, setStepIdx] = useState(0)
  const [keyInput, setKeyInput] = useState('')
  const [keySaved, setKeySaved] = useState(false)

  useEffect(() => {
    if (!model) return
    setStepIdx(0)
    setKeyInput('')
    setKeySaved(false)
    const interval = setInterval(() => {
      setStepIdx((prev) => {
        if (prev < HANDOFF_STEPS.length - 1) {
          return prev + 1
        }
        clearInterval(interval)
        return prev
      })
    }, 450)
    return () => clearInterval(interval)
  }, [model])

  const getProviderInfo = (m: CatalogModel) => {
    const prov = (m.provider || '').toLowerCase()
    const isHf = prov === 'huggingface' || prov === 'hf' || m.id.startsWith('hf/')
    const isNvidia = prov === 'nvidia' || m.id.startsWith('nvidia/')
    const isOr = prov === 'openrouter' || m.id.startsWith('openrouter/')
    const isGroq = prov === 'groq' || m.id.startsWith('groq/')
    const isLlm7 = prov === 'llm7' || m.id.startsWith('llm7/')
    const isGoogle = prov === 'google' || prov === 'gemini' || m.id.startsWith('google/')
    const isPuter = prov === 'puter' || m.id.startsWith('puter/')

    if (isGoogle) {
      const key = keyVault.getItem('enzo.keys.google') || keyVault.getItem('enzo.keys.gemini') || ''
      return {
        id: 'google',
        name: 'Google AI Studio (Gemini)',
        hasKey: !!key || keySaved,
        instruction: 'Google Gemini models require a free API key from Google AI Studio — no anonymous tier. Free Flash-tier models (~5–15 req/min) work without billing.',
        placeholder: 'AIza...',
        tokenUrl: 'https://aistudio.google.com/apikey',
        tokenUrlText: 'Get Free Key at aistudio.google.com ↗',
        storageKey: 'enzo.keys.google',
        aliasKey: 'enzo.keys.gemini',
      }
    }

    if (isPuter) {
      const key = keyVault.getItem('enzo.keys.puter') || ''
      return {
        id: 'puter',
        name: 'Puter.js Gateway',
        hasKey: !!key || keySaved,
        instruction: 'Puter is a user-pays gateway (free monthly credits) — create an auth token in your Puter dashboard to unlock GPT/Claude/Gemini/Qwen models.',
        placeholder: 'puter-auth-token',
        tokenUrl: 'https://puter.com/dashboard',
        tokenUrlText: 'Create Token at puter.com/dashboard ↗',
        storageKey: 'enzo.keys.puter',
      }
    }

    if (isLlm7) {
      const key = keyVault.getItem('enzo.keys.llm7') || ''
      return {
        id: 'llm7',
        name: 'LLM7 API',
        hasKey: !!key || keySaved,
        instruction: 'LLM7 models require a free token from dash.llm7.io — there is no anonymous tier (the gateway serves a rotating shared model without one).',
        placeholder: 'paste token from dash.llm7.io',
        tokenUrl: 'https://dash.llm7.io',
        tokenUrlText: 'Get Free Token at dash.llm7.io ↗',
        storageKey: 'enzo.keys.llm7',
      }
    }

    if (isHf) {
      const key = keyVault.getItem('enzo.keys.huggingface') || keyVault.getItem('enzo-huggingface-key') || ''
      return {
        id: 'huggingface',
        name: 'Hugging Face Hub',
        hasKey: !!key || keySaved,
        instruction: 'Free Hugging Face serverless models require an access token (with Inference scope).',
        placeholder: 'hf_...',
        tokenUrl: 'https://huggingface.co/settings/tokens',
        tokenUrlText: 'Get Token at huggingface.co ↗',
        storageKey: 'enzo.keys.huggingface',
        aliasKey: 'enzo-huggingface-key',
      }
    }

    if (isNvidia) {
      const key = keyVault.getItem('enzo.keys.nvidia') || keyVault.getItem('enzo-nvidia-key') || ''
      return {
        id: 'nvidia',
        name: 'NVIDIA NIM Catalog',
        hasKey: !!key || keySaved,
        instruction: 'NVIDIA NIM models require a free NVIDIA NIM API key from build.nvidia.com.',
        placeholder: 'nvapi-...',
        tokenUrl: 'https://build.nvidia.com',
        tokenUrlText: 'Get Key at build.nvidia.com ↗',
        storageKey: 'enzo.keys.nvidia',
        aliasKey: 'enzo-nvidia-key',
      }
    }

    if (isOr) {
      const key = keyVault.getItem('enzo.keys.openrouter') || keyVault.getItem('enzo-openrouter-key') || ''
      return {
        id: 'openrouter',
        name: 'OpenRouter Aggregator',
        hasKey: !!key || keySaved,
        instruction: 'OpenRouter models route through OpenRouter aggregator keys.',
        placeholder: 'sk-or-v1-...',
        tokenUrl: 'https://openrouter.ai/keys',
        tokenUrlText: 'Get Key at openrouter.ai ↗',
        storageKey: 'enzo.keys.openrouter',
        aliasKey: 'enzo-openrouter-key',
      }
    }

    if (isGroq) {
      const key = keyVault.getItem('enzo.keys.groq') || ''
      return {
        id: 'groq',
        name: 'Groq Cloud Platform',
        hasKey: !!key || keySaved,
        instruction: 'Groq Cloud models run on LPU hardware with a Groq key.',
        placeholder: 'gsk_...',
        tokenUrl: 'https://console.groq.com/keys',
        tokenUrlText: 'Get Key at console.groq.com ↗',
        storageKey: 'enzo.keys.groq',
      }
    }

    return null
  }

  const providerInfo = model ? getProviderInfo(model) : null

  const handleSaveInlineKey = () => {
    if (!providerInfo || !keyInput.trim()) return
    const val = keyInput.trim()
    localStorage.setItem(providerInfo.storageKey, val)
    if (providerInfo.aliasKey) {
      localStorage.setItem(providerInfo.aliasKey, val)
    }
    setKeySaved(true)
  }

  return (
    <AnimatePresence>
      {model && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-6 backdrop-blur-md"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.9, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="mobile-menu-glass w-full max-w-lg rounded-3xl border border-white/10 overflow-hidden"
          >
            <div className="flex items-center justify-between bg-white/[0.03] px-5 py-3 border-b border-white/10">
              <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50">
                workspace.enzo://handoff
              </div>
              <button onClick={onClose} className="font-mono-display text-[10px] text-white/60 hover:text-white">✕</button>
            </div>
            <div className="p-6">
              <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/40">
                Binding Intelligence Unit
              </div>
              <div className="mt-1 font-garamond text-3xl font-normal text-white">{model.name}</div>
              <div className="mt-1 font-mono-display text-[10px] text-white/50 uppercase tracking-widest flex items-center gap-2">
                <span>{model.provider} · {model.free ? 'Free' : model.pricing_prompt}</span>
              </div>

              {/* Provider Key Setup / Credentials Box */}
              {providerInfo && (
                <div className={`mt-4 rounded-2xl p-4 border font-mono-display text-xs ${
                  providerInfo.hasKey
                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                }`}>
                  <div className="flex items-center justify-between font-bold uppercase tracking-wider text-[10px] mb-1.5">
                    <span>{providerInfo.name} Credentials</span>
                    <span className={`px-2 py-0.5 rounded text-[8px] ${
                      providerInfo.hasKey ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
                    }`}>
                      {providerInfo.hasKey ? '✓ Key Configured' : '⚠️ Key Required'}
                    </span>
                  </div>

                  <p className="text-[11px] leading-relaxed text-white/80 font-sans mb-2">
                    {providerInfo.instruction}
                  </p>

                  {!providerInfo.hasKey && (
                    <div className="space-y-2.5 pt-1">
                      <div className="flex items-center justify-between">
                        <a
                          href={providerInfo.tokenUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] uppercase font-bold text-cyan-400 hover:text-cyan-300 underline underline-offset-2 flex items-center gap-1 cursor-pointer"
                        >
                          {providerInfo.tokenUrlText}
                        </a>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={keyInput}
                          onChange={(e) => setKeyInput(e.target.value)}
                          placeholder={providerInfo.placeholder}
                          className="flex-1 bg-black/40 border border-white/20 rounded-xl px-3 py-1.5 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-white/40 font-mono"
                        />
                        <button
                          type="button"
                          onClick={handleSaveInlineKey}
                          disabled={!keyInput.trim()}
                          className="px-3 py-1.5 rounded-xl bg-white text-black text-[10px] font-bold uppercase tracking-wider hover:bg-white/90 disabled:opacity-30 cursor-pointer"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Steps timeline */}
              <div className="mt-5 space-y-2 rounded-2xl bg-black/35 border border-white/5 p-5 font-mono-display text-xs">
                {HANDOFF_STEPS.map((s, i) => (
                  <div
                    key={s}
                    className={`flex items-center gap-2 ${i <= stepIdx ? 'text-white' : 'text-white/20'}`}
                  >
                    <span>{i < stepIdx ? '✓' : i === stepIdx ? '▸' : '·'}</span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>

              <button
                disabled={stepIdx < HANDOFF_STEPS.length - 1}
                onClick={() => onLaunch(model)}
                className="mt-6 w-full rounded-full bg-white text-black font-semibold font-mono-display text-xs uppercase tracking-widest py-3 hover:bg-white/95 transition-all disabled:opacity-35 cursor-pointer"
              >
                {stepIdx < HANDOFF_STEPS.length - 1 ? 'Compiling Bindings…' : 'Activate in Terminal →'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ─── AuthView ─────────────────────────────────────────────────────────────────
// Google identity login — hosted build only. In the docker variant this and
// ModernLoginSignup are unreferenced and tree-shaken from the bundle.

function AuthView({
  onBack,
}: {
  onBack: () => void
}): React.JSX.Element | null {
  if (!GOOGLE_AUTH) return null
  return (
    <ModernLoginSignup
      // Redirect to Express backend which handles the full Google sign-in dance
      onGoogle={() => {
        window.location.href = '/api/auth/google'
      }}
      onBack={onBack}
    />
  )
}


export default App
