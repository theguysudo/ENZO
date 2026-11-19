/**
 * UpdateBanner.tsx — the "new release" notice, for both distribution shapes.
 *
 * Docker / hosted (the historical path): read the latest release tag from
 * GitHub's public API (24h sessionStorage cache, one unauthenticated request a
 * day at most), compare it against the running __ENZO_VERSION__, and show a
 * small dismissible card linking to the release notes.
 *
 * Desktop (.app / .exe): the backend can do better than a link — it can
 * replace the installed app in place. So the banner asks /api/desktop/update
 * first; when that reports a newer release it shows a one-click "Update"
 * button next to "Later". The backend throttles the reminder to twice per
 * rolling week, so this is a nudge, never a nag: dismissing it keeps the
 * current version, and nothing is forced.
 *
 * The update keeps all user data: memory, vault keys, investigations, neural
 * state and generated projects live in the per-user data dir, outside the app
 * bundle, so replacing the bundle changes nothing but the code.
 */

import { useCallback, useEffect, useState } from 'react'
import { Rocket, X, RefreshCw, Check } from 'lucide-react'

const REPO = 'theguysudo/ENZO'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** True when `latest` (e.g. "v1.7.0") is a higher semver than the running build. */
function isNewer(latest: string, current: string): boolean {
  const a = latest.replace(/^v/, '').split('.').map(Number)
  const b = current.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

interface DesktopUpdate {
  current: string
  latest: string
  available: boolean
  notify: boolean
  assetName?: string
  releaseNotesUrl?: string
  desktop: boolean
}

type Phase = 'idle' | 'checking' | 'updating' | 'restarting' | 'done' | 'error'

export default function UpdateBanner() {
  const [latest, setLatest] = useState<string | null>(null)
  const [desktop, setDesktop] = useState<DesktopUpdate | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dismissedTag, setDismissedTag] = useState<string | null>(() => {
    try {
      return localStorage.getItem('enzo.update.dismissed')
    } catch {
      return null
    }
  })

  // Desktop installs ask the backend first (it knows the platform asset and
  // owns the reminder cadence). Everything else uses the public GitHub check.
  useEffect(() => {
    let cancelled = false
    const checkDesktop = async () => {
      try {
        const res = await fetch('/api/desktop/update')
        if (!res.ok) return
        const data = (await res.json()) as DesktopUpdate
        if (cancelled) return
        if (!data.desktop) return
        setDesktop(data)
        if (data.available && data.notify) setLatest(data.latest)
      } catch {
        /* not a desktop install, or offline — fall back to the GitHub check */
      }
    }
    void checkDesktop()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (desktop) return // desktop path already answered
    let cancelled = false
    const check = async () => {
      try {
        const cached = sessionStorage.getItem('enzo.update.latest')
        if (cached) {
          const { tag, at } = JSON.parse(cached)
          if (typeof tag === 'string' && Date.now() - Number(at) < CACHE_TTL_MS) {
            if (!cancelled) setLatest(tag)
            return
          }
        }
      } catch {
        /* storage unavailable — fall through to the fetch */
      }
      try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json' },
        })
        if (!res.ok) return
        const data = await res.json()
        if (typeof data?.tag_name !== 'string') return
        try {
          sessionStorage.setItem('enzo.update.latest', JSON.stringify({ tag: data.tag_name, at: Date.now() }))
        } catch {
          /* cache is best-effort */
        }
        if (!cancelled) setLatest(data.tag_name)
      } catch {
        /* offline or rate-limited — never surface a broken banner */
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [desktop])

  const dismiss = () => {
    if (!latest) return
    setDismissedTag(latest)
    try {
      localStorage.setItem('enzo.update.dismissed', latest)
    } catch {
      /* session-only dismissal is fine */
    }
  }

  const applyUpdate = useCallback(async () => {
    setPhase('updating')
    setError(null)
    try {
      const res = await fetch('/api/desktop/update/apply', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body?.error || 'the update could not be started')
        setPhase('error')
        return
      }
      setPhase('restarting')
    } catch {
      setError('the update could not be started')
      setPhase('error')
      return
    }
    // The server restarts into the new version — poll until it answers again.
    const poll = window.setInterval(async () => {
      try {
        const res = await fetch('/api/desktop/update/status')
        if (!res.ok) return
        const body = await res.json()
        if (typeof body?.progress === 'number') setProgress(body.progress)
        if (body?.phase === 'restarting' || body?.phase === 'done') {
          window.clearInterval(poll)
          setPhase('done')
        }
        if (body?.phase === 'error') {
          window.clearInterval(poll)
          setError(body?.error || 'the update failed')
          setPhase('error')
        }
      } catch {
        /* server is down while it swaps — keep waiting */
      }
    }, 1500)
  }, [])

  if (!latest || !isNewer(latest, __ENZO_VERSION__) || dismissedTag === latest) return null

  const updating = phase === 'updating' || phase === 'restarting'
  const statusLine =
    phase === 'done'
      ? 'Updated — reloading ENZO…'
      : updating
        ? 'Downloading and installing… ENZO will restart on its own.'
        : `You're running v${__ENZO_VERSION__}.`

  return (
    <div
      className="fixed bottom-4 left-4 z-[9990] max-w-[320px] rounded-xl border border-white/10 bg-[#0c0c0e]/95 backdrop-blur-md p-3 shadow-[0_12px_36px_rgba(0,0,0,0.5)]"
      role="status"
    >
      <div className="flex items-start gap-2.5">
        <Rocket size={14} className="mt-0.5 shrink-0 text-white/60" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-white/90">ENZO {latest} is out</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-white/55">{statusLine}</p>

          {updating && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-white/70 transition-all"
                style={{ width: `${Math.max(8, progress)}%` }}
              />
            </div>
          )}

          {error && <p className="mt-1.5 text-[11px] text-[#f0968a]">{error}</p>}

          {!updating && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {desktop?.desktop && (
                <button
                  type="button"
                  onClick={() => void applyUpdate()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white px-3 py-1 text-[11px] font-medium text-black transition-colors hover:bg-white/85"
                >
                  <RefreshCw size={11} /> Update now
                </button>
              )}
              {!updating && (
                <button
                  type="button"
                  onClick={dismiss}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/70 transition-colors hover:border-white/30 hover:text-white"
                >
                  {desktop?.desktop ? 'Later' : 'Got it'}
                </button>
              )}
              <a
                href={desktop?.releaseNotesUrl || `https://github.com/${REPO}/releases/tag/${latest}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-white/80 underline decoration-white/30 underline-offset-2 hover:text-white"
              >
                Release notes
              </a>
            </div>
          )}

          {phase === 'done' && (
            <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-white/60">
              <Check size={11} /> Done — your keys and work are untouched.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss update notice"
          className="shrink-0 cursor-pointer rounded-full p-0.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
