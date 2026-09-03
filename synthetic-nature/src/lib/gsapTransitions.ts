import { gsap } from 'gsap'

/**
 * Fade an element out, run a DOM/state swap, then fade it back in.
 * Cheap shared transition for wallpaper swaps and scene-switch feedback.
 * Safe no-op when the element is null (unmounted / SSR).
 */
export function fadeSwap(el: Element | null, applyFn: () => void): void {
  if (!el) {
    applyFn()
    return
  }
  gsap.to(el, {
    opacity: 0,
    duration: 0.22,
    ease: 'power1.in',
    onComplete: () => {
      applyFn()
      gsap.to(el, { opacity: 1, duration: 0.32, ease: 'power1.out' })
    },
  })
}

/**
 * Staggered fade+rise entrance for a list of sibling elements (onboarding
 * Step 4's optional-provider cards). Same reduced-motion contract as fadeIn.
 * Returns the tween so callers can kill it on unmount.
 */
export function staggerIn(els: ArrayLike<Element>): gsap.core.Tween | null {
  if (!els || els.length === 0) return null
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    gsap.set(els, { opacity: 1, y: 0, scale: 1 })
    return null
  }
  return gsap.fromTo(
    els,
    { opacity: 0, y: 24, scale: 0.97 },
    {
      opacity: 1,
      y: 0,
      scale: 1,
      duration: 0.55,
      ease: 'power3.out',
      stagger: 0.09,
      overwrite: 'auto',
      clearProps: 'transform',
    }
  )
}

/**
 * Subtle 600ms fade+scale entrance (used by the loading view).
 * Honors prefers-reduced-motion: snaps to final state instead of animating.
 * Safe no-op when the element is null (unmounted / SSR).
 */
export function fadeIn(el: Element | null): void {
  if (!el) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    gsap.set(el, { opacity: 1, scale: 1 })
    return
  }
  gsap.fromTo(
    el,
    { opacity: 0, scale: 0.985 },
    { opacity: 1, scale: 1, duration: 0.6, ease: 'power2.out', overwrite: 'auto' }
  )
}
