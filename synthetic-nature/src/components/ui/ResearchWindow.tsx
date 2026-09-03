import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Minus, Square, Copy, X, Check, Download, TerminalSquare, Search } from 'lucide-react'

interface ResearchWindowProps {
  title?: string
  children: React.ReactNode
  steps?: string[]
  onDownload?: () => void
  downloading?: boolean
  onCopy?: () => void
  onClose?: () => void
  headerRight?: React.ReactNode
}

// Classic Windows 95-style bevel shadows.
const RAISED_THIN =
  'shadow-[inset_-1px_-1px_0_#000,inset_1px_1px_0_#fff,inset_-2px_-2px_0_#a0a0a0,inset_2px_2px_0_#e8e8e8]'
const SUNKEN =
  'shadow-[inset_1px_1px_0_#808080,inset_-1px_-1px_0_#fff,inset_2px_2px_0_#000,inset_-2px_-2px_0_#dfdfdf]'

const RESIZE_MIN_W = 340
const RESIZE_MIN_H = 240

/**
 * Windows exe-style popup window for research output. Chrome is authentic
 * Win95: raised gray bevel frame, blue gradient title bar, pixel window
 * controls, menu bar, status bar, and action buttons.
 *
 * Windows behavior:
 *  - Minimize  → collapses to the title bar (restore via the "_" control).
 *  - Maximize  → expands to a near-fullscreen overlay with a single body
 *                scroll (the whole research context is readable without
 *                fighting the outer chat scroll). Esc or backdrop click exits.
 *  - Resize    → drag the bottom-right grip on the status bar for precise
 *                width/height tuning while docked in the chat flow.
 *  - Scroll    → exactly ONE scroll region (the body). All chrome stays fixed.
 */
export const ResearchWindow: React.FC<ResearchWindowProps> = ({
  title = 'research.exe',
  children,
  steps = [],
  onDownload,
  downloading,
  onCopy,
  onClose,
  headerRight,
}) => {
  const [minimized, setMinimized] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showSources, setShowSources] = useState(steps.length > 0)
  // User-resized dimensions while docked in the chat flow (undefined = default).
  const [size, setSize] = useState<{ w?: number; h?: number }>({})

  const frameRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  // Escape closes maximized mode.
  useEffect(() => {
    if (!maximized) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized])

  // Always detach resize listeners if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onResizeMove)
      window.removeEventListener('pointerup', onResizeEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onResizeMove = (e: PointerEvent) => {
    const s = dragStart.current
    if (!s) return
    const w = Math.max(RESIZE_MIN_W, s.w + (e.clientX - s.x))
    const h = Math.min(
      window.innerHeight - 140,
      Math.max(RESIZE_MIN_H, s.h + (e.clientY - s.y)),
    )
    setSize({ w, h })
  }

  const onResizeEnd = () => {
    dragStart.current = null
    window.removeEventListener('pointermove', onResizeMove)
    window.removeEventListener('pointerup', onResizeEnd)
  }

  const onResizePointerDown = (e: React.PointerEvent) => {
    if (maximized) return
    e.preventDefault()
    e.stopPropagation()
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect) return
    dragStart.current = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height }
    window.addEventListener('pointermove', onResizeMove)
    window.addEventListener('pointerup', onResizeEnd)
  }

  const handleCopy = () => {
    if (onCopy) onCopy()
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const charCount = React.Children.toArray(children)
    .filter((c): c is React.ReactElement => React.isValidElement(c))
    .reduce((acc, c) => acc + String(c.props?.children ?? '').length, 0)

  const wrapperStyle = maximized ? undefined : size.w ? { width: size.w } : undefined

  const windowChrome = (
    <div
      className={
        maximized
          ? 'fixed inset-0 z-[500] select-none flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-md'
          : `relative w-full select-none ${size.w ? '' : 'max-w-2xl'}`
      }
      style={wrapperStyle}
      onClick={maximized ? (e) => { if (e.target === e.currentTarget) setMaximized(false) } : undefined}
    >
      {/* Outer frame — liquid glass; chrome (title bar, menus, status, buttons) stays Win95 */}
      <div
        ref={frameRef}
        className={`rounded-[10px] border border-white/[0.09] bg-white/[0.05] backdrop-blur-xl p-[3px] shadow-[0_24px_60px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.12)] ${
          maximized
            ? 'relative flex flex-col w-full max-w-4xl h-[min(78vh,720px)] max-h-[94vh]'
            : ''
        }`}
      >
        {/* ── Title Bar — blue gradient like Win95 active window ─────────── */}
        <div
          onDoubleClick={() => setMaximized((v) => !v)}
          className="flex items-center gap-1.5 px-[3px] py-[2px] bg-gradient-to-r from-[#000080] via-[#0a0a8a] to-[#1084d0] border-b-2 border-[#0a0a7a] select-none"
        >
          <div className="flex items-center gap-1.5 shrink-0 min-w-0">
            <div className="w-[15px] h-[15px] rounded-[2px] bg-gradient-to-br from-emerald-400 to-emerald-700 flex items-center justify-center shadow-[0_1px_3px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.4)]">
              <TerminalSquare size={9} className="text-black" strokeWidth={3} />
            </div>
            <span className="text-[11px] font-bold tracking-wide text-white drop-shadow-[0_1px_0_rgba(0,0,0,0.6)] font-mono leading-none truncate">
              {title}
            </span>
          </div>
          {headerRight && <div className="ml-auto flex items-center gap-1 shrink-0">{headerRight}</div>}

          {/* Window controls — pixel squares with bevels */}
          <div className="flex items-center gap-[2px] ml-auto shrink-0">
            <button
              onClick={() => setMinimized((v) => !v)}
              title={minimized ? 'Restore' : 'Minimize'}
              className={`w-[16px] h-[15px] flex items-center justify-center bg-[#c0c0c0] ${RAISED_THIN} hover:bg-[#d8d8d8] cursor-pointer active:shadow-[inset_1px_1px_0_#808080,inset_-1px_-1px_0_#fff]`}
            >
              <Minus size={8} className="text-black" strokeWidth={3} />
            </button>
            <button
              onClick={() => setMaximized((v) => !v)}
              title={maximized ? 'Restore' : 'Maximize'}
              className={`w-[16px] h-[15px] flex items-center justify-center bg-[#c0c0c0] ${RAISED_THIN} hover:bg-[#d8d8d8] cursor-pointer active:shadow-[inset_1px_1px_0_#808080,inset_-1px_-1px_0_#fff]`}
            >
              {maximized ? (
                <Copy size={7} className="text-black" strokeWidth={3} />
              ) : (
                <Square size={7} className="text-black" strokeWidth={3} />
              )}
            </button>
            <button
              onClick={onClose}
              title="Close"
              className={`w-[16px] h-[15px] flex items-center justify-center bg-[#c0c0c0] ${RAISED_THIN} hover:bg-[#e0c0c0] cursor-pointer active:shadow-[inset_1px_1px_0_#808080,inset_-1px_-1px_0_#fff]`}
            >
              <X size={8} className="text-black" strokeWidth={3} />
            </button>
          </div>
        </div>

        {/* ── Menu Bar — silver, with File Edit View Help ─────────────────── */}
        <div className="flex items-center gap-3 px-1.5 py-[3px] border-b border-black/20 bg-[#c0c0c0]">
          {['File', 'Edit', 'View', 'Help'].map((menu) => (
            <span
              key={menu}
              className="text-[11px] text-black/90 px-1 py-[1px] rounded-[2px] hover:bg-[#000080] hover:text-white cursor-default font-mono"
            >
              {menu}
            </span>
          ))}
          {steps.length > 0 && (
            <span
              onClick={() => setShowSources((v) => !v)}
              className="ml-auto flex items-center gap-1 text-[11px] text-black/80 hover:bg-[#000080] hover:text-white px-1 py-[1px] rounded-[2px] cursor-pointer font-mono"
            >
              <Search size={9} />
              Sources {showSources ? '▲' : '▼'}
            </span>
          )}
        </div>

        {/* ── Body — the SINGLE scroll region; chrome stays fixed ───────── */}
        {!minimized && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className={`relative bg-[#080b10] ${maximized ? 'flex-1 min-h-0 flex flex-col' : ''}`}
          >
            {/* CRT scanline overlay */}
            <div className="pointer-events-none absolute inset-0 z-[1] opacity-[0.06] bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(0,255,0,0.8)_2px,rgba(0,255,0,0.8)_3px)]" />

            <div
              className={`relative z-[2] px-4 py-3 overflow-y-auto scrollbar-thin ${
                maximized ? 'flex-1 min-h-0' : 'max-h-[65vh] min-h-[140px]'
              }`}
              style={!maximized && size.h ? { height: size.h } : undefined}
            >
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-emerald-500/15">
                <span className="text-[9px] font-bold tracking-[0.25em] text-emerald-400/80 uppercase font-mono">
                  Research Output
                </span>
              </div>

              <div className="text-white/80">{children}</div>

              {/* Research sources / process ledger */}
              {steps.length > 0 && showSources && (
                <div className="mt-4 border border-emerald-500/20 rounded-lg bg-emerald-500/[0.04]">
                  <div className="px-3 py-1.5 border-b border-emerald-500/20 text-[9px] font-bold tracking-[0.2em] text-emerald-400/70 uppercase">
                    Sources & Process ({steps.length})
                  </div>
                  <div className="p-3 space-y-1.5">
                    {steps.map((step, idx) => {
                      const isSource = step.startsWith('🔍') && step.includes('\n')
                      const [headLine, urlLine] = isSource ? step.split('\n', 2) : [step, '']
                      return (
                        <div key={idx} className="text-[10.5px] font-mono break-all whitespace-pre-wrap text-emerald-200/40 leading-relaxed">
                          <span className="mr-2 text-emerald-400/60">✓</span>
                          {headLine}
                          {isSource && urlLine && (
                            <div className="ml-5 text-[9.5px] text-emerald-300/30 truncate">{urlLine}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {minimized && (
          <div className="flex items-center gap-2 px-3 py-2 bg-[#c0c0c0] text-[11px] font-mono text-black/70">
            <TerminalSquare size={12} className="text-[#000080]" />
            {title} — minimized. Click <span className="underline">_</span> to restore.
          </div>
        )}

        {/* ── Status Bar — silver with sunken field + resize grip ───────── */}
        <div className="flex items-center gap-2 px-1.5 py-[3px] border-t border-black/20 bg-[#c0c0c0]">
          <span className={`flex items-center gap-1.5 text-[10px] font-mono text-black/80 px-1.5 py-[1px] ${SUNKEN}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            READY
          </span>
          <span className={`text-[10px] font-mono text-black/80 px-1.5 py-[1px] ${SUNKEN}`}>
            {steps.length > 0 ? `${steps.length} sources` : 'no external sources'}
          </span>
          <span className={`ml-auto text-[10px] font-mono text-black/80 px-1.5 py-[1px] ${SUNKEN}`}>
            {charCount > 0 ? `${charCount.toLocaleString()} chars` : '\u00A0'}
          </span>
          {!maximized && (
            <span
              onPointerDown={onResizePointerDown}
              title="Resize window"
              className={`w-3.5 h-3 cursor-nwse-resize ${SUNKEN} touch-none`}
              style={{
                backgroundImage:
                  'repeating-linear-gradient(45deg, #808080 0 1px, #fff 1px 2px)',
              }}
            />
          )}
        </div>

        {/* ── Action Buttons — Win95 raised gray ────────────────────────── */}
        <div className="flex items-center gap-2 px-1.5 py-[5px] bg-[#c0c0c0]">
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1.5 px-2.5 py-[3px] bg-[#c0c0c0] text-[11px] font-mono text-black ${RAISED_THIN} hover:bg-[#d8d8d8] active:shadow-[inset_1px_1px_0_#808080,inset_-1px_-1px_0_#fff] cursor-pointer`}
          >
            {copied ? <Check size={10} className="text-[#006600]" /> : <Copy size={10} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {onDownload && (
            <button
              onClick={onDownload}
              disabled={downloading}
              className={`flex items-center gap-1.5 px-2.5 py-[3px] bg-[#c0c0c0] text-[11px] font-mono text-black ${RAISED_THIN} hover:bg-[#d8d8d8] active:shadow-[inset_1px_1px_0_#808080,inset_-1px_-1px_0_#fff] disabled:opacity-60 cursor-pointer`}
            >
              <Download size={10} />
              {downloading ? 'Generating…' : 'Download PDF'}
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className={`ml-auto flex items-center gap-1.5 px-4 py-[3px] bg-[#c0c0c0] text-[11px] font-mono text-black ${RAISED_THIN} hover:bg-[#d8d8d8] active:shadow-[inset_1px_1px_0_#808080,inset_-1px_-1px_0_#fff] cursor-pointer`}
            >
              OK
            </button>
          )}
        </div>
      </div>

      {/* Drop shadow under the whole window */}
      {!maximized && (
        <div className="pointer-events-none absolute inset-0 rounded-[3px] shadow-[0_20px_50px_rgba(0,0,0,0.6)]" />
      )}
    </div>
  )

  // Maximized mode escapes the chat's scroll/transform containers via a portal
  // so it truly covers the viewport; docked mode renders in the message flow.
  return maximized ? createPortal(windowChrome, document.body) : windowChrome
}
