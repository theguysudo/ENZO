'use client'

import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'

interface DocsDimOverlayProps {
  /** Scroll depth past the intro masthead, 0 → 1. Target opacity = 0.78 × depth. */
  depth: number
}

/**
 * GSAP dim overlay for the Docs view — a fixed full-viewport black scrim whose
 * opacity is tweened by GSAP in response to scroll depth. Dimming starts once
 * the user scrolls past the "How ENZO works" intro (depth > 0) and ramps to
 * 0.78 at full depth, so the animated theme background (HomepageThemeRenderer),
 * scroll dim, vignette and film grain — all at z-0..z-4 — fade behind a dark
 * veil and pale doc text reads cleanly. Closing fades it back out.
 *
 * The Docs panel itself renders at z-10, above the overlay, so it stays fully
 * interactive. pointer-events: none is kept permanently so the scrim never
 * captures scroll/click.
 *
 * Layering: z-[6] puts this above the scroll dim (z-3), vignette (4) and film
 * grain (inline zIndex 5) so those are dimmed too, and below the main content
 * container (z-10). It has to be an arbitrary value — Tailwind's default
 * z-index scale is 0/10/20/30/40/50, so `z-5` compiles to nothing at all and
 * the scrim silently lands at `z-index: auto`, underneath the grain.
 */
export function DocsDimOverlay({ depth }: DocsDimOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = overlayRef.current
    if (!el) return

    const target = 0.78 * Math.max(0, Math.min(1, depth))

    // Respect motion preference: snap to the target opacity with no tween.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gsap.set(el, { opacity: target })
      return
    }

    gsap.killTweensOf(el)
    gsap.to(el, {
      opacity: target,
      duration: target > 0 ? 0.9 : 0.6,
      ease: target > 0 ? 'power2.out' : 'power2.inOut',
      onStart: () => (el.style.pointerEvents = 'none'),
      overwrite: 'auto',
    })
  }, [depth])

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[6] bg-black pointer-events-none opacity-0"
      style={{ willChange: 'opacity' }}
      aria-hidden="true"
    />
  )
}
