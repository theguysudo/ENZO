/**
 * NeuralMapGraph.tsx — the Neural Map's graph entry point.
 *
 * DEFAULT RENDERER: the SVG force graph (IntelligenceGraph) with per-type
 * colors. Why: the reagraph WebGL canvas on the pinned React 18 stack
 * (reagraph 4.22 + fiber 8.13.5 + three 0.161 — 4.32 needs React 19) renders
 * one arbitrarily-dominant node and starves the rest no matter how layout,
 * sizing and camera are driven (verified over a dozen in-browser pixel
 * tests). The SVG graph is deterministic, every node always legible, and it
 * carries the same type-color + icon language.
 *
 * The WebGL canvas stays available behind the "WebGL (beta)" toggle for
 * when the app moves to React 19 + fiber 9, where reagraph 4.32 drops in
 * cleanly. Low-power devices never get a 60fps physics canvas either way.
 */

import { lazy, Suspense, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useLowPowerMode } from '../hooks/useLowPowerMode'
import IntelligenceGraph from './IntelligenceGraph'
import { nodeTypeColor } from './neuralTypeVisuals'
import type { MapGraphNode, MapGraphEdge } from './NeuralMapGraphCanvas'

const LazyCanvas = lazy(() => import('./NeuralMapGraphCanvas'))

export type { MapGraphNode, MapGraphEdge }

export default function NeuralMapGraph({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: MapGraphNode[]
  edges: MapGraphEdge[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const lowPower = useLowPowerMode()
  const [webgl, setWebgl] = useState(false)
  // The WebGL renderer supports a 2D and a 3D camera; 3D drifts slowly and
  // stops on the first touch. The toggle only appears in the WebGL renderer —
  // the SVG graph has no camera to switch.
  const [layout3d, setLayout3d] = useState(false)

  if (nodes.length === 0) {
    return (
      <div className="grid h-64 place-items-center text-sm text-white/40">
        No nodes yet — set a preference, teach the map, or run some research and it grows from what ENZO learns.
      </div>
    )
  }

  const entities = nodes.map((n) => ({
    id: n.id,
    name: n.label,
    kind: n.kind ?? 'node',
    summary: n.summary,
    aliases: n.aliases ?? [],
    evidenceIds: n.evidenceIds ?? [],
    disputed: n.rejected ?? n.fill?.startsWith('#f0968a') ?? false,
    fill: nodeTypeColor(n.type ?? n.kind ?? 'concept', n.rejected),
  }))
  const relationships = edges.map((e) => ({
    id: e.id, from: e.source, to: e.target, label: e.label ?? 'related to',
    status: e.fill?.startsWith('#f0968a') ? 'disputed' as const : 'supported' as const,
    evidenceIds: [],
  }))

  return (
    <>
      <div className="mb-3 flex items-center gap-1.5">
        <RendererToggle webgl={webgl} onWebgl={setWebgl} disabled={lowPower} />
        {webgl && !lowPower && (
          <>
            <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
            {([['2D', false], ['3D', true]] as const).map(([label, v]) => (
              <button
                key={label}
                type="button"
                onClick={() => setLayout3d(v)}
                className={`cursor-pointer rounded-full border px-3 py-1 font-mono-display text-[10px] uppercase tracking-[0.2em] transition-all ${
                  layout3d === v ? 'border-white/40 bg-white/12 text-white' : 'border-white/10 text-white/50 hover:border-white/25 hover:text-white/70'
                }`}
                title={v ? '3D camera — drifts slowly, touch the graph to stop it' : '2D camera — flat, pannable'}
              >
                {label}
              </button>
            ))}
          </>
        )}
      </div>
      {webgl && !lowPower ? (
        <Suspense
          fallback={
            <div className="grid h-[540px] place-items-center rounded-xl border border-white/10 bg-[#0a0a0b] font-mono-display text-[10px] uppercase tracking-widest text-white/30">
              <span className="inline-flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> rendering the graph…</span>
            </div>
          }
        >
          <LazyCanvas nodes={nodes} edges={edges} selectedId={selectedId} onSelect={onSelect} layout={layout3d ? '3d' : '2d'} />
        </Suspense>
      ) : (
        <IntelligenceGraph
          entities={entities}
          relationships={relationships}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}
    </>
  )
}

function RendererToggle({ webgl, onWebgl, disabled }: { webgl: boolean; onWebgl: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => onWebgl(false)}
        className={`cursor-pointer rounded-full border px-3.5 py-1 font-mono-display text-[10px] uppercase tracking-widest transition-all ${
          !webgl ? 'border-white/40 bg-white/12 text-white' : 'border-white/10 text-white/40 hover:border-white/25 hover:text-white/70'
        }`}
        title="SVG force graph — crisp, always legible, near-zero GPU"
      >
        Standard
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onWebgl(true)}
        className={`cursor-pointer rounded-full border px-3.5 py-1 font-mono-display text-[10px] uppercase tracking-widest transition-all ${
          webgl ? 'border-white/40 bg-white/12 text-white' : 'border-white/10 text-white/40 hover:border-white/25 hover:text-white/70'
        } disabled:cursor-default disabled:opacity-40`}
        title="reagraph WebGL renderer (experimental on this build)"
      >
        WebGL beta
      </button>
    </div>
  )
}
