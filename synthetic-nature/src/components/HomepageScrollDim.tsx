import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

/**
 * Scroll-driven background dim for the logged-out homepage. As the visitor
 * scrolls down past the "The full intelligence stack" statement (the top of
 * the feature showcase), a fixed dark overlay fades in up to ~72% so the
 * editor copy pops against the animated video/WebGL backdrop.
 *
 * - Tween is scrubbed to scroll position (smooth GSAP transition).
 * - Honors prefers-reduced-motion: snaps instead of scrubbed animation.
 * - z-index sits above the theme renderer (z-0) but below vignette (z-4),
 *   grain (z-5) and content (z-10) so text stays bright.
 */
export default function HomepageScrollDim() {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const ctx = gsap.context(() => {
      if (reduced) {
        ScrollTrigger.create({
          trigger: '#showcase-statement',
          start: 'top 70%',
          end: 'top 10%',
          onEnter: () => gsap.set(overlay, { opacity: 0.72 }),
          onLeaveBack: () => gsap.set(overlay, { opacity: 0 }),
        })
        return
      }
      gsap.to(overlay, {
        opacity: 0.72,
        ease: 'none',
        scrollTrigger: {
          trigger: '#showcase-statement',
          start: 'top 70%',
          end: 'top 10%',
          scrub: 0.8,
        },
      })
    })

    return () => ctx.revert()
  }, [])

  return (
    <div
      ref={overlayRef}
      aria-hidden="true"
      className="fixed inset-0 z-[3] pointer-events-none"
      style={{ opacity: 0, backgroundColor: 'rgb(4, 5, 10)' }}
    />
  )
}