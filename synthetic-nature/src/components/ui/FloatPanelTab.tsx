import React, { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ChevronRight } from 'lucide-react'

interface FloatPanelTabProps {
  open: boolean
  onToggle: () => void
}

/**
 * Floating access tab for the maximized terminal's hidden overview panel.
 *
 * A sleek left-edge handle (gradient line + arrow) — deliberately SEPARATE
 * from the mac traffic lights (those only minimize/maximize/restore).
 *
 * Behaviour:
 *  - Rises in when the fullscreen terminal mounts.
 *  - Clicking opens the overview panel; the arrow flips while open.
 *  - After 5s without interaction it auto-hides completely.
 *  - Hovering over the hidden area wakes it fully.
 */
export const FloatPanelTab: React.FC<FloatPanelTabProps> = ({ open, onToggle }) => {
  const tabRef = useRef<HTMLElement | null>(null)
  const lineRef = useRef<HTMLSpanElement | null>(null)
  const ghostTimer = useRef<number | null>(null)
  const [hovered, setHovered] = useState(false)
  const [visible, setVisible] = useState(true)
  const hoveredRef = useRef(false)

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
        gsap.to(tabRef.current, { opacity: 0, x: -16, duration: 0.5, ease: 'power2.inOut' })
        setVisible(false)
      }
    }, 5000)
  }

  const wake = () => {
    hoveredRef.current = true
    setHovered(true)
    if (!visible) {
      setVisible(true)
    }
    if (tabRef.current) {
      gsap.to(tabRef.current, { opacity: 1, x: 0, duration: 0.3, ease: 'power2.out', overwrite: 'auto' })
    }
    armGhost()
  }

  const leave = () => {
    hoveredRef.current = false
    setHovered(false)
    armGhost()
  }

  useEffect(() => {
    const el = tabRef.current
    if (!el) return
    gsap.fromTo(el, { opacity: 0, x: -12 }, { opacity: 1, x: 0, duration: 0.45, ease: 'power3.out' })
    if (lineRef.current) {
      gsap.fromTo(lineRef.current, { scaleY: 0 }, { scaleY: 1, duration: 0.5, ease: 'power2.out', delay: 0.15 })
    }
    armGhost()
    return clearTimer
  }, [])

  // Reset visibility when panel opens
  useEffect(() => {
    if (open && !visible) {
      setVisible(true)
      if (tabRef.current) {
        gsap.to(tabRef.current, { opacity: 1, x: 0, duration: 0.3, ease: 'power2.out', overwrite: 'auto' })
      }
    }
  }, [open])

  if (!visible && !hovered) {
    return (
      <div
        ref={(el) => { tabRef.current = el }}
        onMouseEnter={wake}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-[70] w-2 h-16 cursor-pointer"
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
      title={open ? 'Hide terminal panel' : 'Open terminal panel (marketplace / mobile menu)'}
      aria-expanded={open}
      className="absolute left-1 top-1/2 -translate-y-1/2 z-[70] flex items-center gap-2 pl-2 pr-3 py-3 rounded-r-full border border-white/10 bg-black/70 backdrop-blur-2xl shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-white/[0.03] cursor-pointer group select-none transition-all duration-300"
      style={{ transformOrigin: 'left center' }}
    >
      <span
        ref={lineRef}
        className="w-[2px] h-10 origin-top rounded-full bg-gradient-to-b from-transparent via-emerald-400/60 to-transparent"
      />
      <ChevronRight
        size={14}
        strokeWidth={2.5}
        className={`text-white/70 group-hover:text-white transition-transform duration-300 ${open ? 'rotate-90' : ''}`}
      />
    </button>
  )
}