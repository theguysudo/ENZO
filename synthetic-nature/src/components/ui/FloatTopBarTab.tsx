import React, { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ChevronDown } from 'lucide-react'

interface FloatTopBarTabProps {
  open: boolean
  onToggle: () => void
}

/**
 * Floating access tab for the maximized terminal's hidden header bar
 * (Terminal / Marketplace / Vault nav) — a sleek top-center handle with a
 * gradient line + down-arrow. Deliberately SEPARATE from the mac traffic
 * lights (those only minimize/maximize/restore).
 *
 * Behaviour:
 *  - Rises in when the fullscreen terminal mounts.
 *  - Clicking slides the header drawer open; the arrow flips while open.
 *  - After 5s without interaction it auto-hides completely.
 *  - A hidden hover strip left behind wakes it fully.
 */
export const FloatTopBarTab: React.FC<FloatTopBarTabProps> = ({ open, onToggle }) => {
  const tabRef = useRef<HTMLElement | null>(null)
  const lineRef = useRef<HTMLSpanElement | null>(null)
  const ghostTimer = useRef<number | null>(null)
  const hoveredRef = useRef(false)
  const [visible, setVisible] = useState(true)

  const clearTimer = () => {
    if (ghostTimer.current) {
      window.clearTimeout(ghostTimer.current)
      ghostTimer.current = null
    }
  }

  const armGhost = () => {
    clearTimer()
    ghostTimer.current = window.setTimeout(() => {
      if (!hoveredRef.current && tabRef.current && !open) {
        gsap.to(tabRef.current, { opacity: 0, y: -16, duration: 0.5, ease: 'power2.inOut' })
        setVisible(false)
      }
    }, 5000)
  }

  const wake = () => {
    hoveredRef.current = true
    if (!visible) setVisible(true)
    if (tabRef.current) {
      gsap.to(tabRef.current, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', overwrite: 'auto' })
    }
    armGhost()
  }

  const leave = () => {
    hoveredRef.current = false
    armGhost()
  }

  useEffect(() => {
    const el = tabRef.current
    if (!el) return
    gsap.fromTo(el, { opacity: 0, y: -12 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power3.out' })
    if (lineRef.current) {
      gsap.fromTo(lineRef.current, { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: 'power2.out', delay: 0.15 })
    }
    armGhost()
    return clearTimer
  }, [])

  // Reset visibility when header opens
  useEffect(() => {
    if (open && !visible) {
      setVisible(true)
      if (tabRef.current) {
        gsap.to(tabRef.current, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', overwrite: 'auto' })
      }
    }
  }, [open])

  if (!visible) {
    return (
      <div
        ref={(el) => { tabRef.current = el }}
        onMouseEnter={wake}
        onMouseMove={wake}
        onMouseLeave={leave}
        className="absolute top-2 left-1/2 -translate-x-1/2 z-[70] w-16 h-2 cursor-pointer"
        style={{ opacity: 0 }}
      />
    )
  }

  return (
    <button
      ref={(el) => { tabRef.current = el }}
      type="button"
      onClick={onToggle}
      onMouseEnter={wake}
      onMouseMove={wake}
      onMouseLeave={leave}
      title={open ? 'Hide terminal header bar' : 'Open terminal header bar (Terminal / Marketplace / Vault)'}
      aria-expanded={open}
      className="absolute top-2 left-1/2 -translate-x-1/2 z-[70] flex items-center gap-2 px-3.5 py-2 rounded-full border border-white/10 bg-black/70 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-white/[0.03] cursor-pointer group select-none transition-all duration-300"
    >
      <span
        ref={lineRef}
        className="h-[2px] w-10 origin-left rounded-full bg-gradient-to-r from-transparent via-white/60 to-transparent"
      />
      <ChevronDown
        size={14}
        strokeWidth={2.5}
        className={`text-white/70 group-hover:text-white transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
      />
    </button>
  )
}