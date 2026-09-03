import { useEffect } from 'react'

/**
 * Toggles `data-craft` on <body> while `active` is true.
 *
 * Every homepage-polish CSS rule that touches shared chrome (nav, footer,
 * scrollbar, selection, scroll-behavior, light-theme contrast) is gated on the
 * attribute being *present* — those rules are right on any crafted landing
 * surface. Rules that target the homepage's own sections are gated on the
 * exact value `"home"`, so they cannot reach the Docs document body.
 * The attribute is removed on cleanup or when `active` flips false.
 */
export function useCraftHomepageFlag(active: boolean, surface: 'home' | 'docs' = 'home') {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const body = document.body
    const PREV = body.getAttribute('data-craft')
    if (active) {
      body.setAttribute('data-craft', surface)
    }
    return () => {
      if (PREV === null) {
        body.removeAttribute('data-craft')
      } else {
        body.setAttribute('data-craft', PREV)
      }
    }
  }, [active, surface])
}
