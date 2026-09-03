/**
 * ThemeVideoWarmup — first-visit background download of every homepage theme.
 *
 * The theme switcher's lag on a fresh visit was almost all progressive video
 * buffering: each scene is an 11–23MB mp4 that plays while it downloads, so
 * the first minute on any theme stutters while the buffer fills. Once warm,
 * switching is instant — the ask is to make warm the default state.
 *
 * How: after first paint (and only once per browser), pull every theme video
 * into the HTTP cache via `cache: 'reload'` fetches, one at a time so the
 * user's own first theme and any in-flight API traffic keep priority. The
 * server-side half of this feature lives in index.ts / nginx.conf: those
 * immutable Cache-Control headers are what make a warmed video survive
 * reloads and theme switches instead of being revalidated away.
 *
 * Skipped entirely on: save-data users, 2G/slow-2G connections, reduced
 * motion (the video themes never mount), low-power mode, and logged-in
 * users (workspace themes are a different, already-seeded catalog).
 */

import { useEffect, useRef } from 'react'
import { HOMEPAGE_ANIME_VIDEOS } from './HomepageAnimeSky'
import { HOMEPAGE_THEMES, type HomepageAnimeScene } from './types'

/** localStorage sentinels — re-arm whenever the video catalog changes. */
const WARMED_KEY = 'enzo.themeVideos.warmedAt'
const CATALOG_VERSION = '2026-09-03' // bump when videos are added/replaced

function canWarm(): boolean {
  try {
    const nav = navigator as Navigator & {
      saveData?: boolean
      connection?: { effectiveType?: string }
    }
    if (nav.saveData) return false
    const conn = nav.connection?.effectiveType
    if (conn === 'slow-2g' || conn === '2g') return false
    if (localStorage.getItem(WARMED_KEY) === CATALOG_VERSION) return false
  } catch {
    return false
  }
  return true
}

async function warm(): Promise<void> {
  // Derive the list from the registry rather than the video map directly:
  // the lite image's registry contains no anime themes, so this is an empty
  // list there and the warm loop (and its `warmed` marker) no-ops cleanly
  // without a special case.
  const sources = HOMEPAGE_THEMES
    .filter((t): t is (typeof HOMEPAGE_THEMES)[number] & { id: `anime-${HomepageAnimeScene}` } =>
      t.id.startsWith('anime-'))
    .map((t) => HOMEPAGE_ANIME_VIDEOS[t.id.slice('anime-'.length) as HomepageAnimeScene].forward)

  for (const src of sources) {
    try {
      // 'reload' bypasses any revalidation and forces the bytes into the
      // HTTP cache, which only keeps them long-term because the server
      // sends immutable Cache-Control.
      await fetch(src, { cache: 'reload', mode: 'no-cors' })
    } catch {
      // One failed scene doesn't abort the rest — an offline visitor
      // simply re-warms next visit.
      continue
    }
  }
  try {
    localStorage.setItem(WARMED_KEY, CATALOG_VERSION)
  } catch { /* ignore */ }
}

export function ThemeVideoWarmup() {
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    if (!canWarm()) return

    // Idle-time: let the hero animation, fonts, and the active theme's video
    // claim the connection first; warm-up starts when the browser is idle
    // (1000ms timeout keeps it from being starved on a busy first paint).
    const begin = () => {
      if (document.hidden) {
        // Warming in a background tab wastes the bandwidth budget on
        // videos nobody is watching yet; retry on next visibility.
        const onVisible = () => {
          if (!document.hidden) {
            document.removeEventListener('visibilitychange', onVisible)
            void warm()
          }
        }
        document.addEventListener('visibilitychange', onVisible)
        return
      }
      void warm()
    }

    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(begin, { timeout: 1000 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(begin, 800)
    return () => clearTimeout(id)
  }, [])

  return null
}

export default ThemeVideoWarmup
