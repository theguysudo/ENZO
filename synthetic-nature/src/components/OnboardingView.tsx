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
import { motion, AnimatePresence } from 'framer-motion'
import { staggerIn } from '../lib/gsapTransitions'
import * as keyVault from '../lib/keyVault'
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

type OnbStep = 1 | 2 | 3 | 4 | 5
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
      // Cloudflare is optional — save if token provided, then finish
      if (cfToken.trim()) saveCfToken()
      setError(null); handleFinish()
    }
  }

  const goBack = () => { setError(null); setStep((p) => (p - 1) as OnbStep) }

  const handleFinish = () => { if (cfToken.trim()) saveCfToken(); onDone() }

  const STEPS = ['OpenRouter', 'NVIDIA NIM', 'Google AI Studio', 'Exa Search', 'Cloudflare']

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black px-4 py-10 overflow-y-auto"
    >
      {/* Same WebGL dot grid as the Google signup step — one visual language
          from sign-up through the end of API setup. */}
      <DotGridBackground />
      <motion.div
        initial={{ y: 32, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-2xl"
      >
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono-display text-[9px] uppercase tracking-widest text-white/50 mb-3">
            <span className="h-1.5 w-1.5 rounded-full bg-white/60 animate-pulse" />
            Setup · Step {step} of 5
          </div>
          <h2 className="font-garamond text-4xl font-normal text-white">Connect Providers</h2>
          <p className="mt-1 text-xs text-white/40 font-light">Link your API accounts to unlock the full intelligence stack.</p>
        </div>

        {/* Progress steps */}
        <div className="mb-6 flex items-center justify-center gap-3">
          {STEPS.map((label, i) => {
            const sNum = (i + 1) as OnbStep
            const isActive = sNum === step
            const isDone = sNum < step
            return (
              <div key={label} className="flex shrink-0 items-center gap-3">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border font-mono-display text-[9px] transition-all duration-300 ${
                  isDone ? 'border-white/40 bg-white/10 text-white/60' :
                  isActive ? 'border-white/60 bg-white/10 text-white step-active' :
                  'border-white/10 text-white/20'
                }`}>
                  {isDone ? '✓' : sNum}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`h-px w-8 shrink-0 transition-all duration-500 ${isDone ? 'bg-white/30' : 'bg-white/8'}`} />
                )}
              </div>
            )
          })}
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
                <OnbStatusDot status={orStatus} />
              </div>

              {/* OpenRouter Button */}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full max-w-md mx-auto"
              >
                <button
                  onClick={orStatus === 'connected' ? undefined : startOpenRouterOAuth}
                  disabled={orStatus === 'connected'}
                  className={
                    orStatus === 'connected'
                      ? 'w-full py-4 px-6 rounded-2xl bg-white/5 border border-white/10 text-white font-mono-display text-xs uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed'
                      : 'block w-full rounded-2xl transition-transform duration-150 ease-out hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed'
                  }
                >
                  {orStatus === 'connected' ? (
                    '✓ Connected'
                  ) : (
                    <img
                      src="/buttons/OpenRouter_button.gif"
                      alt="Get your OpenRouter token"
                      width={399}
                      height={131}
                      className="mx-auto block max-h-16 w-auto max-w-full"
                    />
                  )}
                </button>
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
                <button onClick={saveOrKey} disabled={!orKey.trim()}
                  className={`shrink-0 rounded-xl border px-4 py-2.5 font-mono-display text-[9px] uppercase tracking-wider transition-all hover:-translate-y-0.5 disabled:opacity-30 ${orStatus === 'connected' ? 'border-green-500/40 bg-green-500/10 text-green-400' : 'border-white/20 bg-white/5 text-white/80'}`}
                >{orStatus === 'connected' ? '✓' : 'Save'}</button>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/30">Free models · no credit card</span>
                <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="shrink-0 font-mono-display text-[9px] uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors">Get key ↗</a>
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
                <OnbStatusDot status={nvidiaStatus} />
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
                  <button onClick={saveNvidiaKey} disabled={!nvidiaKey.trim()}
                    className={`shrink-0 rounded-xl border px-4 py-2.5 font-mono-display text-[9px] uppercase tracking-wider transition-all hover:-translate-y-0.5 disabled:opacity-30 ${nvidiaStatus === 'saved' ? 'border-green-500/40 bg-green-500/10 text-green-400' : 'border-white/20 bg-white/5 text-white/80'}`}
                  >{nvidiaStatus === 'saved' ? '✓' : 'Save'}</button>
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

          {/* ── Step 3: Google AI Studio (Gemini) — mandatory ── */}
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
                    <span className="rounded-full border border-orange-400/30 bg-orange-400/10 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-orange-300">Required</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/40">Gemini Flash — free tier, no credit card</div>
                </div>
                <OnbStatusDot status={googleStatus} />
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
                  <button onClick={saveGoogleToken} disabled={!googleToken.trim()}
                    className={`shrink-0 rounded-xl border px-4 py-2.5 font-mono-display text-[9px] uppercase tracking-wider transition-all hover:-translate-y-0.5 disabled:opacity-30 ${googleStatus === 'saved' ? 'border-green-500/40 bg-green-500/10 text-green-400' : 'border-orange-400/30 bg-orange-400/5 text-orange-300'}`}
                  >{googleStatus === 'saved' ? '✓' : 'Save'}</button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/30">Powers Gemini models across the hub</span>
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="shrink-0 font-mono-display text-[9px] uppercase tracking-wider text-orange-300/70 hover:text-orange-300 transition-colors">Get key ↗</a>
              </div>

              {error && <OnbError msg={error} />}

              <div className="flex gap-2 pt-1">
                <button onClick={goBack} className="flex-1 rounded-2xl border border-white/10 py-3 font-mono-display text-xs uppercase tracking-widest text-white/40 transition-all hover:border-white/20 hover:text-white/70">← Back</button>
                <button
                  disabled={googleStatus !== 'saved'}
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
                    <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-cyan-300">Optional</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/40">Neural web search · powers deep research</div>
                </div>
                <OnbStatusDot status={exaStatus} />
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
                  <button onClick={saveExaKey} disabled={!exaKey.trim()}
                    className={`shrink-0 rounded-xl border px-4 py-2.5 font-mono-display text-[9px] uppercase tracking-wider transition-all hover:-translate-y-0.5 disabled:opacity-30 ${exaStatus === 'saved' ? 'border-green-500/40 bg-green-500/10 text-green-400' : 'border-cyan-400/30 bg-cyan-400/5 text-cyan-300'}`}
                  >{exaStatus === 'saved' ? '✓' : 'Save'}</button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/30">Optional — ENZO works without it, add later in Vault</span>
                <a href="https://exa.ai/api-keys" target="_blank" rel="noopener noreferrer" className="shrink-0 font-mono-display text-[9px] uppercase tracking-wider text-cyan-300/70 hover:text-cyan-300 transition-colors">Get key ↗</a>
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
                    <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 font-mono-display text-[8px] uppercase tracking-wider text-sky-300">Optional</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-white/40">Llama, Qwen, DeepSeek on Workers free tier</div>
                </div>
                <OnbStatusDot status={cfStatus} />
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
                  <button onClick={saveCfToken} disabled={!cfToken.trim()}
                    className={`shrink-0 rounded-xl border px-4 py-2.5 font-mono-display text-[9px] uppercase tracking-wider transition-all hover:-translate-y-0.5 disabled:opacity-30 ${cfStatus === 'saved' ? 'border-green-500/40 bg-green-500/10 text-green-400' : 'border-sky-400/30 bg-sky-400/5 text-sky-300'}`}
                  >{cfStatus === 'saved' ? '✓' : 'Save'}</button>
                </div>
              </div>

              <div className="flex gap-2">
                <label className="flex-1 mb-1.5 block font-mono-display text-[9px] uppercase tracking-widest text-white/40">Account ID (optional)</label>
                <input type="text" placeholder="Account ID — auto-detected if blank" value={cfAccount}
                  onChange={(e) => setCfAccount(e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono-display text-xs text-white placeholder:text-white/20 focus:border-sky-400/40 focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/30">Optional — add later in Vault</span>
                <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer" className="shrink-0 font-mono-display text-[9px] uppercase tracking-wider text-sky-300/70 hover:text-sky-300 transition-colors">Get token ↗</a>
              </div>

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

              <p className="text-center text-[10px] text-white/25">Keys stored encrypted on this device · sent only to the ENZO backend you run</p>
            </motion.div>
          )}

        </AnimatePresence>

      </motion.div>
    </motion.div>
  )
}

function OnbStatusDot({ status }: { status: KeyStatus }) {
  return (
    <span className={`h-2 w-2 shrink-0 rounded-full transition-all duration-500 ${status !== 'idle' ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)] animate-pulse' : 'bg-white/15'}`} />
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
