import { useEffect } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

/**
 * GSAP ScrollTrigger choreography for the logged-out homepage ONLY.
 *
 * - Section reveals: each direct child of a [data-gsap-reveal] block gets its
 *   own trigger, so a block animates in exactly when the user's scroll brings
 *   it into the viewport — not once for the whole section while half of it is
 *   still below the fold. Reveals fire once and stay put (no reverse-on-leave),
 *   which is what makes the choreography read as deliberate rather than
 *   glitchy when scrolling back up.
 * - Asset parallax: [data-parallax] elements (screenshots, gateway rail) drift
 *   against scroll for depth. Scrubbed, so it is inherently direction-aware.
 * - Word reveals: [data-gsap-words] headings split into per-word spans that
 *   rise + un-rotate in sequence. The heading keeps its text in the a11y tree
 *   via aria-label; the split spans sit inside an aria-hidden wrapper.
 * - Hairline wipes: [data-gsap-rule] rules scale in from their center.
 * - Child cascades: [data-gsap-stagger] containers fade their direct children
 *   in one step apart — used on grids and lists whose parent section already
 *   carries a section-level reveal (different elements, so the tweens compose).
 *
 * Honors prefers-reduced-motion: everything renders at its final state, no
 * triggers created. Cleans up via gsap.context() revert on unmount.
 */
export default function HomepageScrollAnimations() {
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const ctx = gsap.context(() => {
      const sections = gsap.utils.toArray<HTMLElement>('[data-gsap-reveal]')
      sections.forEach((section) => {
        const targets = section.querySelectorAll<HTMLElement>(':scope > *')
        if (!targets.length) return

        if (reduce) {
          gsap.set(targets, { opacity: 1, y: 0, clearProps: 'transform' })
          return
        }

        // One trigger per child: each block reveals as the user's scroll
        // reaches it, and stays revealed. No section-wide stagger firing
        // early, no reverse on the way back up.
        targets.forEach((target) => {
          gsap.fromTo(
            target,
            { opacity: 0, y: 34 },
            {
              opacity: 1,
              y: 0,
              duration: 0.72,
              ease: 'power3.out',
              scrollTrigger: {
                trigger: target,
                start: 'top 88%',
                toggleActions: 'play none none none',
              },
            }
          )
        })
      })

      const parallax = gsap.utils.toArray<HTMLElement>('[data-parallax]')
      parallax.forEach((el) => {
        if (reduce) return
        const speed = parseFloat(el.dataset.parallax || '0.1')
        // Overscan so the drift never exposes the window's edges. Default
        // 1.14 suits the old heavy drift; showcase shots carry their own
        // data-parallax-scale so the crop stays ~4% per side instead.
        if (el.tagName === 'IMG') gsap.set(el, { scale: parseFloat(el.dataset.parallaxScale || '1.14') })
        gsap.fromTo(
          el,
          { yPercent: -speed * 100 },
          {
            yPercent: speed * 100,
            ease: 'none',
            scrollTrigger: {
              trigger: el,
              start: 'top bottom',
              end: 'bottom top',
              scrub: true,
            },
          }
        )
      })

      // Per-word heading reveal. Only headings with plain-text children carry
      // the attribute, so textContent is the whole heading. The wrap span is
      // aria-hidden and the element itself gets an aria-label of the original
      // text, so screen readers hear exactly what they always did.
      const words = gsap.utils.toArray<HTMLElement>('[data-gsap-words]')
      words.forEach((el) => {
        if (reduce) return
        const text = (el.textContent || '').trim()
        if (!text) return
        el.setAttribute('aria-label', text)
        const wrap = document.createElement('span')
        wrap.setAttribute('aria-hidden', 'true')
        const parts = text.split(/\s+/)
        parts.forEach((word, i) => {
          const s = document.createElement('span')
          s.className = 'gsap-word'
          s.textContent = word
          wrap.appendChild(s)
          if (i < parts.length - 1) wrap.appendChild(document.createTextNode(' '))
        })
        el.replaceChildren(wrap)

        gsap.fromTo(
          wrap.children,
          { opacity: 0, y: '0.65em', rotateX: -32, transformPerspective: 700 },
          {
            opacity: 1,
            y: 0,
            rotateX: 0,
            duration: 0.85,
            ease: 'power3.out',
            stagger: 0.045,
            scrollTrigger: {
              trigger: el,
              start: 'top 86%',
              toggleActions: 'play none none none',
            },
          }
        )
      })

      // Hairline rules wipe in from their center.
      const rules = gsap.utils.toArray<HTMLElement>('[data-gsap-rule]')
      rules.forEach((el) => {
        if (reduce) return
        gsap.fromTo(
          el,
          { scaleX: 0 },
          {
            scaleX: 1,
            duration: 1.1,
            ease: 'power2.inOut',
            transformOrigin: 'center center',
            scrollTrigger: {
              trigger: el,
              start: 'top 92%',
              toggleActions: 'play none none none',
            },
          }
        )
      })

      // Child cascade for grids/lists. clearProps:'transform' clears the
      // inline transform GSAP leaves behind, which would otherwise override
      // the CSS hover:-translate-y-px lift on bento tiles and feature cards.
      const staggers = gsap.utils.toArray<HTMLElement>('[data-gsap-stagger]')
      staggers.forEach((el) => {
        const targets = el.querySelectorAll<HTMLElement>(':scope > *')
        if (!targets.length) return
        if (reduce) {
          gsap.set(targets, { opacity: 1, y: 0 })
          return
        }
        gsap.fromTo(
          targets,
          { opacity: 0, y: 26 },
          {
            opacity: 1,
            y: 0,
            duration: 0.65,
            ease: 'power3.out',
            stagger: 0.09,
            clearProps: 'transform',
            scrollTrigger: {
              trigger: el,
              start: 'top 82%',
              toggleActions: 'play none none none',
            },
          }
        )
      })
    })

    // Recompute trigger positions once lazy images/fonts have settled.
    const refresh = window.setTimeout(() => ScrollTrigger.refresh(), 300)
    const onLoad = () => ScrollTrigger.refresh()
    window.addEventListener('load', onLoad)

    return () => {
      window.clearTimeout(refresh)
      window.removeEventListener('load', onLoad)
      ctx.revert()
    }
  }, [])

  return null
}
