import React, { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronDown,
  Flower2,
  Landmark,
  Zap,
  CloudDrizzle,
  Rocket,
  Sparkles,
  Star,
  Bot,
  Orbit,
  Satellite,
  Terminal,
} from 'lucide-react'
import { LimelightNav, type NavItem } from './ui/limelight-nav'
import { WORKSPACE_THEMES } from '../themes/marketplace'

interface HeaderThemeSelectorProps {
  activeId: string
  onChange: (id: string) => void
}

const THEME_META: Record<string, { icon: React.ReactElement; label: string; accent: string }> = {
  spring_day:     { icon: <Flower2 />,     label: 'Default Particles',  accent: '#4ade80' },
  alien_contact:  { icon: <Bot />,         label: 'Alien Contact',      accent: '#4ade80' },
  rocket:         { icon: <Orbit />,       label: 'Rocket Loop',        accent: '#fb923c' },
  space_probe:    { icon: <Satellite />,   label: 'Space Probe',        accent: '#38bdf8' },
  coding_deck:    { icon: <Terminal />,    label: 'Coding Deck',        accent: '#a78bfa' },
  rooftop_dojo:   { icon: <Landmark />,    label: 'Rooftop Dojo',       accent: '#f59e0b' },
  neon_boulevard: { icon: <Zap />,         label: 'Neon Boulevard',     accent: '#a78bfa' },
  ink_rain:       { icon: <CloudDrizzle />,label: 'Ink Rain',           accent: '#67e8f9' },
  space_station:  { icon: <Rocket />,      label: 'Space Station',      accent: '#f472b6' },
  purple_flowers: { icon: <Sparkles />,    label: 'Purple Flowers',     accent: '#c084fc' },
  milky_way:      { icon: <Star />,        label: 'Milky Way',          accent: '#e2e8f0' },
}

/**
 * Header theme selector with animated arrow button and horizontal LimelightNav dropdown.
 * Auto-closes after 5 seconds of idle time.
 */
export function HeaderThemeSelector({ activeId, onChange }: HeaderThemeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const currentAccent = THEME_META[activeId]?.accent ?? '#4ade80'

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const startTimer = useCallback(() => {
    clearTimer()
    timerRef.current = setTimeout(() => {
      setIsOpen(false)
    }, 5000)
  }, [clearTimer])

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev
      if (next) {
        startTimer()
      } else {
        clearTimer()
      }
      return next
    })
  }, [startTimer, clearTimer])

  const handleSelect = useCallback(
    (id: string) => {
      onChange(id)
      // restart 5s auto-close countdown upon selection
      startTimer()
    },
    [onChange, startTimer],
  )

  const handleMouseEnter = useCallback(() => {
    clearTimer()
  }, [clearTimer])

  const handleMouseLeave = useCallback(() => {
    if (isOpen) {
      startTimer()
    }
  }, [isOpen, startTimer])

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        clearTimer()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      clearTimer()
    }
  }, [clearTimer])

  const navItems: NavItem[] = WORKSPACE_THEMES.map((t) => ({
    id: t.id,
    icon: THEME_META[t.id]?.icon ?? <Flower2 />,
    label: THEME_META[t.id]?.label ?? t.label,
    onClick: () => handleSelect(t.id),
  }))

  const activeIndex = Math.max(0, WORKSPACE_THEMES.findIndex((t) => t.id === activeId))

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Header theme button with animated arrow */}
      <button
        type="button"
        onClick={toggleOpen}
        className={`font-mono-display uppercase text-[11px] tracking-[0.18em] px-3 py-1.5 rounded-full transition-all duration-300 flex items-center gap-1.5 ${
          isOpen
            ? 'text-white bg-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]'
            : 'text-white/45 hover:text-white hover:bg-white/5'
        }`}
        style={isOpen ? { color: currentAccent } : {}}
      >
        <span>Theme</span>
        <ChevronDown
          size={13}
          className={`transition-transform duration-300 ${
            isOpen ? 'rotate-180 opacity-100' : 'rotate-0 opacity-40'
          }`}
          style={isOpen ? { color: currentAccent } : {}}
        />
      </button>

      {/* Dropdown horizontal LimelightNav floating below header */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="absolute top-full right-0 mt-3 z-50 whitespace-nowrap"
          >
            <LimelightNav
              items={navItems}
              defaultActiveIndex={activeIndex}
              key={activeId}
              accentColor={currentAccent}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default HeaderThemeSelector
