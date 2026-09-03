import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { DotGridBackground } from './ui/modern-login-signup'

// Types the welcome line in one character at a time. Reduced-motion users get
// the finished line immediately — the reveal is decoration, not information.
function TypedWelcome({ text, speed = 90 }: { text: string; speed?: number }) {
  const [shown, setShown] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    let reduced = false
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch (e) {}
    if (reduced) {
      setShown(text)
      setDone(true)
      return
    }
    let i = 0
    setShown('')
    setDone(false)
    const id = setInterval(() => {
      i += 1
      setShown(text.slice(0, i))
      if (i >= text.length) {
        clearInterval(id)
        setDone(true)
      }
    }, speed)
    return () => clearInterval(id)
  }, [text, speed])

  return (
    <span aria-label={text}>
      <span aria-hidden="true">{shown}</span>
      <span
        aria-hidden="true"
        className={done ? 'opacity-0' : 'animate-pulse'}
      >
        |
      </span>
    </span>
  )
}

export function AuthCallback() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('Completing sign in...')

  useEffect(() => {
    const handleCallback = async () => {
      try {
        // Parse the JWT token from the URL hash (#token=...)
        const hash = window.location.hash
        const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
        const token = params.get('token')

        if (!token) {
          setStatus('error')
          setMessage('No authentication token found in URL.')
          return
        }

        // Verify token with backend
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` }
        })

        if (!res.ok) {
          throw new Error(`Token verification failed: ${res.status}`)
        }

        const user = await res.json()

        // Persist token and user info in localStorage
        localStorage.setItem('enzo.auth.token', token)
        localStorage.setItem('enzo.auth.user', JSON.stringify(user))

        const welcomeText = `Welcome, ${user.name || user.email}!`
        setStatus('success')
        setMessage(welcomeText)

        // Clear the hash and redirect to main app. The delay lets the typed
        // welcome finish and hold for a beat before the handoff.
        window.history.replaceState(null, '', '/')
        setTimeout(() => {
          window.location.href = '/'
        }, 2200 + welcomeText.length * 90)
      } catch (err: any) {
        console.error('[AuthCallback] error:', err)
        setStatus('error')
        setMessage(err.message || 'Authentication failed')
      }
    }

    handleCallback()
  }, [])

  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-white">
      <DotGridBackground />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-10 flex h-full items-center justify-center px-4"
      >
        {status === 'loading' && (
          <div className="space-y-4 text-center">
            <div className="h-10 w-10 mx-auto rounded-xl border-2 border-white/20 border-t-white animate-spin" />
            <div className="text-white/60 font-mono text-sm">{message}</div>
          </div>
        )}

        {status === 'success' && (
          <div className="space-y-8 text-center">
            <h1 className="max-w-4xl text-4xl font-bold leading-tight tracking-[-0.03em] text-white sm:text-6xl">
              <TypedWelcome text={message} />
            </h1>
            <div className="text-white/30 font-mono text-xs">Redirecting to ENZO…</div>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-4 text-center">
            <div className="h-12 w-12 mx-auto rounded-2xl bg-rose-500/20 flex items-center justify-center">
              <svg className="h-6 w-6 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <div className="text-rose-400 font-mono text-sm">{message}</div>
            <button
              onClick={() => window.location.href = '/'}
              className="mt-4 px-4 py-2 rounded-lg border border-white/10 text-white/60 hover:text-white hover:border-white/30 transition-colors font-mono text-xs"
            >
              Back to Home
            </button>
          </div>
        )}
      </motion.div>
    </div>
  )
}
