/**
 * NeuralMapGraphCanvas.tsx — the reagraph (WebGL/three.js) knowledge-graph
 * renderer for the Neural Map.
 *
 * Why reagraph (his pick): real physics-based fluid motion (d3-force + spring
 * animation), draggable nodes, camera pan/zoom, centrality-based node sizing,
 * and hover/selection highlighting that dims the rest of the graph.
 *
 * Node visuals (his "make it look like Google Stitch, add icons"): every node
 * is a type-colored sphere (8 hues from neuralTypeVisuals.ts, coral for
 * rejected) with a DOM icon legend under the canvas and colored type badges
 * in the inspector — one visual language across the 3D graph, the low-power
 * SVG fallback and the panels. On-node icon sprites are NOT used: reagraph's
 * sprite path never renders on fiber 8.13.5 + three 0.161 (in-browser bisect
 * proved it); retry if the stack ever moves to React 19 + fiber 9.
 *
 * Offline rule: troika resolves label fonts from a CDN by default, so the
 * label font is shipped locally (public/fonts/space-grotesk-500.ttf — the
 * app's own display font) and passed via labelFontUrl. Badge sprites are
 * inline SVG data-URIs — zero network.
 *
 * ROTATION: reagraph's camera has no auto-rotate switch — in `orbit` mode its
 * render loop adds 20°/second to the camera azimuth forever, so the graph
 * spins and never holds still. The fix is the camera MODE: `orbit` spins,
 * `rotate` does not. So the canvas starts in `orbit` (the slow drift reads as
 * alive) and switches to `rotate` the moment the user touches the graph —
 * click, drag or wheel — after which dragging still rotates the camera by
 * hand. A "resume spin" control puts the drift back.
 *
 * ZOOM: reagraph's built-in zoomIn/zoomOut halves the camera's zoom factor
 * (a jump, not a move). For a 3D graph, dollying the camera toward the target
 * reads as walking closer, so the controls dolly with an animated transition
 * and the fit/center actions use reagraph's own fitNodesInView/centerGraph.
 *
 * Theme: ENZO mono canvas (near-black), type-colored nodes, coral only for
 * rejected/disputed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GraphCanvas, darkTheme, type GraphCanvasRef, type Theme } from 'reagraph'
import { ZoomIn, ZoomOut, Maximize2, Crosshair, RotateCw } from 'lucide-react'
import { nodeTypeColor, REJECTED_COLOR } from './neuralTypeVisuals'

export const NEURAL_LABEL_FONT_URL = '/fonts/space-grotesk-500.ttf'

export interface MapGraphNode {
  id: string
  label: string
  /** Node type — picks the badge color + glyph. */
  type?: string
  /** Rejected/disputed overrides the type color with coral. */
  rejected?: boolean
  fill?: string
  /** Passthrough fields for the low-power SVG fallback renderer. */
  kind?: string
  summary?: string
  aliases?: string[]
  evidenceIds?: string[]
}

export interface MapGraphEdge {
  id: string
  source: string
  target: string
  label?: string
  fill?: string
}

const enzoTheme: Theme = {
  ...darkTheme,
  canvas: {
    background: '#0a0a0b',
    fog: '#0a0a0b',
  },
  node: {
    ...darkTheme.node,
    fill: 'rgba(255,255,255,0.14)',
    activeFill: 'rgba(255,255,255,0.7)',
    opacity: 0.92,
    selectedOpacity: 1,
    inactiveOpacity: 0.3,
    label: {
      color: 'rgba(255,255,255,0.82)',
      activeColor: '#ffffff',
      stroke: '#0a0a0b',
    },
    subLabel: {
      color: 'rgba(255,255,255,0.4)',
      activeColor: 'rgba(255,255,255,0.6)',
      stroke: '#0a0a0b',
    },
  },
  ring: {
    fill: 'rgba(255,255,255,0.45)',
    activeFill: 'rgba(255,255,255,0.95)',
  },
  edge: {
    ...darkTheme.edge,
    fill: 'rgba(255,255,255,0.16)',
    activeFill: 'rgba(255,255,255,0.55)',
    opacity: 0.85,
    selectedOpacity: 1,
    inactiveOpacity: 0.12,
    label: {
      color: 'rgba(255,255,255,0.45)',
      activeColor: 'rgba(255,255,255,0.8)',
      stroke: '#0a0a0b',
    },
  },
  arrow: {
    fill: 'rgba(255,255,255,0.25)',
    activeFill: 'rgba(255,255,255,0.6)',
  },
  lasso: darkTheme.lasso,
}

export default function NeuralMapGraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
  onActivate,
  layout,
}: {
  nodes: MapGraphNode[]
  edges: MapGraphEdge[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Fired on a clean node click (the investigation opens the explainer). */
  onActivate?: (id: string) => void
  layout: '2d' | '3d'
}) {
  // Camera: forceatlas2 positions are valid synchronously, so one fit at
  // 400ms frames the real layout (earlier fit failures were the broken d3
  // force layout, not the fit itself).
  const graphRef = useRef<GraphCanvasRef | null>(null)
  const [spinning, setSpinning] = useState(true)
  const stopSpin = useCallback(() => setSpinning((s) => (s ? false : s)), [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { graphRef.current?.fitNodesInView?.() } catch { /* best-effort */ }
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [nodes, layout])

  // Type-colored spheres. NOTE: reagraph's node.icon sprite path is broken on
  // this stack (fiber 8.13.5 + three 0.161 — sprites mount but never render,
  // verified by in-browser bisect), so the Stitch look comes from per-type
  // sphere colors + the DOM icon legend/inspector instead of on-node sprites.
  const graphNodes = useMemo(() => nodes.map((n) => ({
    id: n.id,
    label: n.label,
    fill: nodeTypeColor(n.type ?? n.kind ?? 'concept', n.rejected ?? n.fill?.startsWith('#f0968a')),
  })), [nodes])

  const graphEdges = useMemo(() => edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    ...(e.label ? { label: e.label } : {}),
    ...(e.fill ? { fill: e.fill } : {}),
  })), [edges])

  /** Dolly toward/away from the target with an animated transition. */
  const dolly = useCallback((factor: number) => {
    const controls = graphRef.current?.getControls?.()
    if (!controls) return
    const distance = controls.distance || 1
    const next = factor < 1
      ? Math.max(controls.minDistance ?? 100, distance * factor)
      : Math.min(controls.maxDistance ?? 50000, distance * factor)
    try { void controls.dollyTo(next, true) } catch { /* best-effort */ }
  }, [])

  const fit = useCallback(() => {
    try { graphRef.current?.fitNodesInView?.() } catch { /* best-effort */ }
  }, [])

  const centerSelected = useCallback(() => {
    if (!selectedId) { fit(); return }
    try { graphRef.current?.centerGraph?.([selectedId]) } catch { /* best-effort */ }
  }, [fit, selectedId])

  const controlBtn =
    'inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/12 bg-black/60 text-white/70 transition-colors hover:border-white/30 hover:text-white disabled:opacity-30 disabled:hover:border-white/12'

  return (
    <div className="relative h-[540px] overflow-hidden rounded-xl border border-white/10 bg-[#0a0a0b]">
      {/* Stitch-style ambience: two soft color washes behind the canvas */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(520px 300px at 18% 12%, rgba(124,92,255,0.10), transparent 70%),' +
            'radial-gradient(560px 320px at 84% 88%, rgba(34,211,238,0.07), transparent 70%)',
        }}
      />
      <div
        className="relative h-full"
        onPointerDown={stopSpin}
        onWheel={stopSpin}
      >
        <GraphCanvas
          ref={graphRef}
          theme={enzoTheme}
          nodes={graphNodes}
          edges={graphEdges}
          layoutType={layout === '3d' ? 'forceDirected3d' : 'forceDirected2d'}
          cameraMode={layout === '3d' ? (spinning ? 'orbit' : 'rotate') : 'pan'}
          animated
          draggable
          selections={selectedId ? [selectedId] : []}
          onNodeClick={(node) => {
            if (!node?.id) return
            stopSpin()
            onSelect(node.id)
            onActivate?.(node.id)
          }}
          onCanvasClick={() => onSelect(null)}
          labelType="auto"
          sizingType="centrality"
          defaultNodeSize={7}
          labelFontUrl={NEURAL_LABEL_FONT_URL}
          glOptions={{ antialias: true, alpha: false, powerPreference: 'low-power' }}
        />
      </div>

      {/* ── view controls ── */}
      <div className="absolute right-3 top-3 flex flex-col gap-1.5">
        <button type="button" className={controlBtn} onClick={() => dolly(0.68)} title="Zoom in" aria-label="Zoom in">
          <ZoomIn size={13} />
        </button>
        <button type="button" className={controlBtn} onClick={() => dolly(1.45)} title="Zoom out" aria-label="Zoom out">
          <ZoomOut size={13} />
        </button>
        <button type="button" className={controlBtn} onClick={fit} title="Fit the whole graph" aria-label="Fit graph">
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          className={controlBtn}
          onClick={centerSelected}
          disabled={!selectedId}
          title={selectedId ? 'Center on the selected node' : 'Select a node first'}
          aria-label="Center on selected node"
        >
          <Crosshair size={13} />
        </button>
        {layout === '3d' && (
          <button
            type="button"
            className={`${controlBtn} ${spinning ? 'text-white/30' : 'text-white/80'}`}
            onClick={() => setSpinning((s) => !s)}
            title={spinning ? 'Stop the slow rotation' : 'Resume the slow rotation'}
            aria-label={spinning ? 'Stop rotation' : 'Resume rotation'}
          >
            <RotateCw size={13} className={spinning ? 'animate-spin [animation-duration:6s]' : ''} />
          </button>
        )}
      </div>

      <div className="pointer-events-none absolute bottom-2 left-3 font-mono text-[9px] uppercase tracking-widest" style={{ color: 'rgba(240,150,138,0.85)' }}>
        ● rejected — every other color is a node type (legend below)
      </div>
      <div className="pointer-events-none absolute right-3 bottom-2 font-mono text-[9px] uppercase tracking-widest text-white/25">
        {spinning && layout === '3d' ? 'drifting — touch the graph to stop it' : 'drag nodes · drag to rotate · scroll to zoom'}
      </div>
    </div>
  )
}

export { REJECTED_COLOR, nodeTypeColor }
