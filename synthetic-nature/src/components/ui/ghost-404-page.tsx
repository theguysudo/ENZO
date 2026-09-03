import React from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Ghost } from 'lucide-react'
import { FlowButton } from '@/components/ui/flow-button'
import { cn } from '@/lib/utils'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'

/**
 * NotFound — where the pricing page's Buy buttons land.
 *
 * The gag is structural, not decorative: the pricing grid looks like every
 * other SaaS pricing grid right up until you try to pay, and then the checkout
 * turns out to be the thing that does not exist. There is no payment flow to
 * build because there is nothing to charge for.
 *
 * Adapted from the Next.js original: `next/image` for the ghost PNG became the
 * lucide `Ghost` glyph (no external asset to rot), `next/link` became callbacks
 * the SPA already routes with, and the white/Signika palette became the
 * homepage's Garamond-on-dark grammar. Motion variants are unchanged.
 */

const containerVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.7,
      ease: [0.43, 0.13, 0.23, 0.96],
      delayChildren: 0.1,
      staggerChildren: 0.1,
    },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.43, 0.13, 0.23, 0.96] },
  },
}

const numberVariants = {
  hidden: (direction: number) => ({
    opacity: 0,
    x: direction * 40,
    y: 15,
    rotate: direction * 5,
  }),
  visible: {
    opacity: 0.7,
    x: 0,
    y: 0,
    rotate: 0,
    transition: { duration: 0.8, ease: [0.43, 0.13, 0.23, 0.96] },
  },
}

const ghostVariants = {
  hidden: { scale: 0.8, opacity: 0, y: 15, rotate: -5 },
  visible: {
    scale: 1,
    opacity: 1,
    y: 0,
    rotate: 0,
    transition: { duration: 0.6, ease: [0.43, 0.13, 0.23, 0.96] },
  },
  hover: {
    scale: 1.1,
    rotate: [0, -5, 5, -5, 0],
    transition: {
      duration: 0.8,
      ease: 'easeInOut',
      rotate: { duration: 2, ease: 'linear', repeat: Infinity, repeatType: 'reverse' as const },
    },
  },
  floating: {
    y: [-5, 5],
    transition: {
      y: { duration: 2, ease: 'easeInOut', repeat: Infinity, repeatType: 'reverse' as const },
    },
  },
}

export function NotFound({
  onHome,
  onDocs,
}: {
  onHome?: () => void
  onDocs?: () => void
}) {
  const reduceMotion = useReducedMotion()
  const overlayRef = React.useRef<HTMLDivElement>(null)

  // isLight prop removed (kept for reference) — hardcoded to dark theme
  // const heading = isLight ? 'text-slate-900' : 'text-white'
  // const muted = isLight ? 'text-slate-400' : 'text-white/30'
  const heading = 'text-white'
  const muted = 'text-white/30'

  useGSAP(() => {
    if (reduceMotion || !overlayRef.current) return
    gsap.fromTo(
      overlayRef.current,
      { opacity: 0 },
      { opacity: 1, duration: 1.2, ease: 'power2.out' }
    )
  }, [reduceMotion])

  return (
    <div className="flex min-h-[80vh] w-full flex-col items-center justify-center px-6 py-28 relative">
      <div
        ref={overlayRef}
        className="absolute inset-0 bg-black/60 z-0 pointer-events-none"
        aria-hidden="true"
      />
      <AnimatePresence mode="wait">
        <motion.div
          className="text-center relative z-10"
          variants={containerVariants}
          initial={reduceMotion ? 'visible' : 'hidden'}
          animate="visible"
          exit="hidden"
        >
          {/* 4 👻 4 */}
          <div className="mb-8 flex items-center justify-center gap-4 md:mb-12 md:gap-6">
            <motion.span
              className={cn(
                'select-none font-garamond text-[80px] font-normal leading-none opacity-70 md:text-[120px]',
                heading,
              )}
              variants={numberVariants}
              custom={-1}
            >
              4
            </motion.span>
            <motion.div
              variants={ghostVariants}
              whileHover="hover"
              animate={reduceMotion ? 'visible' : ['visible', 'floating']}
            >
              <Ghost
                aria-hidden="true"
                strokeWidth={1}
                className={cn(
                  'h-[80px] w-[80px] select-none md:h-[120px] md:w-[120px]',
                  // isLight ? 'text-indigo-500/70' : 'text-indigo-300/60',
                  'text-indigo-300/60',
                )}
              />
            </motion.div>
            <motion.span
              className={cn(
                'select-none font-garamond text-[80px] font-normal leading-none opacity-70 md:text-[120px]',
                heading,
              )}
              variants={numberVariants}
              custom={1}
            >
              4
            </motion.span>
          </div>

          <motion.div variants={itemVariants} className={cn('font-mono text-[10px] uppercase tracking-[0.3em]', 'text-indigo-300/60')}>
            Checkout not found
          </motion.div>

          <motion.h1
            className={cn(
              'mx-auto mt-5 max-w-2xl font-garamond text-4xl font-normal leading-[1.06] sm:text-[3.4rem]',
              heading,
            )}
            variants={itemVariants}
          >
            Boo. The paywall was a ghost.
          </motion.h1>

          

          <motion.p
            className={cn('mx-auto mt-5 max-w-md font-garamond text-[19px] font-normal italic leading-[1.6]', muted)}
            variants={itemVariants}
          >
            Nothing to pay, so nothing to page. Keep your keys, keep your cash — we were
            only ever the terminal.
          </motion.p>

          <motion.div variants={itemVariants} className="mt-11 flex flex-wrap items-center justify-center gap-4">
            <FlowButton text="Back to the free part" onClick={onHome} />
            <button
              type="button"
              onClick={onDocs}
              className={cn(
                'inline-flex items-center rounded-full border px-7 py-3 font-mono text-[11px] uppercase tracking-[0.2em] transition-all hover:-translate-y-0.5',
                // isLight
                //   ? 'border-black/12 text-slate-700 hover:border-black/25 hover:bg-black/[0.03]'
                //   : 'border-white/12 text-white/85 hover:border-white/25 hover:bg-white/5',
                'border-white/12 text-white/85 hover:border-white/25 hover:bg-white/5',
              )}
            >
              Back to docs
            </button>
          </motion.div>

          <motion.div
            className={cn(
              'mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[9px] uppercase tracking-[0.22em]',
              muted,
            )}
            variants={itemVariants}
          >
            <span>404 · invoice not found</span>
            <span>Never built</span>
            <span>Never will be</span>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

export default NotFound
