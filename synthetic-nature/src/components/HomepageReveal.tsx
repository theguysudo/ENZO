import { motion, useReducedMotion } from 'framer-motion'

const VARIANTS = {
  section: motion.section,
  div: motion.div,
  footer: motion.footer,
  header: motion.header,
} as const

/**
 * Scroll-triggered entrance for below-the-fold blocks on the logged-out
 * homepage: a subtle fade + ~20px rise the first time the element enters
 * the viewport, none of it repeating afterward.
 *
 * Under prefers-reduced-motion the element renders fully visible — no
 * transform, no delayed initial state, nothing to snap.
 */
export function HomepageReveal({
  children,
  className,
  as = 'section',
  ...rest
}: {
  children: React.ReactNode
  className?: string
  as?: keyof typeof VARIANTS
  [key: string]: unknown
}) {
  const reduceMotion = useReducedMotion()
  const Component = VARIANTS[as] as any
  const props = {
    className,
    ...rest,
    ...(reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 20 },
          whileInView: { opacity: 1, y: 0 },
          viewport: { once: true, amount: 0.12 },
          transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
        }),
  }
  return <Component {...props}>{children}</Component>
}
