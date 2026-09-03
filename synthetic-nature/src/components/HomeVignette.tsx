import { memo } from 'react'

/**
 * Cinematic vignette for the logged-out homepage — a fixed radial fall-off
 * that deepens frame edges so the video background feels lensed instead of
 * flat-screen. Cosmetic only: pointer-events are disabled and it carries no
 * layout box influence.
 *
 * `tone: 'dark'` for the deep-space hero, `'light'` for anime-sky.
 */
function HomeVignette({ tone = 'dark' as 'dark' | 'light' }) {
  return (
    <div
      aria-hidden="true"
      className={`home-vignette${tone === 'light' ? ' home-vignette-light' : ''}`}
      style={{ position: 'fixed', inset: 0, zIndex: 4, pointerEvents: 'none' }}
    />
  )
}

export default memo(HomeVignette)
