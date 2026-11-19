/**
 * IntelligenceGraph.tsx — the investigation's entity graph.
 *
 * Interactive SVG force-directed layout (hand-rolled, zero new deps — same
 * discipline as AgentsGraph): repulsion between nodes, springs on evidenced
 * relationships, mild centering. Settles synchronously in a useMemo (no rAF
 * loop, no idle CPU), then supports pan (drag background), wheel zoom, and
 * node dragging. Click a node → onSelect for the inspector panel; a clean
 * click (not a drag) → onActivate, which opens the node explainer.
 *
 * LONG RESEARCH: a 70-node graph in a fixed 860×560 box is a hairball —
 * labels overlap, edges cross, nothing is readable. Three fixes:
 *   1. the world GROWS with the node count (more room to spread out),
 *   2. detail is zoom-dependent: names/edge labels fade out as you zoom away
 *      and the selection dims everything that is not related to it,
 *   3. the view can be zoomed to a node or fitted to the whole graph.
 *
 * ZOOM: the view is a {x, y, k} transform applied to the SVG group. The wheel
 * zooms toward the cursor (the point under the pointer stays put) and the
 * transitions are GSAP tweens, so a zoom or a fit reads as a move instead of
 * a jump. The pointer maths use the SVG's real preserveAspectRatio mapping
 * (the old version assumed the viewport aspect matched the world, which
 * skewed every zoom on a wide layout).
 *
 * Mono theme: white alphas on near-black; coral (#f0968a) only for disputed
 * evidence, emerald never needed here (supported = solid white alpha).
 */

import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { gsap } from 'gsap'
import { ZoomIn, ZoomOut, Maximize2, Crosshair } from 'lucide-react'

export interface GraphEntity {
  id: string
  name: string
  kind: string
  summary?: string
  aliases?: string[]
  evidenceIds: string[]
  disputed?: boolean
  /** Optional stroke color — lets richer surfaces (Neural Map fallback) carry
   *  type colors; defaults to the mono theme when absent. */
  fill?: string
}

export interface GraphRelationship {
  id: string
  from: string
  to: string
  label: string
  status: 'supported' | 'hypothesis' | 'disputed'
  evidenceIds: string[]
}

const MAX_NODES = 70
/** Above this zoom the graph is "readable" — names and edge labels return. */
const DETAIL_ZOOM = 0.72

interface Positioned {
  x: number
  y: number
}

interface View {
  x: number
  y: number
  k: number
}

/** The world grows with the graph so a long investigation has room to breathe. */
function worldFor(n: number): { w: number; h: number } {
  const extra = Math.max(0, n - 16)
  return {
    w: Math.min(2300, 860 + extra * 20),
    h: Math.min(1600, 560 + extra * 13),
  }
}

/** Deterministic seeded layout — same data settles to the same shape. */
function simulate(entities: GraphEntity[], relationships: GraphRelationship[], world: { w: number; h: number }): Map<string, Positioned> {
  const pos = new Map<string, Positioned>()
  const n = entities.length
  const W = world.w
  const H = world.h
  const radius = Math.min(W, H) * 0.38
  entities.forEach((e, i) => {
    const angle = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2
    const ring = i % 2 === 0 ? radius : radius * 0.55
    pos.set(e.id, { x: W / 2 + Math.cos(angle) * ring, y: H / 2 + Math.sin(angle) * ring })
  })
  const ids = entities.map((e) => e.id)
  const byId = new Map(entities.map((e) => [e.id, e]))
  const alpha0 = 0.9
  // Springs pull to a distance that scales with the world, so a big graph
  // does not collapse into the middle.
  const want = Math.max(150, Math.min(W, H) * 0.22)
  // Node labels sit ~46px apart at most, so pairs closer than that would
  // render their names on top of each other (the "text overlap" bug).
  const MIN_D = 54
  for (let iter = 0; iter < 260; iter++) {
    const alpha = alpha0 * (1 - iter / 260)
    // pairwise repulsion
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!
        const b = pos.get(ids[j])!
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
        const d = Math.sqrt(d2)
        const rep = (26000 * alpha) / d2
        const fx = (dx / d) * rep
        const fy = (dy / d) * rep
        a.x -= fx; a.y -= fy
        b.x += fx; b.y += fy
      }
    }
    // spring on relationships
    for (const rel of relationships) {
      const a = pos.get(rel.from)
      const b = pos.get(rel.to)
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01)
      const f = ((d - want) / d) * 0.06 * alpha
      a.x += dx * f; a.y += dy * f
      b.x -= dx * f; b.y -= dy * f
    }
    // minimum separation: push apart so names do not collide
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!
        const b = pos.get(ids[j])!
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d = Math.sqrt(dx * dx + dy * dy)
        if (d >= MIN_D) continue
        if (d < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 1 }
        const push = ((MIN_D - d) / d) * 0.5 * alpha
        a.x -= dx * push; a.y -= dy * push
        b.x += dx * push; b.y += dy * push
      }
    }
    // centering + clamping
    for (const id of ids) {
      const p = pos.get(id)!
      p.x += (W / 2 - p.x) * 0.012 * alpha
      p.y += (H / 2 - p.y) * 0.012 * alpha
      const r = 8 + Math.min(10, (byId.get(id)?.evidenceIds.length ?? 1) * 1.2)
      p.x = Math.max(r + 24, Math.min(W - r - 24, p.x))
      p.y = Math.max(r + 40, Math.min(H - r - 30, p.y))
    }
  }
  return pos
}

export default function IntelligenceGraph({
  entities, relationships, selectedId, onSelect, onActivate,
}: {
  entities: GraphEntity[]
  relationships: GraphRelationship[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Fired on a clean click (no drag) — the investigation opens the explainer. */
  onActivate?: (id: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 })
  const tweenRef = useRef<gsap.core.Tween | null>(null)
  const [, setTick] = useState(0)
  const dragNode = useRef<string | null>(null)
  const panState = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  // Where the pointer went down, so a drag is not mistaken for a click.
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)

  // Cap huge graphs to the best-evidenced nodes so the layout stays readable.
  const shown = useMemo(() => {
    if (entities.length <= MAX_NODES) return { nodes: entities, hidden: 0 }
    const keep = [...entities].sort((a, b) => b.evidenceIds.length - a.evidenceIds.length).slice(0, MAX_NODES)
    const ids = new Set(keep.map((e) => e.id))
    return { nodes: keep, hidden: entities.length - keep.length, relIds: ids }
  }, [entities])

  const rels = useMemo(() => {
    const ids = new Set(shown.nodes.map((e) => e.id))
    return relationships.filter((r) => ids.has(r.from) && ids.has(r.to))
  }, [shown, relationships])

  const world = useMemo(() => worldFor(shown.nodes.length), [shown.nodes.length])
  const positions = useMemo(() => simulate(shown.nodes, rels, world), [shown, rels, world])

  /** The SVG's real viewBox → viewport mapping (preserveAspectRatio=meet). */
  const viewport = useCallback(() => {
    const el = containerRef.current
    if (!el) return { scale: 1, offX: 0, offY: 0, rect: { left: 0, top: 0, width: 1, height: 1 } }
    const rect = el.getBoundingClientRect()
    const scale = Math.min(rect.width / world.w, rect.height / world.h) || 1
    return {
      scale,
      offX: (rect.width - world.w * scale) / 2,
      offY: (rect.height - world.h * scale) / 2,
      rect,
    }
  }, [world])

  /** Client point → world point, honouring the current zoom. */
  const svgPoint = useCallback((clientX: number, clientY: number): Positioned => {
    const { scale, offX, offY, rect } = viewport()
    const v = viewRef.current
    return {
      x: ((clientX - rect.left - offX) / scale - v.x) / v.k,
      y: ((clientY - rect.top - offY) / scale - v.y) / v.k,
    }
  }, [viewport])

  /** GSAP-move the view to a target (used by zoom buttons, fit and focus). */
  const animateView = useCallback((target: View, duration = 0.4) => {
    // A wheel gesture fires a zoom every tick — without killing the running
    // tween, two tweens would fight over the same view and the zoom jitters.
    tweenRef.current?.kill()
    const proxy = { ...viewRef.current }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      viewRef.current = { ...target }
      setTick((t) => t + 1)
      return
    }
    tweenRef.current = gsap.to(proxy, {
      x: target.x, y: target.y, k: target.k,
      duration, ease: 'power2.out',
      onUpdate: () => {
        viewRef.current = { x: proxy.x, y: proxy.y, k: proxy.k }
        setTick((t) => t + 1)
      },
    })
  }, [])

  /** Zoom by a factor, keeping the point under the cursor (or the centre). */
  const zoomBy = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const { scale, offX, offY, rect } = viewport()
    const v = viewRef.current
    const k1 = Math.max(0.3, Math.min(4, v.k * factor))
    if (Math.abs(k1 - v.k) < 0.0005) return
    // Anchor: the world point under the pointer stays under the pointer.
    const px = clientX ?? rect.left + rect.width / 2
    const py = clientY ?? rect.top + rect.height / 2
    const wx = (px - rect.left - offX) / scale
    const wy = (py - rect.top - offY) / scale
    const anchorX = (wx - v.x) / v.k
    const anchorY = (wy - v.y) / v.k
    animateView({ x: wx - anchorX * k1, y: wy - anchorY * k1, k: k1 }, 0.26)
  }, [animateView, viewport])

  /** Fit the whole graph (or one node) into the viewport. */
  const fit = useCallback((nodeId?: string) => {
    const { scale, rect } = viewport()
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const ids = nodeId ? [nodeId] : shown.nodes.map((e) => e.id)
    for (const id of ids) {
      const p = positions.get(id)
      if (!p) continue
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    if (!Number.isFinite(minX)) return
    const pad = 60
    const w = Math.max(1, maxX - minX) + pad * 2
    const h = Math.max(1, maxY - minY) + pad * 2
    // the world→viewport scale is `scale`; the visible world size is
    // rect/scale, so the zoom that fits the content is that ratio.
    const k = Math.max(0.3, Math.min(2.2, Math.min((rect.width / scale) / w, (rect.height / scale) / h)))
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    // The group transform is translate(x,y) scale(k) inside a viewBox whose
    // centre is (world.w/2, world.h/2) — so centring the content means
    // x = world.w/2 - k*cx, not -k*cx (which would pin it to the top-left).
    animateView({ x: world.w / 2 - cx * k, y: world.h / 2 - cy * k, k })
  }, [animateView, positions, shown.nodes, viewport, world])

  // Wheel zoom — native listener so preventDefault works (React's onWheel is
  // passive). Wheel events fire far more often than frames; queueing the delta
  // and applying one setView per animation frame keeps a zoom gesture from
  // forcing a full SVG re-render on every wheel tick.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let queuedDelta: number | null = null
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (queuedDelta !== null) { queuedDelta += e.deltaY; return }
      queuedDelta = e.deltaY
      requestAnimationFrame(() => {
        const dy = queuedDelta ?? 0
        queuedDelta = null
        if (Math.abs(dy) < 0.5) return
        zoomBy(dy < 0 ? 1.14 : 0.88, e.clientX, e.clientY)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  const onPointerDownBg = (e: React.PointerEvent) => {
    if (dragNode.current) return
    panState.current = { sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y }
    downAt.current = { x: e.clientX, y: e.clientY }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragNode.current) {
      const p = svgPoint(e.clientX, e.clientY)
      const pos = positions.get(dragNode.current)
      if (pos) { pos.x = p.x; pos.y = p.y; setTick((t) => t + 1) }
      return
    }
    const pan = panState.current
    if (pan) {
      const { scale } = viewport()
      // Capture the pan origin in locals: the state updater runs after this
      // handler returns, by which time onPointerUp may already have cleared
      // panState.current — reading panState.current!.ox there threw
      // "Cannot read properties of null (reading 'ox')" and (pre-boundary)
      // blanked the whole app.
      const { sx: psx, sy: psy, ox, oy } = pan
      viewRef.current = {
        ...viewRef.current,
        x: ox + (e.clientX - psx) / scale,
        y: oy + (e.clientY - psy) / scale,
      }
      setTick((t) => t + 1)
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const wasNode = !!dragNode.current
    dragNode.current = null
    const pan = panState.current
    panState.current = null
    if (wasNode) return
    // A click on the background (not a pan) clears the selection.
    const moved = downAt.current ? Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) : 0
    downAt.current = null
    if (pan && moved <= 5) onSelect(null)
  }
  const onPointerLeave = () => { dragNode.current = null; panState.current = null }

  const focus = selectedId
  // With a node SELECTED, everything not connected to it fades out — the
  // single biggest readability win on a dense graph. Hover only brightens:
  // dimming the whole graph on every mouse move is flickery.
  const focusRels = useMemo(() => {
    if (!focus) return null
    const set = new Set<string>([focus])
    for (const r of rels) {
      if (r.from === focus) set.add(r.to)
      if (r.to === focus) set.add(r.from)
    }
    return set
  }, [focus, rels])
  const hoverSet = useMemo(() => {
    if (!hovered) return null
    const set = new Set<string>([hovered])
    for (const r of rels) {
      if (r.from === hovered) set.add(r.to)
      if (r.to === hovered) set.add(r.from)
    }
    return set
  }, [hovered, rels])

  if (entities.length === 0) {
    return (
      <div className="grid h-64 place-items-center text-sm text-white/40">
        No entities yet — run the investigation and the graph grows from its evidence.
      </div>
    )
  }

  const view = viewRef.current
  const detailed = view.k >= DETAIL_ZOOM

  const controlBtn =
    'inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/12 bg-black/60 text-white/70 transition-colors hover:border-white/30 hover:text-white disabled:opacity-30 disabled:hover:border-white/12'

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="relative h-[520px] cursor-grab touch-none select-none overflow-hidden rounded-xl border border-white/10 bg-black/30 active:cursor-grabbing"
        onPointerDown={onPointerDownBg}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        <svg viewBox={`0 0 ${world.w} ${world.h}`} className="h-full w-full">
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {rels.map((rel) => {
              const a = positions.get(rel.from)
              const b = positions.get(rel.to)
              if (!a || !b) return null
              const disputed = rel.status === 'disputed'
              const related = !focusRels || focusRels.has(rel.from) && focusRels.has(rel.to)
              const hot = !!hoverSet && hoverSet.has(rel.from) && hoverSet.has(rel.to)
              const stroke = hot
                ? 'rgba(255,255,255,0.55)'
                : disputed ? 'rgba(240,150,138,0.55)' : rel.status === 'supported' ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.13)'
              // Edge labels are noise on a dense graph — they only appear for
              // the focused/hovered neighbourhood, or when zoomed in enough.
              const labelSet = focusRels ?? hoverSet
              const showLabel = detailed && (!!labelSet ? labelSet.has(rel.from) && labelSet.has(rel.to) : true)
              return (
                <g key={rel.id} opacity={related ? 1 : 0.16}>
                  <line
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={stroke}
                    strokeWidth={disputed ? 1.4 : 1.1}
                    strokeDasharray={rel.status === 'hypothesis' ? '3 5' : undefined}
                  />
                  {showLabel && (
                    <text
                      x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 5}
                      textAnchor="middle"
                      fill={disputed ? 'rgba(240,150,138,0.75)' : 'rgba(255,255,255,0.35)'}
                      style={{ fontSize: 8.5, fontFamily: 'monospace', paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.85)', strokeWidth: 3 }}
                    >
                      {rel.label}
                    </text>
                  )}
                </g>
              )
            })}
            {shown.nodes.map((ent, ni) => {
              const p = positions.get(ent.id)
              if (!p) return null
              const r = 8 + Math.min(10, ent.evidenceIds.length * 1.2)
              const selected = selectedId === ent.id
              const dim = !!focusRels && !focusRels.has(ent.id)
              // Names are the first thing to go when the graph gets busy:
              // they only return when zoomed in, or for the focused node.
              const showName = detailed || selected || ent.id === hovered
              const showKind = detailed && view.k >= 1.15
              // Alternate the name label above/below the node so neighbours in a
              // dense cluster don't draw their names at the same height.
              const nameAbove = ni % 2 === 0
              return (
                <g
                  key={ent.id}
                  transform={`translate(${p.x},${p.y})`}
                  className="cursor-pointer"
                  opacity={dim ? 0.22 : 1}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    dragNode.current = ent.id
                    downAt.current = { x: e.clientX, y: e.clientY }
                    ;(e.target as Element).setPointerCapture?.(e.pointerId)
                  }}
                  onPointerEnter={() => setHovered(ent.id)}
                  onPointerLeave={() => setHovered((h) => (h === ent.id ? null : h))}
                  onClick={(e) => {
                    e.stopPropagation()
                    // A drag ends on the node too — only a pointer that barely
                    // moved counts as a click (it opens the explainer).
                    const moved = downAt.current
                      ? Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y)
                      : 0
                    downAt.current = null
                    if (moved > 5) return
                    onSelect(ent.id)
                    onActivate?.(ent.id)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    fit(ent.id)
                  }}
                >
                  <circle
                    r={r}
                    fill={ent.fill ? `${ent.fill}2e` : 'rgba(255,255,255,0.10)'}
                    stroke={ent.disputed ? 'rgba(240,150,138,0.9)' : ent.fill ?? (selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)')}
                    strokeWidth={selected ? 2.4 : ent.fill ? 2.2 : 1.4}
                  />
                  {showName && (
                    <text
                      y={nameAbove ? -r - 6 : r + 14}
                      textAnchor="middle"
                      fill={selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.8)'}
                      style={{ fontSize: 10.5, paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.85)', strokeWidth: 3 }}
                    >
                      {ent.name.length > 26 ? `${ent.name.slice(0, 24)}…` : ent.name}
                    </text>
                  )}
                  {showKind && (
                    <text
                      y={nameAbove ? r + 12 : -r - 8}
                      textAnchor="middle"
                      fill="rgba(255,255,255,0.35)"
                      style={{ fontSize: 8, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.14em', paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.85)', strokeWidth: 3 }}
                    >
                      {`${ent.kind} · ${ent.evidenceIds.length}`}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>

        {/* view controls */}
        <div className="absolute right-3 top-3 flex flex-col gap-1.5">
          <button type="button" className={controlBtn} onClick={() => zoomBy(1.25)} title="Zoom in" aria-label="Zoom in">
            <ZoomIn size={13} />
          </button>
          <button type="button" className={controlBtn} onClick={() => zoomBy(0.8)} title="Zoom out" aria-label="Zoom out">
            <ZoomOut size={13} />
          </button>
          <button type="button" className={controlBtn} onClick={() => fit()} title="Fit the whole graph" aria-label="Fit graph">
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            className={controlBtn}
            onClick={() => (selectedId ? fit(selectedId) : fit())}
            disabled={!selectedId}
            title={selectedId ? 'Zoom to the selected node' : 'Select a node first'}
            aria-label="Zoom to selected node"
          >
            <Crosshair size={13} />
          </button>
        </div>

        <div className="pointer-events-none absolute bottom-2 left-3 flex gap-3 font-mono text-[9px] uppercase tracking-widest text-white/35">
          <span>— supported</span>
          <span className="opacity-60">┄ hypothesis</span>
          <span className="text-[#f0968a]/80">— disputed</span>
        </div>
        {shown.hidden > 0 && (
          <div className="pointer-events-none absolute right-3 top-12 rounded-full border border-white/10 bg-black/60 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-white/40">
            +{shown.hidden} weaker entities hidden
          </div>
        )}
        <div className="pointer-events-none absolute bottom-2 right-3 font-mono text-[9px] uppercase tracking-widest text-white/25">
          drag to move · scroll to zoom · double-click a node to zoom in
        </div>
      </div>
    </div>
  )
}
