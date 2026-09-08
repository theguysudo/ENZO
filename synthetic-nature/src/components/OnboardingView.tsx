// ─── OnboardingView — the compulsory 5-step key setup ─────────────────────────
//
// Rendered by App.tsx when appView === 'onboarding'. Steps 1-3 (OpenRouter,
// NVIDIA, Google AI Studio) are the hard gate: App decides a user is logged in
// by looking for those keys, so nothing here may grant access on its own —
// onDone() is the only way out. Step 4 holds optional providers (HuggingFace,
// Puter, Cloudflare) and uses GSAP for animated entrances.
//
// Every key written here goes through keyVault, which is what brings
// onboarding-entered keys under AES-256-GCM at rest. Writing to localStorage
// directly would store plaintext and fails a CI guard.
//
// Extracted from App.tsx unchanged — same JSX, same classes, same copy.

import { useState, useEffect, useRef } from 'react'
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTrigger,
} from './ui/stepper'
import { motion, AnimatePresence } from 'framer-motion'
import { staggerIn } from '../lib/gsapTransitions'
import * as keyVault from '../lib/keyVault'
import { GOOGLE_AUTH } from '../lib/variant'
import { mintVaultToken } from '../lib/vaultToken'
import SaveSwitch from './SaveSwitch'
import { DotGridBackground } from './ui/modern-login-signup'

// ─── PKCE helpers ─────────────────────────────────────────────────────────────
function generateCodeVerifier(): string {
  const array = new Uint32Array(56)
  window.crypto.getRandomValues(array)
  return Array.from(array, (dec) => ('0' + dec.toString(16)).slice(-2)).join('')
}
async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await window.crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ─── OnboardingView ───────────────────────────────────────────────────────────

type OnbStep = 1 | 2 | 3 | 4 | 5 | 6
type KeyStatus = 'idle' | 'connected' | 'saved'

function OnboardingView({
  onDone,
  initialStep = 1,
}: {
  onDone: () => void
  initialStep?: OnbStep
}) {
  const step5Ref = useRef<HTMLDivElement | null>(null)
  const [step, setStep] = useState<OnbStep>(initialStep)
  const [error, setError] = useState<string | null>(null)

  // Which step's indicator is spinning. The active step's beat: the number
  // lands briefly, then the spinner takes over and keeps spinning for as
  // long as the user is on that step. No clear-timer — the spinner ends only
  // by leaving the step (completed steps morph to checks via data-state, so
  // nothing gets stuck).
  const [loadingStep, setLoadingStep] = useState<OnbStep | null>(null)

  useEffect(() => {
    setLoadingStep(null)
    const t = setTimeout(() => setLoadingStep(step), 600)
    return () => clearTimeout(t)
  }, [step])

  const [orKey, setOrKey] = useState('')
  const [orStatus, setOrStatus] = useState<KeyStatus>('idle')

  const [nvidiaKey, setNvidiaKey] = useState('')
  const [nvidiaStatus, setNvidiaStatus] = useState<KeyStatus>('idle')
  const [showNvidiaGuide, setShowNvidiaGuide] = useState(false)

  const [exaKey, setExaKey] = useState('')
  const [exaStatus, setExaStatus] = useState<KeyStatus>('idle')

  const [googleToken, setGoogleToken] = useState('')
  const [googleStatus, setGoogleStatus] = useState<KeyStatus>('idle')


  const [cfToken, setCfToken] = useState('')
  const [cfAccount, setCfAccount] = useState('')
  const [cfStatus, setCfStatus] = useState<KeyStatus>('idle')

  // Bring-your-own Google OAuth client (docker variant only). The Gmail/
  // Calendar connect flow runs against the INSTANCE's client id — on the
  // hosted hub that's ours, on a self-hosted container it's the operator's
  // own Google app, pasted here instead of editing .env by hand. Saved via
  // the vault token (same auth as the Vault's .env writer), and the server
  // picks it up live — no container restart.
  const [gClientId, setGClientId] = useState('')
  const [gClientSecret, setGClientSecret] = useState('')
  const [gClientStatus, setGClientStatus] = useState<KeyStatus>('idle')
  const [gClientConfigured, setGClientConfigured] = useState<boolean | null>(null)
  const [gRedirectUri, setGRedirectUri] = useState('')
  const [gCopied, setGCopied] = useState(false)

  useEffect(() => {
    if (!GOOGLE_AUTH) {
      fetch('/api/gmail/oauth-client')
        .then((r) => r.json())
        .then((d) => { setGClientConfigured(Boolean(d.configured)); setGRedirectUri(String(d.redirectUri || '')) })
        .catch(() => setGClientConfigured(null))
    }
  }, [])

  const saveGClient = async () => {
    const id = gClientId.trim()
    const secret = gClientSecret.trim()
    if (!id || !secret) return
    try {
      const vaultToken = await mintVaultToken()
      if (!vaultToken) {
        setError('Could not authorize with this instance (no vault token) — save a provider key first, then retry.')
        return
      }
      const res = await fetch('/api/gmail/oauth-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vault-token': vaultToken },
        body: JSON.stringify({ clientId: id, clientSecret: secret }),
      })
      const data = await res.json()
      if (data.success) {
        setGClientStatus('saved')
        setGClientConfigured(true)
        setError(null)
      } else {
        setError(data.detail || data.error || 'Google OAuth client was rejected — check both fields.')
      }
    } catch {
      setError('Could not reach this ENZO instance to save the OAuth client.')
    }
  }


  useEffect(() => {
    setStep(initialStep)
  }, [initialStep])

  useEffect(() => {
    const savedOr = keyVault.getItem('enzo.keys.openrouter') || keyVault.getItem('enzo-openrouter-key')
    if (savedOr) { setOrStatus('connected'); setOrKey(savedOr) }
    const savedNv = keyVault.getItem('enzo-nvidia-key') || keyVault.getItem('enzo.keys.nvidia')
    if (savedNv) { setNvidiaStatus('saved'); setNvidiaKey(savedNv) }
    const savedExa = keyVault.getItem('enzo.keys.exa')
    if (savedExa) { setExaStatus('saved'); setExaKey(savedExa) }
    const savedGoogle = keyVault.getItem('enzo.keys.google') || keyVault.getItem('enzo.keys.gemini')
    if (savedGoogle) { setGoogleStatus('saved'); setGoogleToken(savedGoogle) }
    const savedCf = keyVault.getItem('enzo.keys.cloudflare')
    if (savedCf) { setCfStatus('saved'); setCfToken(savedCf) }
    const savedCfAccount = keyVault.getItem('enzo.keys.cloudflareAccount')
    if (savedCfAccount) { setCfAccount(savedCfAccount) }
  }, [initialStep])

  // Stagger Step 4's optional-provider cards in after the panel's own Framer
  // Motion enter animation completes. A callback ref fires too early — the
  // stagger would race the panel's 300ms fade+slide and finish invisibly. We
  // use onAnimationComplete (Framer Motion) to know the panel is fully on
  // screen, then run the GSAP stagger. setStep4Ready toggles on every step
  // transition so the callback re-fires per mount.
  const step5AnimateComplete = () => {
    if (step5Ref.current) staggerIn(step5Ref.current.querySelectorAll('.gsap-item'))
  }


  const startOpenRouterOAuth = async () => {
    try {
      setError(null)
      const verifier = generateCodeVerifier()
      sessionStorage.setItem('enzo.oauth.code_verifier', verifier)
      const challenge = await generateCodeChallenge(verifier)
      const callbackUrl = window.location.origin + window.location.pathname
      // No `state` param here, deliberately. state defends against code injection,
      // and PKCE already does that for this flow: the exchange is browser→OpenRouter
      // with no server hop, and it sends the verifier out of same-origin
      // sessionStorage. A code an attacker injects into our callback URL was minted
      // against *their* code_challenge, so redeeming it with our verifier fails at
      // OpenRouter. Server-side flows (see featureRoutes.ts) do need state, because
      // there the code lands somewhere that has no per-browser secret to bind it to.
      window.location.href = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}&code_challenge=${challenge}&code_challenge_method=S256`
    } catch (err: any) { setError('OAuth failed: ' + err.message) }
  }

  const saveOrKey = () => {
    const c = orKey.trim()
    if (c) { keyVault.setItem('enzo.keys.openrouter', c); keyVault.setItem('enzo-openrouter-key', c); setOrStatus('connected') }
  }

  const saveNvidiaKey = () => {
    const c = nvidiaKey.trim()
    if (c) { keyVault.setItem('enzo-nvidia-key', c); keyVault.setItem('enzo.keys.nvidia', c); setNvidiaStatus('saved') }
    else { keyVault.removeItem('enzo-nvidia-key'); keyVault.removeItem('enzo.keys.nvidia'); setNvidiaStatus('idle') }
  }

  const saveGoogleToken = () => {
    const c = googleToken.trim()
    if (c) {
      keyVault.setItem('enzo.keys.google', c)
      keyVault.setItem('enzo.keys.gemini', c)
      setGoogleStatus('saved')
    }
  }

  const saveExaKey = () => {
    const c = exaKey.trim()
    if (c) { keyVault.setItem('enzo.keys.exa', c); setExaStatus('saved') }
    else { keyVault.removeItem('enzo.keys.exa'); setExaStatus('idle') }
  }

  const saveCfToken = () => {
    const c = cfToken.trim()
    if (c) {
      keyVault.setItem('enzo.keys.cloudflare', c)
      if (cfAccount.trim()) keyVault.setItem('enzo.keys.cloudflareAccount', cfAccount.trim())
      setCfStatus('saved')
    }
  }

  const goNext = () => {
    if (step === 1) {
      if (orStatus !== 'connected') { setError('Connect OpenRouter first — it powers the chat engine.'); return }
      setError(null); setStep(2)
    } else if (step === 2) {
      if (nvidiaStatus !== 'saved') { setError('Save your NVIDIA key to continue.'); return }
      setError(null); setStep(3)
    } else if (step === 3) {
      // Docker variant (GOOGLE_AUTH=false): App.tsx's login gate is
      // `hasGoogle || !GOOGLE_AUTH`, so a Google key is genuinely optional
      // here — requiring one would lock a keyless-Google user out forever.
      if (!GOOGLE_AUTH) {
        if (googleStatus !== 'saved' && googleToken.trim()) saveGoogleToken()
        setError(null); setStep(4)
        return
      }
      if (googleStatus !== 'saved' && googleToken.trim()) saveGoogleToken()
      if (googleStatus !== 'saved' && !googleToken.trim()) { setError('Save your Google AI Studio key to continue.'); return }
      setError(null); setStep(4)
    } else if (step === 4) {
      // Exa is optional — save if a key was provided, then continue. The
      // completion gate in App.tsx only requires OpenRouter + NVIDIA + Google;
      // chat works without web search.
      if (exaStatus !== 'saved' && exaKey.trim()) saveExaKey()
      setError(null); setStep(5)
    } else if (step === 5) {
      // Cloudflare is optional — save if token provided, then continue
      if (cfToken.trim()) saveCfToken()
      setError(null)
      // Docker variant: the BYO Google OAuth client step follows. Hosted
      // variant finishes here (the site's own client is pre-configured).
      setStep(GOOGLE_AUTH ? 5 : 6)
    } else if (step === 6) {
      setError(null); handleFinish()
    }
  }

  const goBack = () => { setError(null); setStep((p) => (p - 1) as OnbStep) }

  const handleFinish = () => { if (cfToken.trim()) saveCfToken(); onDone() }

  const STEPS = GOOGLE_AUTH
    ? ['OpenRouter', 'NVIDIA NIM', 'Google AI Studio', 'Exa Search', 'Cloudflare']
    : ['OpenRouter', 'NVIDIA NIM', 'Google AI Studio', 'Exa Search', 'Cloudflare', 'Gmail OAuth']

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black px-4 py-10 overflow-y-auto"
    >
      {/* Same WebGL dot grid as the Google signup step — one visual language
          from sign-up through the end of API setup. Cursor-reactive: dots
          brighten and swell around the pointer (handled inside
          DotGridBackground). */}
      <DotGridBackground />
      <motion.div
        initial={{ y: 32, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-2xl"
      >
        {/* Header */}
        <div className="mb-8 text-center">
          <h2 className="font-garamond text-4xl font-normal text-white">Connect Providers</h2>
        </div>

        {/* Progress steps — animated Stepper: the step number morphs into a
            check as steps complete and separators light up behind it. On
            arrival the active indicator plays a number→spinner settle beat.
            Only completed steps are clickable (jump back); forward movement
            stays gated on the key checks in goNext. */}
        <div className="mb-6">
          <Stepper
            value={step}
            onValueChange={(v) => { if (v < step) { setError(null); setStep(v as OnbStep) } }}
          >
            {STEPS.map((label, i) => (
              <StepperItem
                key={label}
                step={i + 1}
                className="[&:not(:last-child)]:flex-1"
                loading={loadingStep === (i + 1 as OnbStep)}
              >
                <StepperTrigger>
                  <StepperIndicator className="size-7 font-mono-display text-[9px]" />
                </StepperTrigger>
                {i < STEPS.length - 1 && <StepperSeparator />}
              </StepperItem>
            ))}
          </Stepper>
        </div>

        <AnimatePresence mode="wait">

          {/* ── Step 1: OpenRouter ── */}
          {step === 1 && (
            <motion.div key="s1" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.3 }}
              className="liquid-glass-panel rounded-3xl p-6 space-y-5"
            >
              <div className="flex items-center gap-3 pb-4 border-b border-white/8">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/5 border border-white/10">
                  <span className="font-mono-display text-xs font-bold text-white/70">OR</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono-display text-xs uppercase tracking-widest text-white">OpenRouter</span>
                    <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-white/50">Required</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/40">Chat engine · 300+ AI models</div>
                </div>
              </div>

              {/* OpenRouter Button — one interactive element, not an <a> wrapping
                  a <button>: nested interactive content double-navigates (the
                  inner click starts OAuth while the outer anchor also opens
                  openrouter.ai) and is invalid HTML. Connected = plain disabled
                  chip; otherwise the whole anchor IS the button. */}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                onClick={orStatus === 'connected' ? undefined : startOpenRouterOAuth}
                className={`block w-full max-w-md mx-auto ${orStatus === 'connected' ? 'pointer-events-none' : 'cursor-pointer'}`}
              >
                {orStatus === 'connected' ? (
                  <span
                    className="block w-full py-4 px-6 rounded-2xl bg-white/5 border border-white/10 text-center text-white font-mono-display text-xs uppercase tracking-widest opacity-60"
                  >
                    ✓ Connected
                  </span>
                ) : (
                  <img
                    src="/buttons/OpenRouter_button.gif"
                    alt="Get your OpenRouter token"
                    width={399}
                    height={131}
                    className="mx-auto block max-h-16 w-auto max-w-full transition-transform duration-150 ease-out hover:-translate-y-0.5"
                  />
                )}
              </a>

              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-white/8" />
                <span className="font-mono-display text-[9px] uppercase tracking-widest text-white/30">or paste key</span>
                <div className="h-px flex-1 bg-white/8" />
              </div>

              <div className="flex gap-2">
                <input type="password" placeholder="sk-or-v1-…" value={orKey}
                  onChange={(e) => { setOrKey(e.target.value); setOrStatus('idle') }}
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono-display text-xs text-white placeholder:text-white/20 focus:border-white/25 focus:outline-none"
                />
                <SaveSwitch saved={orStatus === 'connected'} disabled={!orKey.trim()} onClick={saveOrKey}>Save</SaveSwitch>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/30">Free models · no credit card</span>
              </div>

              {error && <OnbError msg={error} />}

              <button onClick={goNext} className="w-full rounded-2xl border border-white/15 bg-white/5 py-3 font-mono-display text-xs uppercase tracking-widest text-white/80 transition-all hover:bg-white/10 hover:-translate-y-0.5">
                Next: NVIDIA NIM →
              </button>
              <p className="text-center text-[10px] text-white/25">Keys stored encrypted on this device · sent only to the ENZO backend you run</p>
            </motion.div>
          )}

          {/* ── Step 2: NVIDIA NIM ── */}
          {step === 2 && (
            <motion.div key="s2" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.3 }}
              className="liquid-glass-panel rounded-3xl p-6 space-y-5"
            >
              <div className="flex items-center gap-3 pb-4 border-b border-white/8">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/5 border border-white/10">
                  <svg className="size-5" viewBox="0 0 24 24" fill="none">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="opacity-75" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono-display text-xs uppercase tracking-widest text-white">NVIDIA NIM</span>
                    <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-white/50">Required</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/40">Nemotron, Llama NIM · 40K free credits</div>
                </div>
              </div>

              <div className="flex items-start gap-2.5 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <span className="shrink-0 text-white/60 text-xs leading-5">◆</span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono-display text-[9px] uppercase tracking-wider text-white/80 font-bold">40,000 Free Inference Credits</div>
                  <p className="mt-0.5 text-[10px] text-white/40 leading-relaxed">No credit card required. Generate your key in one step at build.nvidia.com</p>
                </div>
              </div>

              {/* NVIDIA Button */}
              <a
                href="https://build.nvidia.com/explore/discover"
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full max-w-md mx-auto"
              >
                <img
                  src="/buttons/Nvidia_Button.gif"
                  alt="Get your free NVIDIA NIM API key"
                  width={443}
                  height={193}
                  className="mx-auto block max-h-16 w-auto max-w-full transition-transform duration-150 ease-out hover:-translate-y-0.5"
                />
              </a>

              <button onClick={() => setShowNvidiaGuide(!showNvidiaGuide)}
                className="flex w-full items-center gap-2 font-mono-display text-[9px] uppercase tracking-widest text-white/30 hover:text-green-400 transition-colors"
              >
                <span className={`transition-transform duration-200 ${showNvidiaGuide ? 'rotate-90' : ''}`}>▶</span>
                How to get your NVIDIA key (4 steps)
              </button>

              <AnimatePresence>
                {showNvidiaGuide && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-2.5">
                      {[
                        'Click the free credits key generation button above to visit build.nvidia.com',
                        'Sign up with your email (free). No credit card needed.',
                        'On the dashboard, click any model → hit "Get API Key" top right.',
                        'Copy the key starting with nvapi-… and paste it below.',
                      ].map((s, i) => (
                        <div key={i} className="flex items-start gap-2.5">
                          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-white/20 font-mono-display text-[8px] text-white/70">{i + 1}</span>
                          <span className="text-[10px] text-white/40 leading-relaxed">{s}</span>
                        </div>
                      ))}
                      <div className="mt-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 font-mono-display text-[9px] text-white/60">Note: This key unlocks Nemotron-Ultra, Llama-3.1-Nemotron-70B and more.</div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div>
                <label className="mb-1.5 block font-mono-display text-[9px] uppercase tracking-widest text-white/40">NVIDIA NIM API Key</label>
                <div className="flex gap-2">
                  <input type="password" placeholder="nvapi-…" value={nvidiaKey}
                    onChange={(e) => { setNvidiaKey(e.target.value); setNvidiaStatus('idle') }}
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono-display text-xs text-white placeholder:text-white/20 focus:border-white/25 focus:outline-none"
                  />
                  <SaveSwitch saved={nvidiaStatus === 'saved'} disabled={!nvidiaKey.trim()} onClick={saveNvidiaKey}>Save</SaveSwitch>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button onClick={goBack} className="flex-1 rounded-2xl border border-white/10 py-3 font-mono-display text-xs uppercase tracking-widest text-white/40 transition-all hover:border-white/20 hover:text-white/70">← Back</button>
                <button
                  disabled={nvidiaStatus !== 'saved'}
                  onClick={goNext}
                  className="flex-[2] rounded-2xl border border-white/15 bg-white/5 py-3 font-mono-display text-xs uppercase tracking-widest text-white/80 transition-all hover:bg-white/10 hover:-translate-y-0.5 disabled:opacity-35"
                >
                  Next: Google AI Studio →
                </button>
              </div>
            </motion.div>
          )}

          {/* ── Step 3: Google AI Studio (Gemini) — required on hosted, optional in docker ── */}
          {step === 3 && (
            <motion.div key="s3" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.3 }}
              className="liquid-glass-panel rounded-3xl p-6 space-y-5"
            >
              <div className="flex items-center gap-3 pb-4 border-b border-white/8">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/5 border border-white/10">
                  <span className="font-mono-display text-xs font-bold text-white/70">AI</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono-display text-xs uppercase tracking-widest text-white">Google AI Studio</span>
                    {!GOOGLE_AUTH && (
                      <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-white/50">Optional</span>
                    )}
                    {GOOGLE_AUTH && (
                      <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-white/50">Required</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/40">Gemini Flash — free tier, no credit card</div>
                </div>
              </div>

              <div className="flex items-start gap-2.5 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <span className="shrink-0 text-white/60 text-xs leading-5">◆</span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono-display text-[9px] uppercase tracking-wider text-white/80 font-bold">1,500 Free Credits Daily</div>
                  <p className="mt-0.5 text-[10px] text-white/40 leading-relaxed">No credit card required. Generate your key once at aistudio.google.com</p>
                </div>
              </div>

              {/* Google AI Studio Button */}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full max-w-md mx-auto"
              >
                <img
                  src="/buttons/Google_Button.gif"
                  alt="Get your Google AI Studio API key"
                  width={400}
                  height={159}
                  className="mx-auto block max-h-16 w-auto max-w-full transition-transform duration-150 ease-out hover:-translate-y-0.5"
                />
              </a>

              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-white/8" />
                <span className="font-mono-display text-[9px] uppercase tracking-widest text-white/30">or paste key</span>
                <div className="h-px flex-1 bg-white/8" />
              </div>

              <div>
                <label className="mb-1.5 block font-mono-display text-[9px] uppercase tracking-widest text-white/40">Google AI Studio API Key</label>
                <div className="flex gap-2">
                  <input type="password" placeholder="AIza…" value={googleToken}
                    onChange={(e) => { setGoogleToken(e.target.value); setGoogleStatus('idle') }}
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono-display text-xs text-white placeholder:text-white/20 focus:border-orange-400/40 focus:outline-none"
                  />
                  <SaveSwitch saved={googleStatus === 'saved'} disabled={!googleToken.trim()} onClick={saveGoogleToken}>Save</SaveSwitch>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/30">Powers Gemini models across the hub</span>
              </div>

              {error && <OnbError msg={error} />}

              <div className="flex gap-2 pt-1">
                <button onClick={goBack} className="flex-1 rounded-2xl border border-white/10 py-3 font-mono-display text-xs uppercase tracking-widest text-white/40 transition-all hover:border-white/20 hover:text-white/70">← Back</button>
                <button
                  disabled={GOOGLE_AUTH && googleStatus !== 'saved'}
                  onClick={goNext}
                  className="flex-[2] rounded-2xl border border-white/15 bg-white/5 py-3 font-mono-display text-xs uppercase tracking-widest text-white/80 transition-all hover:bg-white/10 hover:-translate-y-0.5 disabled:opacity-35"
                >
                  Next: Optional Extras →
                </button>
              </div>

              <p className="text-center text-[10px] text-white/25">Keys stored encrypted on this device · sent only to the ENZO backend you run</p>
            </motion.div>
          )}

          {/* ── Step 4: Exa Search (Optional) ── */}
          {step === 4 && (
            <motion.div key="s4" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.3 }}
              className="liquid-glass-panel rounded-3xl p-6 space-y-5"
            >
              <div className="flex items-center gap-3 pb-4 border-b border-white/8">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/5 border border-white/10">
                  <span className="font-mono-display text-xs font-bold text-white/70">EXA</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono-display text-xs uppercase tracking-widest text-white">Exa Search</span>
                    <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-white/50">Optional</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/40">Neural web search · powers deep research</div>
                </div>
              </div>

              <div className="flex items-start gap-2.5 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <span className="shrink-0 text-white/60 text-xs leading-5">◆</span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono-display text-[9px] uppercase tracking-wider text-white/80 font-bold">Neural Search for Deep Research</div>
                  <p className="mt-0.5 text-[10px] text-white/40 leading-relaxed">Exa's neural search finds the exact answers you need. No credit card required for free tier.</p>
                </div>
              </div>

              {/* Exa Button */}
              <a
                href="https://exa.ai/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full max-w-md mx-auto"
              >
                <img
                  src="/buttons/Exa_Button.gif"
                  alt="Get your Exa API key"
                  width={440}
                  height={196}
                  className="mx-auto block max-h-16 w-auto max-w-full transition-transform duration-150 ease-out hover:-translate-y-0.5"
                />
              </a>

              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-white/8" />
                <span className="font-mono-display text-[9px] uppercase tracking-widest text-white/30">or paste key</span>
                <div className="h-px flex-1 bg-white/8" />
              </div>

              <div>
                <label className="mb-1.5 block font-mono-display text-[9px] uppercase tracking-widest text-white/40">Exa API Key</label>
                <div className="flex gap-2">
                  <input type="password" placeholder="exa-…" value={exaKey}
                    onChange={(e) => { setExaKey(e.target.value); setExaStatus('idle') }}
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono-display text-xs text-white placeholder:text-white/20 focus:border-cyan-400/40 focus:outline-none"
                  />
                  <SaveSwitch saved={exaStatus === 'saved'} disabled={!exaKey.trim()} onClick={saveExaKey}>Save</SaveSwitch>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/30">Optional — ENZO works without it, add later in Vault</span>
              </div>

              {error && <OnbError msg={error} />}

              <div className="flex gap-2 pt-1">
                <button onClick={goBack} className="flex-1 rounded-2xl border border-white/10 py-3 font-mono-display text-xs uppercase tracking-widest text-white/40 transition-all hover:border-white/20 hover:text-white/70">← Back</button>
                <button
                  onClick={goNext}
                  className="flex-[2] rounded-2xl border border-white/15 bg-white/5 py-3 font-mono-display text-xs uppercase tracking-widest text-white/80 transition-all hover:bg-white/10 hover:-translate-y-0.5 disabled:opacity-35"
                >
                  Next: Cloudflare →
                </button>
              </div>

              <p className="text-center text-[10px] text-white/25">Keys stored encrypted on this device · sent only to the ENZO backend you run</p>
            </motion.div>
          )}

          {/* ── Step 5: Cloudflare Workers AI (Optional) ── */}
          {step === 5 && (
            <motion.div key="s5" ref={step5Ref} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.3 }}
              onAnimationComplete={step5AnimateComplete}
              className="liquid-glass-panel rounded-3xl p-6 space-y-5"
            >
              <div className="flex items-center gap-3 pb-4 border-b border-white/8">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/5 border border-white/10">
                  <span className="font-mono-display text-sm font-bold text-white/70">CF</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono-display text-xs uppercase tracking-widest text-white">Cloudflare Workers AI</span>
                    <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-white/50">Optional</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/40">Llama, Qwen, DeepSeek on Workers free tier</div>
                </div>
              </div>

              <div className="flex items-start gap-2.5 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <span className="shrink-0 text-white/60 text-xs leading-5">◆</span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono-display text-[9px] uppercase tracking-wider text-white/80 font-bold">Free Workers AI Tier</div>
                  <p className="mt-0.5 text-[10px] text-white/40 leading-relaxed">Run Llama, Qwen, DeepSeek on Cloudflare's global network. Some regions may need paid plan.</p>
                </div>
              </div>

              {/* Cloudflare Button */}
              <a
                href="https://dash.cloudflare.com/profile/api-tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full max-w-md mx-auto"
              >
                <img
                  src="/buttons/Cloudflare_Button.gif"
                  alt="Get your Cloudflare API token"
                  width={440}
                  height={158}
                  className="mx-auto block max-h-16 w-auto max-w-full transition-transform duration-150 ease-out hover:-translate-y-0.5"
                />
              </a>

              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-white/8" />
                <span className="font-mono-display text-[9px] uppercase tracking-widest text-white/30">or paste token</span>
                <div className="h-px flex-1 bg-white/8" />
              </div>

              <div>
                <label className="mb-1.5 block font-mono-display text-[9px] uppercase tracking-widest text-white/40">Cloudflare API Token</label>
                <div className="flex gap-2">
                  <input type="password" placeholder="CF token from dash.cloudflare.com" value={cfToken}
                    onChange={(e) => { setCfToken(e.target.value); setCfStatus('idle') }}
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono-display text-xs text-white placeholder:text-white/20 focus:border-sky-400/40 focus:outline-none"
                  />
                  <SaveSwitch saved={cfStatus === 'saved'} disabled={!cfToken.trim()} onClick={saveCfToken}>Save</SaveSwitch>
                </div>
              </div>

              <div className="flex gap-2">
                <label className="flex-1 mb-1.5 block font-mono-display text-[9px] uppercase tracking-widest text-white/40">Account ID (optional)</label>
                <input type="text" placeholder="Account ID — auto-detected if blank" value={cfAccount}
                  onChange={(e) => setCfAccount(e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono-display text-xs text-white placeholder:text-white/20 focus:border-sky-400/40 focus:outline-none"
                />
              </div>

              {/* ── BYO Google OAuth client moved to its own step 6 (docker variant) ── */}

              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/30">Optional — add later in Vault</span>
              </div>

              {error && <OnbError msg={error} />}

              <div className="flex gap-2 pt-1">
                <button onClick={goBack} className="flex-1 rounded-2xl border border-white/10 py-3 font-mono-display text-xs uppercase tracking-widest text-white/40 transition-all hover:border-white/20 hover:text-white/70">← Back</button>
                <button
                  onClick={goNext}
                  className="flex-[2] rounded-2xl border border-white/15 bg-white/5 py-3 font-mono-display text-xs uppercase tracking-widest text-white/80 transition-all hover:bg-white/10 hover:-translate-y-0.5"
                >
                  {!GOOGLE_AUTH ? 'Next: Gmail & Calendar →' : 'Enter Hub ✓'}
                </button>
              </div>

              <p className="text-center text-[10px] text-white/25">Keys stored encrypted on this device · sent only to the ENZO backend you run</p>
            </motion.div>
          )}

          {/* ── Step 6: Bring-your-own Google OAuth client (docker variant only) ── */}
          {!GOOGLE_AUTH && step === 6 && (
            <motion.div key="s6" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.3 }}
              className="liquid-glass-panel rounded-3xl p-6 space-y-5"
            >
              <div className="flex items-center gap-3 pb-4 border-b border-white/8">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/5 border border-white/10">
                  <span className="font-mono-display text-xs font-bold text-white/70">@</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono-display text-xs uppercase tracking-widest text-white">Gmail &amp; Calendar</span>
                    <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-white/50">Optional</span>
                    {gClientConfigured === true && (
                      <span className="rounded-full border border-white/20 bg-white/5 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-white/50">Client set</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/40">Connect your mailbox with your own Google OAuth app</div>
                </div>
              </div>

              <div className="flex items-start gap-2.5 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <span className="shrink-0 text-white/60 text-xs leading-5">◆</span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono-display text-[9px] uppercase tracking-wider text-white/80 font-bold">Your App, Your Mailbox</div>
                  <p className="mt-0.5 text-[10px] text-white/40 leading-relaxed">
                    This instance uses <em>your</em> Google OAuth client for Gmail &amp; Calendar — nothing depends on
                    ours. Create one in Google Cloud Console (free, ~5 min), paste the pair below, and Connect Gmail
                    works instantly — no restart.
                  </p>
                </div>
              </div>

              {/* Get OAuth client button — mirrors the provider Get-key buttons */}
              <a
                href="https://console.cloud.google.com/apis/credentials/oauthclient"
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full max-w-md mx-auto"
              >
                <div className="mx-auto flex max-w-md items-center justify-center gap-2.5 rounded-2xl border border-white/15 bg-white px-5 py-3 transition-transform duration-150 ease-out hover:-translate-y-0.5">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.7-.2-2.5H12v4.8h6.5c-.3 1.5-1.1 2.8-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z"/>
                    <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1C3.3 21.3 7.3 24 12 24z"/>
                    <path fill="#FBBC05" d="M5.3 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3V6.6H1.3C.5 8.2 0 10 0 12s.5 3.8 1.3 5.4l4-3.1z"/>
                    <path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8L20 3.1C18 1.2 15.2 0 12 0 7.3 0 3.3 2.7 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z"/>
                  </svg>
                  <span className="font-mono-display text-xs font-semibold uppercase tracking-widest text-[#3c4043]">Create OAuth Client in Google Console</span>
                </div>
              </a>

              {/* Redirect URI to whitelist — copy-to-clipboard, derived from how this instance is reached */}
              {gRedirectUri && (
                <div className="flex items-start gap-2.5 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  <span className="shrink-0 text-white/60 text-xs leading-5">▸</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono-display text-[9px] uppercase tracking-wider text-white/80 font-bold">
                      2 · Add this as an Authorized Redirect URI (type: Web application)
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded-lg border border-white/20 bg-white/5 px-2.5 py-1.5 font-mono-display text-[10px] text-white/60">{gRedirectUri}</code>
                      <button
                        onClick={() => { navigator.clipboard.writeText(gRedirectUri).catch(() => {}); setGCopied(true); setTimeout(() => setGCopied(false), 1600) }}
                        className="shrink-0 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 font-mono-display text-[9px] uppercase tracking-wider text-white/70 transition-colors hover:bg-white/10"
                      >
                        {gCopied ? '✓ Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-white/8" />
                <span className="font-mono-display text-[9px] uppercase tracking-widest text-white/30">3 · paste the pair</span>
                <div className="h-px flex-1 bg-white/8" />
              </div>

              <div className="space-y-2">
                <div>
                  <label className="mb-1.5 block font-mono-display text-[9px] uppercase tracking-widest text-white/40">Client ID</label>
                  <input type="password" placeholder="123456789-abcdefg.apps.googleusercontent.com" value={gClientId}
                    onChange={(e) => { setGClientId(e.target.value); setGClientStatus('idle') }}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono-display text-xs text-white placeholder:text-white/20 focus:border-orange-400/40 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block font-mono-display text-[9px] uppercase tracking-widest text-white/40">Client Secret (shown once by Google — copy it there)</label>
                  <input type="password" placeholder="GOCSPX-…" value={gClientSecret}
                    onChange={(e) => { setGClientSecret(e.target.value); setGClientStatus('idle') }}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono-display text-xs text-white placeholder:text-white/20 focus:border-orange-400/40 focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/30">Saved to this instance's .env — Gmail connect works instantly</span>
                <SaveSwitch saved={gClientStatus === 'saved'} disabled={!gClientId.trim() || !gClientSecret.trim()} onClick={saveGClient}>Save</SaveSwitch>
              </div>

              {gClientStatus === 'saved' && (
                <a
                  href="/?gmail-connect=1"
                  onClick={(e) => { e.preventDefault(); fetch('/api/gmail/auth-url').then((r) => r.json()).then((d) => { if (d.url) window.open(d.url, 'google-oauth', 'width=500,height=600,popup=yes') }).catch(() => {}) }}
                  className="block w-full max-w-md mx-auto"
                >
                  <div className="mx-auto flex max-w-md items-center justify-center gap-2.5 rounded-2xl border border-white/15 bg-white px-5 py-3 transition-transform duration-150 ease-out hover:-translate-y-0.5">
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.7-.2-2.5H12v4.8h6.5c-.3 1.5-1.1 2.8-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z"/>
                      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1C3.3 21.3 7.3 24 12 24z"/>
                      <path fill="#FBBC05" d="M5.3 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3V6.6H1.3C.5 8.2 0 10 0 12s.5 3.8 1.3 5.4l4-3.1z"/>
                      <path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8L20 3.1C18 1.2 15.2 0 12 0 7.3 0 3.3 2.7 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z"/>
                    </svg>
                    <span className="font-mono-display text-xs font-semibold uppercase tracking-widest text-[#3c4043]">Sign in with Google — Connect Gmail</span>
                  </div>
                </a>
              )}

              {error && <OnbError msg={error} />}

              <div className="flex gap-2 pt-1">
                <button onClick={goBack} className="flex-1 rounded-2xl border border-white/10 py-3 font-mono-display text-xs uppercase tracking-widest text-white/40 transition-all hover:border-white/20 hover:text-white/70">← Back</button>
                <button
                  onClick={goNext}
                  className="flex-[2] rounded-2xl border border-white/15 bg-white/5 py-3 font-mono-display text-xs uppercase tracking-widest text-white/80 transition-all hover:bg-white/10 hover:-translate-y-0.5"
                >
                  Enter Hub ✓
                </button>
              </div>

              <p className="text-center text-[10px] text-white/25">Runs against your own Google app · this instance never contacts ours</p>
            </motion.div>
          )}

        </AnimatePresence>

      </motion.div>
    </motion.div>
  )
}

function OnbError({ msg }: { msg: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-red-500/25 bg-red-500/8 px-4 py-2.5 font-mono-display text-[10px] text-red-400"
    >Error: {msg}</motion.div>
  )
}

export { OnboardingView }
export type { OnbStep, KeyStatus }
