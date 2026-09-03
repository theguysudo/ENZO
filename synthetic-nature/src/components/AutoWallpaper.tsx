import { useEffect, useRef, useState } from 'react'
import { fetchUnsplashWallpaper, UnsplashUnavailableError, type UnsplashWallpaper } from '../lib/unsplash'
import { fadeSwap } from '../lib/gsapTransitions'

/**
 * Non-interactive auto-wallpaper layer.
 *
 * - active on the logged-out homepage AND the workspace surfaces (marketplace
 *   / terminal) — not just one — since the toggle lives inside Marketplace.
 * - listens to `storage` so toggling the setting in one tab updates others.
 * - reads config fresh from localStorage on every activation, so flipping the
 *   toggle takes effect without a full reload too (when the key changes in the
 *   SAME tab we also poll once via `storage` self-dispatch below).
 * - renders a soft image layer between the theme background (z-0) and content.
 */

const KEY_ENABLED = 'enzo.wallpaper.auto'
const KEY_QUERY = 'enzo.wallpaper.query'
const KEY_INTERVAL = 'enzo.wallpaper.interval'
const KEY_LAST = 'enzo.wallpaper.last'
const KEY_CURRENT = 'enzo.wallpaper.current'

const HOUR = 60 * 60 * 1000

function isDue(interval: string, last: number): boolean {
  if (interval === 'visit') return true
  if (!last) return true
  if (interval === 'hourly') return Date.now() - last >= HOUR
  if (interval === 'daily') return Date.now() - last >= 24 * HOUR
  return true
}

/** Same-tab immediate notification (`storage` only fires cross-tab). */
export const WALLPAPER_EVENT = 'enzo-wallpaper-changed'

export function emitWallpaperChanged() {
  window.dispatchEvent(new CustomEvent(WALLPAPER_EVENT))
}

export function AutoWallpaper({ active }: { active: boolean }) {
  const [wall, setWall] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    if (localStorage.getItem(KEY_ENABLED) !== 'true') return null
    try {
      const raw = localStorage.getItem(KEY_CURRENT)
      return raw ? (JSON.parse(raw) as UnsplashWallpaper).url ?? null : null
    } catch {
      return null
    }
  })
  const imgRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!active) return

    let cancelled = false

    const applyFromStorage = () => {
      if (cancelled) return
      const enabled = localStorage.getItem(KEY_ENABLED) === 'true'
      if (!enabled) {
        setWall(null)
        return
      }
      try {
        const raw = localStorage.getItem(KEY_CURRENT)
        const next = raw ? (JSON.parse(raw) as UnsplashWallpaper).url ?? null : null
        setWall(next)
      } catch {
        /* malformed cache — keep current */
      }
    }

    const refreshIfDue = () => {
      if (cancelled) return
      if (localStorage.getItem(KEY_ENABLED) !== 'true') return
      const query = localStorage.getItem(KEY_QUERY) || 'nature landscape 4k'
      const interval = localStorage.getItem(KEY_INTERVAL) || 'daily'
      const last = parseInt(localStorage.getItem(KEY_LAST) || '0', 10) || 0
      if (!isDue(interval, last)) return

      fetchUnsplashWallpaper(query)
        .then((w) => {
          if (cancelled) return
          try {
            localStorage.setItem(KEY_CURRENT, JSON.stringify(w))
            localStorage.setItem(KEY_LAST, String(Date.now()))
          } catch {
            /* storage full — ignore */
          }
          fadeSwap(imgRef.current, () => setWall(w.url))
        })
        .catch((err) => {
          if (err instanceof UnsplashUnavailableError) {
            // Server has no key configured — stay silent.
            return
          }
          console.warn('[AutoWallpaper]', err)
        })
    }

    // React to cross-tab changes AND same-tab writes (storage doesn't fire in
    // the writing tab) by listening to both `storage` and a quick initial pass.
    const onChanged = () => {
      applyFromStorage()
      refreshIfDue()
    }
    window.addEventListener('storage', onChanged)
    window.addEventListener(WALLPAPER_EVENT, onChanged)
    applyFromStorage()
    refreshIfDue()

    return () => {
      cancelled = true
      window.removeEventListener('storage', onChanged)
      window.removeEventListener(WALLPAPER_EVENT, onChanged)
    }
  }, [active])

  // When there is no cached image yet (e.g. first enable in a fresh browser),
  // fetch one immediately rather than waiting out the refresh cadence.
  useEffect(() => {
    if (!active || wall) return
    if (localStorage.getItem(KEY_ENABLED) !== 'true') return
    let cancelled = false
    fetchUnsplashWallpaper(localStorage.getItem(KEY_QUERY) || 'nature landscape 4k')
      .then((w) => {
        if (cancelled) return
        try {
          localStorage.setItem(KEY_CURRENT, JSON.stringify(w))
          localStorage.setItem(KEY_LAST, String(Date.now()))
        } catch {
          /* storage full — ignore */
        }
        fadeSwap(imgRef.current, () => setWall(w.url))
      })
      .catch((err) => {
        if (cancelled) return
        if (!(err instanceof UnsplashUnavailableError)) console.warn('[AutoWallpaper]', err)
      })
    return () => {
      cancelled = true
    }
  }, [active, wall])

  if (!active || !wall) return null

  return (
    <div ref={imgRef} className="fixed inset-0 z-[1] pointer-events-none overflow-hidden" aria-hidden="true">
      <img src={wall} alt="" className="h-full w-full object-cover opacity-40" draggable={false} />
      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/70" />
    </div>
  )
}

export default AutoWallpaper
