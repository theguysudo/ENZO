import { useRef, useState } from 'react'
import styled, { css, keyframes } from 'styled-components'
import type { HomepageTheme } from '../themes/homepage'

const THEME_META: Record<HomepageTheme, { bg: string; handle: string }> = {
  'nebula':            { bg: '#0a1428', handle: '#7dd3fc' },
  'anime-observatory': { bg: '#0a0a1a', handle: '#e8e8ff' },
  'anime-cottage':     { bg: '#2c3e50', handle: '#b0c4ce' },
  'anime-forest':      { bg: '#1a3a1a', handle: '#a5d6a7' },
  'anime-sky':         { bg: '#64b5f6', handle: '#fff9c4' },
  'anime-alien':             { bg: '#0a1420', handle: '#9be8c8' },
  'anime-rocket':            { bg: '#241527', handle: '#f5b98a' },
  'anime-space_probe':       { bg: '#0b1024', handle: '#9fc0f0' },
  'anime-coding_deck':       { bg: '#0f1424', handle: '#a8b4f0' },
  'anime-purple_flowers':    { bg: '#1d1424', handle: '#c79bff' },
}

const SLOT = 30
const H    = 28
const PAD  = 2

const rainDrop = keyframes`
  0%   { transform: translateY(0);    opacity: 0.8; }
  100% { transform: translateY(28px); opacity: 0;   }
`
const sway = keyframes`
  0%, 100% { transform: rotate(-3deg); }
  50%       { transform: rotate(3deg);  }
`
const drift = keyframes`
  0%, 100% { transform: translateX(0); }
  50%       { transform: translateX(4px); }
`
const comet = keyframes`
  0%   { transform: translateX(0)   translateY(0)   scaleX(1); opacity: 1; }
  100% { transform: translateX(30px) translateY(12px) scaleX(3); opacity: 0; }
`
const pinkPulse = keyframes`
  0%, 100% { box-shadow: 0 0 6px #f9c8e8, 0 0 12px #f472b6; }
  50%       { box-shadow: 0 0 10px #f9c8e8, 0 0 22px #f472b6, 0 0 32px #ec4899; }
`
const beacon = keyframes`
  0%   { transform: scale(0.3); opacity: 0.9; }
  70%  { transform: scale(1.6); opacity: 0;   }
  100% { transform: scale(1.6); opacity: 0;   }
`
const ufoHover = keyframes`
  0%, 100% { transform: translateY(0)   rotate(-6deg); }
  50%       { transform: translateY(-2px) rotate(6deg); }
`
const rocketFlame = keyframes`
  0%   { transform: scaleY(0.6); opacity: 0.5; }
  50%  { transform: scaleY(1.1); opacity: 0.95; }
  100% { transform: scaleY(0.6); opacity: 0.5; }
`
const satelliteBlink = keyframes`
  0%, 100% { opacity: 0.25; }
  50%       { opacity: 1;   }
`
const probeDrift = keyframes`
  0%, 100% { transform: translateX(0); }
  50%       { transform: translateX(3px); }
`
const cursorBlink = keyframes`
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
`
const dotSeg = keyframes`
  0%, 90%  { opacity: 1; }
  91%, 100% { opacity: 0.25; }
`
const petalPulse = keyframes`
  0%, 100% { transform: scale(1); opacity: 0.9; }
  50%       { transform: scale(1.25); opacity: 0.5; }
`

export interface ThemeSelectorThemeMeta {
  id: string
  label: string
  /** Track background colour for this theme. */
  bg?: string
  /** Handle (knob) colour for this theme. */
  handle?: string
}

const DEFAULT_TRACK_BG = '#0d0d2b'
const DEFAULT_HANDLE = '#c8d6f0'

export function ThemeSelector({
  themes,
  activeThemeId,
  onChange,
  order,
}: {
  themes: ThemeSelectorThemeMeta[]
  activeThemeId: string
  onChange: (id: string) => void
  /** Optional explicit slot order. Defaults to the given `themes` order. */
  order?: string[]
}) {
  const ids = order ?? themes.map(t => t.id)
  const ordered  = ids.filter(id => themes.some(t => t.id === id))
  // Fall back to the full list if the resolved order is empty (never crash).
  const slots    = ordered.length ? ordered : themes.map(t => t.id)
  // Live slot index: the dragged slot while dragging, else the active theme.
  // All rail visuals (handle position, track colour, decorations) follow it,
  // so the drag previews the theme without ever committing it mid-drag.
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const idx      = dragIdx ?? Math.max(0, slots.indexOf(activeThemeId))
  const resolved = slots[idx] ?? slots[0]
  // Per-theme meta from the caller wins; homepage THEME_META is the fallback;
  // a neutral default guarantees render even for unknown ids.
  const provided = themes.find(t => t.id === resolved)
  const m        = {
    bg:     provided?.bg     ?? THEME_META[resolved as HomepageTheme]?.bg     ?? DEFAULT_TRACK_BG,
    handle: provided?.handle ?? THEME_META[resolved as HomepageTheme]?.handle ?? DEFAULT_HANDLE,
  }
  const trackW   = PAD * 2 + slots.length * SLOT
  const handleL  = PAD + idx * SLOT
  const decId    = resolved

  // Drag state. The hovered slot is kept LOCAL on purpose: committing it via
  // onChange would flip the whole homepage background — unmounting one WebGL/
  // video pipeline, cold-loading the next theme's multi-MB mp4 — for every
  // slot the pointer crosses. That was the theme-switch lag. The theme is
  // committed exactly once, on release, for the slot the handle ends on.
  const dragStart = useRef<{ x: number; idx: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    // Anchor the drag at the theme's slot, not wherever the grab landed, so
    // a grab on the handle's edge doesn't jump the preview.
    dragStart.current = { x: e.clientX, idx: Math.max(0, slots.indexOf(activeThemeId)) }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return
    const delta    = e.clientX - dragStart.current.x
    const newIdx   = Math.max(0, Math.min(slots.length - 1,
      dragStart.current.idx + Math.round(delta / SLOT)
    ))
    setDragIdx(newIdx)
  }
  const onPointerUp = () => {
    if (dragStart.current && dragIdx !== null && slots[dragIdx] !== activeThemeId) {
      onChange(slots[dragIdx])
    }
    dragStart.current = null
    setDragIdx(null)
  }

  return (
    <Track $bg={m.bg} $w={trackW} $h={H}>
      {/* decorations */}
      {(decId === 'nebula' || decId === 'anime-observatory') && (
        <>
          <Dot style={{ top: 5,  left: 52, width: 2, height: 2, background: '#fff', opacity: 0.8 }} />
          <Dot style={{ top: 14, left: 70, width: 3, height: 3, background: '#fff', opacity: 0.5 }} />
          <Dot style={{ top: 8,  left: 82, width: 2, height: 2, background: '#fff', opacity: 0.6 }} />
          <Dot style={{ top: 18, left: 60, width: 2, height: 2, background: '#aac', opacity: 0.4 }} />
        </>
      )}
      {decId === 'anime-observatory' && (
        <>
          <Comet style={{ top: 6,  left: 50, animationDelay: '0s',    animationDuration: '2.2s' }} />
          <Comet style={{ top: 14, left: 62, animationDelay: '1.1s',  animationDuration: '2.8s' }} />
        </>
      )}
      {decId === 'anime-cottage' && (
        <>
          <Rain style={{ left: 52, animationDelay: '0s'    }} />
          <Rain style={{ left: 62, animationDelay: '0.25s' }} />
          <Rain style={{ left: 72, animationDelay: '0.5s'  }} />
          <Rain style={{ left: 82, animationDelay: '0.15s' }} />
        </>
      )}
      {decId === 'anime-forest' && (
        <>
          <Tree style={{ left: 52, animationDelay: '0s'   }} />
          <Tree style={{ left: 64, animationDelay: '0.4s', borderBottomWidth: 12 }} />
          <Tree style={{ left: 76, animationDelay: '0.2s' }} />
        </>
      )}
      {decId === 'anime-sky' && (
        <>
          <Cloud $width={20} $top={6}  style={{ left: 50 }} />
          <Cloud $width={14} $top={14} style={{ left: 68 }} />
        </>
      )}
      {decId === 'anime-alien' && (
        <>
          <Dot style={{ top: 4,  left: 52, width: 2, height: 2, background: '#9be8c8', opacity: 0.7 }} />
          <Dot style={{ top: 15, left: 60, width: 2, height: 2, background: '#34d399', opacity: 0.5 }} />
          <Ufo style={{ top: 11, left: 66 }} />
          <UfoBeam style={{ top: 8 }} />
          <Dot style={{ top: 5,  left: 78, width: 2, height: 2, background: '#9be8c8', opacity: 0.5 }} />
        </>
      )}
      {decId === 'anime-rocket' && (
        <>
          <Dot style={{ top: 4,  left: 54, width: 2, height: 2, background: '#fde047', opacity: 0.6 }} />
          <RocketBody style={{ top: 6, left: 62 }} />
          <RocketFlame style={{ top: 17 }} />
          <Dot style={{ top: 14, left: 78, width: 2, height: 2, background: '#fb923c', opacity: 0.6 }} />
        </>
      )}
      {decId === 'anime-space_probe' && (
        <>
          <SatPanel style={{ top: 9, left: 48, transform: 'rotate(30deg)' }} />
          <SatAntenna style={{ top: 12, left: 53, transform: 'rotate(30deg)' }} />
          <SatelliteBody style={{ top: 10, left: 58 }} />
          <SatPanel style={{ top: 9,  left: 66, transform: 'rotate(150deg)' }} />
          <SatBlink style={{ top: 13, left: 61 }} />
          <Probe style={{ top: 6, left: 74 }} />
          <ProbeArms style={{ top: 1, left: 81 }} />
          <ProbeCore style={{ top: 9, left: 77 }} />
        </>
      )}
      {decId === 'anime-coding_deck' && (
        <>
          <CodeSeg style={{ top: 6,  left: 50, width: 8, height: 2, background: '#a8b4f0', animationDelay: '0s' }} />
          <CodeSeg style={{ top: 10, left: 54, width: 10, height: 2, background: '#8f9cf0', animationDelay: '0.5s' }} />
          <CodeSeg style={{ top: 14, left: 52, width: 6, height: 2, background: '#c0c8f8', animationDelay: '1s' }} />
          <TerminalPrompt style={{ top: 8, left: 72 }}>&gt;_</TerminalPrompt>
          <TerminalCursor style={{ top: 8, left: 78, position: 'absolute' }} />
          <Dot style={{ top: 3,  left: 62, width: 2, height: 2, background: '#a8b4f0', opacity: 0.5 }} />
        </>
      )}
      {decId === 'anime-purple_flowers' && (
        <>
          <FlowerBloom style={{ top: 12, left: 52 }} />
          <FlowerPetal $rot={0}   style={{ top: 5,  left: 52 }} />
          <FlowerPetal $rot={72}  style={{ top: 5,  left: 54 }} />
          <FlowerPetal $rot={144} style={{ top: 6,  left: 56 }} />
          <FlowerPetal $rot={216} style={{ top: 7,  left: 52 }} />
          <FlowerPetal $rot={288} style={{ top: 6,  left: 52 }} />
          <Dot style={{ top: 14, left: 70, width: 2, height: 2, background: '#d8b4fe', opacity: 0.6 }} />
          <Dot style={{ top: 5,  left: 74, width: 2, height: 2, background: '#c084fc', opacity: 0.5 }} />
          <Dot style={{ top: 11, left: 80, width: 2, height: 2, background: '#e9d5ff', opacity: 0.5 }} />
        </>
      )}

      {/* draggable handle */}
      <Handle
        $bg={m.handle}
        $left={handleL}
        $h={H}
        $dark={decId !== 'anime-sky'}
        $pink={false}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />

      {/* click zones */}
      {slots.map((id, i) => (
        <Zone
          key={id}
          style={{ left: PAD + i * SLOT }}
          $w={SLOT}
          $h={H - PAD * 2}
          $active={activeThemeId === id}
          onClick={() => onChange(id)}
          title={themes.find(t => t.id === id)?.label}
          aria-label={themes.find(t => t.id === id)?.label}
        />
      ))}
    </Track>
  )
}

const Dot = styled.span`
  position: absolute; border-radius: 50%; pointer-events: none;
`
const Comet = styled.span`
  position: absolute;
  width: 6px; height: 1px;
  background: linear-gradient(90deg, #fff, transparent);
  border-radius: 1px;
  pointer-events: none;
  animation: ${comet} 2.2s ease-in infinite;
`
const Rain = styled.span`
  position: absolute; top: 3px;
  width: 1px; height: 7px;
  background: rgba(180,210,240,0.75);
  border-radius: 1px; pointer-events: none;
  animation: ${rainDrop} 0.7s linear infinite;
`
const Tree = styled.span<{ borderBottomWidth?: number }>`
  position: absolute; bottom: 3px;
  width: 0; height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-bottom: ${p => p.borderBottomWidth ?? 10}px solid rgba(100,180,100,0.65);
  pointer-events: none;
  transform-origin: bottom center;
  animation: ${sway} 2s ease-in-out infinite;
`
const Cloud = styled.span<{ $width: number; $top: number }>`
  position: absolute;
  top: ${p => p.$top}px; width: ${p => p.$width}px;
  height: 7px; background: rgba(255,255,255,0.8);
  border-radius: 8px; pointer-events: none;
  animation: ${drift} 3s ease-in-out infinite;
`
const Ufo = styled.span`
  position: absolute; pointer-events: none;
  width: 14px; height: 5px;
  border-radius: 50%;
  background: linear-gradient(180deg, #9be8c8, #34d399);
  box-shadow: 0 0 6px rgba(52,211,153,0.8);
  animation: ${ufoHover} 2.4s ease-in-out infinite;
`
const UfoBeam = styled.span`
  position: absolute; left: 6px; top: 4px;
  width: 2px; height: 2px; border-radius: 50%;
  background: #9be8c8;
  animation: ${beacon} 1.8s ease-out infinite;
`
const RocketBody = styled.span`
  position: absolute; pointer-events: none;
  width: 8px; height: 10px;
  background: linear-gradient(180deg, #fef3c7, #fb923c);
  clip-path: polygon(15% 0, 85% 0, 100% 55%, 55% 100%, 45% 100%, 0 55%);
  filter: drop-shadow(0 0 3px rgba(251,146,60,0.7));
`
const RocketFlame = styled.span`
  position: absolute; left: 2.5px; bottom: -5px; pointer-events: none;
  width: 3px; height: 5px;
  background: linear-gradient(180deg, #fde047, #f97316);
  border-radius: 0 0 3px 3px;
  transform-origin: top center;
  animation: ${rocketFlame} 0.5s ease-in infinite;
`
const SatelliteBody = styled.span`
  position: absolute; left: 6px; top: 9px; transform: rotate(30deg); pointer-events: none;
  width: 6px; height: 8px;
  background: linear-gradient(180deg, #7dd3fc, #38bdf8);
  border-radius: 2px;
  box-shadow: inset 0 0 2px rgba(15,23,42,0.6);
`
const SatPanel = styled.span`
  position: absolute; pointer-events: none;
  width: 5px; height: 10px;
  background: linear-gradient(180deg, rgba(125,211,252,0.9), rgba(56,189,248,0.35));
  transform: rotate(30deg);
`
const SatAntenna = styled.span`
  position: absolute; pointer-events: none;
  width: 1px; height: 6px; background: #bae6fd;
`
const SatBlink = styled.span`
  position: absolute; pointer-events: none;
  width: 2px; height: 2px; border-radius: 50%;
  background: #7dd3fc;
  box-shadow: 0 0 4px #38bdf8;
  animation: ${satelliteBlink} 0.9s ease-in-out infinite;
`
const Probe = styled.span`
  position: absolute; pointer-events: none;
  width: 10px; height: 10px;
  border: 2px solid #93c5fd;
  border-radius: 50%;
  box-shadow: inset 0 0 3px rgba(59,130,246,0.6), 0 0 4px rgba(59,130,246,0.5);
  animation: ${probeDrift} 3s ease-in-out infinite;
`
const ProbeCore = styled.span`
  position: absolute; pointer-events: none;
  width: 3px; height: 3px; border-radius: 50%;
  background: #93c5fd;
  box-shadow: 0 0 5px #60a5fa;
`
const ProbeArms = styled.span`
  position: absolute; left: 1px; top: 3px; pointer-events: none;
  width: 1px; height: 12px; background: #a5c6fa;
  transform: rotate(45deg);
`
const TerminalPrompt = styled.span`
  position: absolute; pointer-events: none;
  color: #a8b4f0;
  font-family: inherit;
  font-size: 9px;
  line-height: 1;
  text-shadow: 0 0 4px rgba(168,180,240,0.7);
`
const TerminalCursor = styled.span`
  display: inline-block;
  width: 3px; height: 7px;
  background: #a8b4f0;
  animation: ${cursorBlink} 1s steps(1) infinite;
`
const CodeSeg = styled.span`
  display: inline-block;
  pointer-events: none;
  animation: ${dotSeg} 2.4s steps(1) infinite;
`
const FlowerBloom = styled.span`
  position: absolute; pointer-events: none;
  width: 4px; height: 4px; border-radius: 50%;
  background: #d8b4fe;
  box-shadow: 0 0 5px rgba(192,132,252,0.8);
  animation: ${petalPulse} 2s ease-in-out infinite;
`
const FlowerPetal = styled.span<{ $rot: number }>`
  position: absolute; left: 7px; top: 3px; pointer-events: none;
  width: 3px; height: 5px;
  background: linear-gradient(180deg, #e9d5ff, #c084fc);
  border-radius: 3px 3px 1px 1px;
  transform: rotate(${p => p.$rot}deg);
  transform-origin: 50% 100%;
  animation: ${petalPulse} 2.2s ease-in-out infinite;
  animation-delay: ${p => p.$rot * 0.02}s;
`
const Handle = styled.span<{ $bg: string; $left: number; $h: number; $dark: boolean; $pink: boolean }>`
  position: absolute;
  z-index: 2;
  top: ${PAD}px;
  left: ${p => p.$left}px;
  width: ${p => p.$h - PAD * 2}px;
  height: ${p => p.$h - PAD * 2}px;
  background: ${p => p.$bg};
  border-radius: 50%;
  cursor: grab;
  &:active { cursor: grabbing; }
  box-shadow: 0 2px 5px rgba(0,0,0,0.3),
    ${p => p.$dark
      ? 'inset 3px -3px 3px rgba(53,53,53,0.25)'
      : 'inset -3px -3px 3px rgba(53,53,53,0.2)'};
  ${p => p.$pink && css`animation: ${pinkPulse} 2s ease-in-out infinite;`}
  transition: left 400ms cubic-bezier(0.68,-0.55,0.265,1.55), background 400ms ease;
  touch-action: none;
`
const Zone = styled.button<{ $w: number; $h: number; $active: boolean }>`
  position: absolute; z-index: 3;
  top: ${PAD}px;
  width: ${p => p.$w}px; height: ${p => p.$h}px;
  background: transparent; border: none; padding: 0;
  cursor: ${p => p.$active ? 'default' : 'pointer'};
  pointer-events: ${p => p.$active ? 'none' : 'auto'};
  border-radius: 50%;
  &:hover { background: rgba(255,255,255,0.08); }
`
const Track = styled.div<{ $bg: string; $w: number; $h: number }>`
  position: relative;
  display: inline-flex; align-items: center;
  width: ${p => p.$w}px; height: ${p => p.$h}px;
  background: ${p => p.$bg};
  border-radius: ${p => p.$h}px;
  box-shadow: inset 0 2px 5px rgba(0,0,0,0.35);
  transition: background 500ms cubic-bezier(0.445,0.05,0.55,0.95);
  overflow: hidden;
`
