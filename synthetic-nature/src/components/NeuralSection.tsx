/**
 * NeuralSection.tsx — the ENZO Neural Engine workspace tab (Phase 3).
 *
 * Four connected views over the same per-owner data:
 *   Research Profile — explicit controls for the 8 preference dimensions,
 *                      each showing the effective value with its provenance
 *                      (explicit vs learned+confidence) and a reset.
 *   Neural Map       — the research knowledge graph (reagraph WebGL renderer
 *                      with fluid force physics; SVG fallback on low-power);
 *                      node inspector with correct / reject / forget controls.
 *   Learning History — timeline of what changed, why, explicit vs inferred,
 *                      with forget actions.
 *   Provider Status  — the zero-cost capability registry: verified-free
 *                      timestamps, quota limits, disabled reasons, privacy
 *                      classes. A truthful $0 meter, not a marketing claim.
 *
 * Language rule from the spec: this is a research knowledge graph and a
 * preference profile — never described as a neural network or changed model
 * weights. Training is Phase 5+, requires separate consent, and shows as a
 * disabled card until it exists.
 *
 * Auth follows the vault pattern: mintVaultToken() → x-vault-token,
 * x-enzo-owner device id for ownership, no keys involved anywhere here.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Trash2, ExternalLink, AlertTriangle, RotateCw, X,
  ListChecks, Network, History, ShieldCheck, Plus, Lock,
} from 'lucide-react'
import { mintVaultToken } from '../lib/vaultToken'
import { getEnzoOwnerId } from '../lib/enzoOwner'
import NeuralMapGraph, { type MapGraphNode, type MapGraphEdge } from './NeuralMapGraph'
import { NODE_TYPE_COLORS, nodeTypeColor } from './neuralTypeVisuals'
import {
  Tag, Lightbulb, Globe, BadgeCheck, Cog, SlidersHorizontal, HelpCircle, Sparkles,
} from 'lucide-react'

// ── Types (mirror src/neural-engine/types.ts) ────────────────────────────────

const DIMENSIONS = ['depth', 'researchApproach', 'evidenceStandards', 'citationStyle', 'outputForm', 'uncertainty', 'stoppingCriteria', 'visualization'] as const
type Dimension = typeof DIMENSIONS[number]

const DIMENSION_LABELS: Record<Dimension, string> = {
  depth: 'Research depth',
  researchApproach: 'Approach',
  evidenceStandards: 'Evidence standards',
  citationStyle: 'Citation style',
  outputForm: 'Output form',
  uncertainty: 'Uncertainty handling',
  stoppingCriteria: 'Stopping criteria',
  visualization: 'Visualization',
}

const PREF_VALUES: Record<Dimension, string[]> = {
  depth: ['brief', 'standard', 'exhaustive'],
  researchApproach: ['breadth-first', 'hypothesis-led', 'comparative', 'chronology-first'],
  evidenceStandards: ['primary-sources', 'peer-reviewed', 'official-docs', 'diverse-perspectives'],
  citationStyle: ['inline-citations', 'bibliography', 'source-notes'],
  outputForm: ['executive-summary', 'detailed-report', 'table', 'mind-map', 'annotated-bibliography'],
  uncertainty: ['caveats', 'counterarguments', 'confidence-labels'],
  stoppingCriteria: ['stop-at-convergence', 'keep-searching-counterevidence'],
  visualization: ['mind-map', 'timeline', 'matrix', 'causal-graph'],
}

interface PrefValue {
  value: string; source: 'user_explicit' | 'inferred'
  confidence: number; samples: number; lastSeenAt: number; rationale?: string
}

interface Effective {
  dimension: Dimension; value: string | null
  source: 'user_explicit' | 'inferred' | 'default'; confidence: number; samples: number
}

interface Profile {
  preferences: Record<Dimension, Record<string, PrefValue>>
  consentVersion: number; trainingAllowed: boolean; updatedAt: number
}

interface NeuralNode {
  id: string; type: string; label: string; normalizedValue: string
  confidence: number; verified: boolean; sourceEventId?: string; sourceRecordId?: string
  outdated?: boolean; excludedFromTraining?: boolean; createdAt: number; lastSeenAt: number
}

interface NeuralEdge {
  id: string; from: string; relation: string; to: string
  confidence: number; evidenceRefs: string[]; createdAt: number
}

interface LearningEvent {
  id: string; type: string; dimension?: string; value?: string; nodeId?: string
  detail?: string; signal: 'explicit' | 'inferred'
  provenance: { modelId?: string; sessionId?: string; createdAt: number }
}

interface ProviderCap {
  providerId: string; modelId: string
  freeTierVerified: boolean; evidenceUrl: string; lastVerifiedAt: string
  dailyRequestLimit?: number; dailyTokenLimit?: number; dailyNeuronLimit?: number
  requiresBillingMethod: boolean; productionEligibleOnFreeTier: boolean
  privacyClass: 'public' | 'restricted' | 'unknown'; enabledInZeroCostMode: boolean
  freeModels: number; paidModels: number
}

const NODE_TYPE_LABELS: Record<string, string> = {
  topic: 'topic', concept: 'concept', source: 'source', claim: 'claim',
  method: 'method', preference: 'preference', question: 'question', finding: 'finding',
}

const NODE_TYPE_ICONS: Record<string, React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>> = {
  topic: Tag, concept: Lightbulb, source: Globe, claim: BadgeCheck,
  method: Cog, preference: SlidersHorizontal, question: HelpCircle, finding: Sparkles,
}

// ── API helper (vault pattern + device ownership) ────────────────────────────

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; json: any }> {
  const token = await mintVaultToken()
  const res = await fetch(path, {
    method: init.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-enzo-owner': getEnzoOwnerId(),
      ...(token ? { 'x-vault-token': token } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  let json: any = null
  try { json = await res.json() } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, json }
}

const timeAgo = (ts?: number): string => {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const chip = (label: string, on: boolean, onClick?: () => void, title?: string, icon?: React.ReactNode) => (
  <button
    key={label}
    type="button"
    onClick={onClick}
    title={title}
    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono-display text-[10px] uppercase tracking-[0.15em] transition-all ${
      on ? 'border-white/40 bg-white/12 text-white' : 'border-white/10 text-white/40 hover:border-white/25 hover:text-white/70'
    } ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
  >
    {icon}
    {label}
  </button>
)

// ── Main component ───────────────────────────────────────────────────────────

type Tab = 'profile' | 'map' | 'history' | 'providers'

export default function NeuralSection() {
  const [tab, setTab] = useState<Tab>('profile')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [effective, setEffective] = useState<Effective[]>([])
  const [map, setMap] = useState<{ nodes: NeuralNode[]; edges: NeuralEdge[]; sources: any[]; stats: any } | null>(null)
  const [events, setEvents] = useState<LearningEvent[]>([])
  const [caps, setCaps] = useState<{ zeroCostMode: boolean; providers: ProviderCap[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [opError, setOpError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [newNode, setNewNode] = useState({ type: 'topic', label: '' })

  const loadAll = useCallback(async () => {
    setLoading(true)
    setOpError('')
    const [p, m, h, c] = await Promise.all([
      api('/api/neural-engine/profile'),
      api('/api/neural-engine/map?limit=150'),
      api('/api/neural-engine/history?limit=100'),
      api('/api/providers/capabilities'),
    ])
    if (p.ok) { setProfile(p.json.profile); setEffective(p.json.effective) }
    else setOpError(p.json?.message || `Profile unavailable (HTTP ${p.status})`)
    if (m.ok) setMap(m.json)
    if (h.ok) setEvents(h.json.events ?? [])
    if (c.ok) setCaps(c.json)
    setLoading(false)
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  const patchProfile = async (body: Record<string, unknown>) => {
    setBusy(true)
    setOpError('')
    const r = await api('/api/neural-engine/profile', { method: 'PATCH', body })
    setBusy(false)
    if (r.ok) { setProfile(r.json.profile); setEffective(r.json.effective) }
    else setOpError(r.json?.message || `Save failed (HTTP ${r.status})`)
  }

  const nodeEvent = async (type: string, nodeId: string, extra?: Record<string, unknown>) => {
    setBusy(true)
    const r = await api('/api/neural-engine/events', { method: 'POST', body: { type, nodeId, ...(extra ?? {}) } })
    setBusy(false)
    if (!r.ok) { setOpError(r.json?.message || `Action failed (HTTP ${r.status})`); return }
    await loadAll()
  }

  const graphEntities = useMemo(() => (map?.nodes ?? []).map((n) => ({
    id: n.id,
    name: n.label,
    kind: n.type,
    summary: n.verified ? undefined : (n.confidence === 0 ? 'Rejected — excluded from context' : 'Unverified — treat as a hypothesis'),
    aliases: [],
    evidenceIds: map?.edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => e.id) ?? [],
    disputed: n.confidence === 0,
  })), [map])

  const graphRels = useMemo(() => (map?.edges ?? []).map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    label: e.relation.replace(/_/g, ' '),
    status: e.confidence === 0 ? 'disputed' as const : e.confidence >= 0.5 ? 'supported' as const : 'hypothesis' as const,
    evidenceIds: e.evidenceRefs,
  })), [map])

  // reagraph renderer data: node/edge fill carries the disputed (coral) and
  // verified (bright) states; the SVG fallback reuses the same objects.
  const mapNodes: MapGraphNode[] = useMemo(() => (map?.nodes ?? []).map((n) => ({
    id: n.id,
    label: n.label,
    type: n.type,
    rejected: n.confidence === 0,
    ...(n.confidence === 0 ? { fill: '#f0968a' } : n.verified ? { fill: 'rgba(255,255,255,0.85)' } : {}),
    kind: n.type,
    summary: n.verified ? undefined : (n.confidence === 0 ? 'Rejected — excluded from context' : 'Unverified — treat as a hypothesis'),
    aliases: [] as string[],
    evidenceIds: map?.edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => e.id) ?? [],
  })), [map])

  const mapEdges: MapGraphEdge[] = useMemo(() => (map?.edges ?? []).map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.relation.replace(/_/g, ' '),
    ...(e.confidence === 0 ? { fill: '#f0968a' } : {}),
  })), [map])

  const selected = map?.nodes.find((n) => n.id === selectedNode) ?? null

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <div className="font-mono-display text-[10px] uppercase tracking-[0.3em] text-white/55">Workspace · ENZO Neural Engine</div>
        <h2 className="mt-2 font-garamond text-3xl text-white/95">A research profile that remembers how you work.</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/45">
          A private, editable research profile and knowledge graph. Explicit settings always override what ENZO
          infers; every learned item carries its confidence and evidence; and Forget removes it from the context
          and from any future training data. Works with every model provider — no weights are changed.
        </p>
      </header>

      {opError && (
        <div className="mb-5 flex items-center gap-2 rounded-xl border border-[#f0968a]/30 bg-[#f0968a]/[0.07] px-4 py-2.5 text-[13px] text-[#f0b0a6]">
          <AlertTriangle size={14} className="shrink-0" /> {opError}
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-white/[0.07] pb-4">
        {([
          ['profile', 'Research Profile', ListChecks],
          ['map', 'Neural Map', Network],
          ['history', 'Learning History', History],
          ['providers', 'Provider Status', ShieldCheck],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-4 py-1.5 font-mono-display text-[10px] uppercase tracking-[0.2em] transition-all ${
              tab === key ? 'bg-white/12 text-white' : 'text-white/50 hover:bg-white/[0.06] hover:text-white/80'
            }`}
          >
            <Icon size={11} /> {label}
          </button>
        ))}
        <button type="button" onClick={() => void loadAll()} className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 px-3.5 py-1.5 font-mono-display text-[10px] uppercase tracking-widest text-white/50 transition-colors hover:border-white/25 hover:text-white">
          <RotateCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {loading && !profile ? (
        <div className="grid h-40 place-items-center font-mono-display text-[10px] uppercase tracking-widest text-white/30">Reading your profile…</div>
      ) : (
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
            {/* ── RESEARCH PROFILE ── */}
            {tab === 'profile' && profile && (
              <div className="space-y-3">
                {DIMENSIONS.map((dim) => {
                  const eff = effective.find((e) => e.dimension === dim)
                  const explicit = Object.entries(profile.preferences[dim] ?? {}).filter(([, p]) => p.source === 'user_explicit')
                  const inferred = Object.entries(profile.preferences[dim] ?? {}).filter(([, p]) => p.source === 'inferred')
                  return (
                    <div key={dim} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-[14px] font-medium text-white/90">{DIMENSION_LABELS[dim]}</div>
                          <div className="mt-0.5 text-[12.5px] text-white/50">
                            {eff?.value
                              ? <>Currently: <span className="text-white/85">{eff.value}</span> ({eff.source === 'user_explicit' ? 'your explicit setting' : `learned · confidence ${eff.confidence.toFixed(2)} · ${eff.samples} observations`})</>
                              : 'No preference yet — ENZO will learn from repeated research choices (never from a single one).'}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {PREF_VALUES[dim].map((v) => chip(
                            v,
                            explicit.some(([, p]) => p.value === v) || (!explicit.length && eff?.value === v),
                            () => void patchProfile({ set: [{ dimension: dim, value: v }] }),
                            'Set as your explicit preference',
                          ))}
                          {(explicit.length > 0 || inferred.length > 0) && chip('Reset', false, () => void patchProfile({
                            clear: [...explicit, ...inferred].map(([v]) => ({ dimension: dim, value: v })),
                          }), 'Forget everything learned/set for this dimension')}
                        </div>
                      </div>
                      {inferred.length > 0 && (
                        <div className="mt-3 space-y-1 border-t border-white/[0.06] pt-3">
                          {inferred.map(([v, p]) => (
                            <div key={v} className="flex items-center gap-2 font-mono text-[10px] text-white/35">
                              <span className="text-white/50">learned: {v}</span>
                              <span>· confidence {p.confidence.toFixed(2)} · {p.samples} observations · {timeAgo(p.lastSeenAt)}</span>
                              {p.rationale && <span className="text-white/25">— {p.rationale}</span>}
                              <button type="button" onClick={() => void patchProfile({ clear: [{ dimension: dim, value: v }] })} className="ml-1 cursor-pointer text-white/30 hover:text-[#f0a096]">
                                <X size={10} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Consent + Training Lab placeholder — honest until Phase 5+ */}
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 text-[14px] font-medium text-white/90">
                        <Lock size={13} className="text-white/50" /> Training consent
                      </div>
                      <div className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-white/50">
                        Separate from personalization. When off (default), nothing from your profile or graph can ever
                        reach a dataset builder. There is no cross-user training, ever, without a separate explicit opt-in.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void patchProfile({ trainingAllowed: !profile.trainingAllowed })}
                      className={`shrink-0 cursor-pointer rounded-full border px-4 py-2 font-mono-display text-[10px] uppercase tracking-widest transition-all ${
                        profile.trainingAllowed ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' : 'border-white/15 text-white/50 hover:border-white/30 hover:text-white'
                      }`}
                    >
                      {profile.trainingAllowed ? 'Granted' : 'Not granted'}
                    </button>
                  </div>
                  <div className="mt-4 flex items-start gap-2 rounded-xl border border-white/[0.07] bg-black/25 px-4 py-3 text-[12px] leading-relaxed text-white/40">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-white/30" />
                    Training Lab (SFT / DPO / LoRA notebooks) arrives in a later phase. Nothing here trains model
                    weights or sends data anywhere — the profile above is prompt context only, applied identically
                    across all providers.
                  </div>
                </div>
              </div>
            )}

            {/* ── NEURAL MAP ── */}
            {tab === 'map' && map && (
              <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
                <div>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    {chip(`${map.stats.activeNodes} active nodes`, false, undefined, undefined, <Network size={10} />)}
                    {chip(`${map.stats.verified} verified`, false, undefined, undefined, <BadgeCheck size={10} />)}
                    {chip(`${map.stats.edges} relationships`, false, undefined, undefined, <Sparkles size={10} />)}
                    {chip(`${map.stats.events} learning events`, false, undefined, undefined, <History size={10} />)}
                  </div>
                  <NeuralMapGraph nodes={mapNodes} edges={mapEdges} selectedId={selectedNode} onSelect={setSelectedNode} />
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2">
                    {Object.entries(NODE_TYPE_COLORS).map(([type, color]) => {
                      const Icon = NODE_TYPE_ICONS[type] ?? Lightbulb
                      return (
                        <span key={type} className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-white/50">
                          <Icon size={10} style={{ color }} />
                          {type}
                        </span>
                      )
                    })}
                  </div>
                  <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="mb-2 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Teach the map a node</div>
                    <div className="flex flex-wrap gap-2">
                      <select
                        value={newNode.type}
                        onChange={(e) => setNewNode((n) => ({ ...n, type: e.target.value }))}
                        className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-xs text-white outline-none focus:border-white/25"
                      >
                        {Object.entries(NODE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k} className="bg-black">{v}</option>)}
                      </select>
                      <input
                        value={newNode.label}
                        onChange={(e) => setNewNode((n) => ({ ...n, label: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newNode.label.trim()) {
                            void (async () => {
                              const r = await api('/api/neural-engine/nodes', { method: 'POST', body: { type: newNode.type, label: newNode.label.trim(), confidence: 1, verified: true } })
                              if (r.ok) { setNewNode({ type: newNode.type, label: '' }); await loadAll() } else setOpError(r.json?.message || 'Could not add node')
                            })()
                          }
                        }}
                        placeholder="e.g. prefers primary sources over aggregators"
                        className="min-w-48 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-white placeholder-white/25 outline-none focus:border-white/25"
                      />
                      <button
                        type="button"
                        disabled={!newNode.label.trim() || busy}
                        onClick={() => void (async () => {
                          const r = await api('/api/neural-engine/nodes', { method: 'POST', body: { type: newNode.type, label: newNode.label.trim(), confidence: 1, verified: true } })
                          if (r.ok) { setNewNode({ type: newNode.type, label: '' }); await loadAll() } else setOpError(r.json?.message || 'Could not add node')
                        })()}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 font-mono-display text-[10px] uppercase tracking-widest text-white/60 transition-colors enabled:hover:border-white/30 enabled:hover:text-white disabled:opacity-30"
                      >
                        <Plus size={11} /> Add node
                      </button>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  {selected ? (
                    <>
                      {(() => {
                        const Icon = NODE_TYPE_ICONS[selected.type] ?? Lightbulb
                        const color = nodeTypeColor(selected.type, selected.confidence === 0)
                        return (
                          <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono-display text-[9px] uppercase tracking-[0.2em]" style={{ color, borderColor: `${color}55`, background: `${color}14` }}>
                            <Icon size={10} style={{ color }} /> {selected.type}
                          </span>
                        )
                      })()}
                      <h3 className="mt-2 text-lg font-medium text-white/95">{selected.label}</h3>
                      <div className="mt-2 space-y-0.5 font-mono text-[10.5px] text-white/40">
                        <div>{selected.verified ? 'verified (evidence-backed)' : `confidence ${selected.confidence.toFixed(2)} — ${selected.confidence === 0 ? 'rejected' : 'unverified hypothesis'}`}</div>
                        <div>first seen {timeAgo(selected.createdAt)} · last {timeAgo(selected.lastSeenAt)}</div>
                        {selected.sourceRecordId && <div>source: {map.sources.find((s: any) => s.id === selected.sourceRecordId)?.url?.slice(0, 40) ?? selected.sourceRecordId}</div>}
                      </div>
                      <div className="mb-2 mt-4 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Relationships ({graphRels.filter((r) => r.from === selected.id || r.to === selected.id).length})</div>
                      <div className="max-h-32 space-y-1 overflow-y-auto scrollbar-thin">
                        {graphRels.filter((r) => r.from === selected.id || r.to === selected.id).map((r) => {
                          const other = graphEntities.find((e) => e.id === (r.from === selected.id ? r.to : r.from))
                          return (
                            <div key={r.id} className="flex items-center gap-2 text-[12px] text-white/60">
                              <span>{r.label}</span>
                              <button type="button" onClick={() => setSelectedNode(other?.id ?? null)} className="cursor-pointer truncate text-white/85 underline decoration-white/20 underline-offset-2 hover:decoration-white/60">{other?.name ?? '?'}</button>
                            </div>
                          )
                        })}
                        {graphRels.filter((r) => r.from === selected.id || r.to === selected.id).length === 0 && <div className="text-xs text-white/35">None yet.</div>}
                      </div>
                      <div className="mt-5 flex flex-wrap gap-2">
                        <button type="button" onClick={() => void nodeEvent('source_rejected', selected.id)} className="cursor-pointer rounded-full border border-[#f0968a]/30 px-3.5 py-1.5 font-mono-display text-[10px] uppercase tracking-widest text-[#f0a096] transition-colors hover:bg-[#f0968a]/10" title="Wrong source/connection — downgraded and excluded">
                          Reject
                        </button>
                        <button type="button" onClick={() => void nodeEvent('memory_forgotten', selected.id)} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/15 px-3.5 py-1.5 font-mono-display text-[10px] uppercase tracking-widest text-white/60 transition-colors hover:border-white/30 hover:text-white" title="Remove from context + future training data">
                          <Trash2 size={10} /> Forget
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="text-sm leading-relaxed text-white/40">
                      Click a node to inspect it: what it is, how confident the system is, where it came from, and
                      what connects to it. Reject marks a node as wrong (excluded everywhere); Forget removes it
                      from context and any future dataset.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── LEARNING HISTORY ── */}
            {tab === 'history' && (
              <div className="space-y-2">
                {events.length === 0 ? (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center text-sm text-white/40">
                    No learning events yet — set a preference, teach the map a node, or correct an inference and it
                    will be audited here.
                  </div>
                ) : events.map((ev) => (
                  <div key={ev.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${
                          ev.signal === 'explicit' ? 'border-white/25 bg-white/[0.07] text-white/80' : 'border-white/10 text-white/40'
                        }`}>
                          {ev.signal}
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-widest text-white/45">{ev.type.replace(/_/g, ' ')}</span>
                        {ev.dimension && ev.value && <span className="text-[12.5px] text-white/70">{ev.dimension} → {ev.value}</span>}
                        {ev.nodeId && <span className="font-mono text-[10px] text-white/40">{ev.nodeId}</span>}
                      </div>
                      <div className="font-mono text-[10px] text-white/30">
                        {timeAgo(ev.provenance.createdAt)}{ev.provenance.modelId ? ` · via ${ev.provenance.modelId.slice(0, 30)}` : ''}
                      </div>
                    </div>
                    {ev.detail && <div className="mt-1.5 text-[12.5px] leading-relaxed text-white/55">{ev.detail}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* ── PROVIDER STATUS ── */}
            {tab === 'providers' && caps && (
              <div>
                <div className={`mb-4 flex items-center gap-2 rounded-xl border px-4 py-3 text-[12.5px] ${
                  caps.zeroCostMode ? 'border-emerald-400/25 bg-emerald-400/[0.06] text-white/90' : 'border-[#f0968a]/30 bg-[#f0968a]/[0.06] text-[#f0b0a6]'
                }`}>
                  <ShieldCheck size={14} className="shrink-0" />
                  {caps.zeroCostMode
                    ? 'Zero-cost mode is ON: routes that are not server-verified free are rejected — no paid fallback, ever. Quotas still apply: free tiers are limited, not unlimited.'
                    : 'Zero-cost mode is OFF (operator setting) — paid routes are not blocked.'}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {caps.providers.map((p) => (
                    <div key={p.providerId} className={`rounded-2xl border p-5 ${p.enabledInZeroCostMode && !p.requiresBillingMethod ? 'border-white/10 bg-white/[0.03]' : 'border-[#f0968a]/20 bg-[#f0968a]/[0.03]'}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-mono-display text-[12px] uppercase tracking-[0.2em] text-white/85">{p.providerId}</div>
                        {chip(p.enabledInZeroCostMode && !p.requiresBillingMethod ? 'free-route ok' : 'disabled', p.enabledInZeroCostMode && !p.requiresBillingMethod)}
                      </div>
                      <div className="mt-2 space-y-1 font-mono text-[10.5px] text-white/40">
                        <div>
                          {p.dailyRequestLimit ? `≤ ${p.dailyRequestLimit.toLocaleString()} req/day` : ''}
                          {p.dailyTokenLimit ? `≤ ${p.dailyTokenLimit.toLocaleString()} tokens/day` : ''}
                          {p.dailyNeuronLimit ? `≤ ${p.dailyNeuronLimit.toLocaleString()} neurons/day` : ''}
                          {!p.dailyRequestLimit && !p.dailyTokenLimit && !p.dailyNeuronLimit ? 'no recorded request quota' : ''}
                          {' · '}verified {p.lastVerifiedAt}
                        </div>
                        <div>{p.freeModels} free model(s){p.paidModels ? ` · ${p.paidModels} paid (blocked here)` : ''}</div>
                        {p.privacyClass === 'public' && (
                          <div className="text-[#f0d0a0]/70">free-tier data may be used to improve the provider's products — avoid sensitive research</div>
                        )}
                        {!p.productionEligibleOnFreeTier && p.enabledInZeroCostMode && (
                          <div className="text-white/35">research/dev use only — not production-eligible on the free tier</div>
                        )}
                        {p.requiresBillingMethod && (
                          <div className="text-[#f0a096]/70">requires a billing method — hard-disabled in zero-cost mode</div>
                        )}
                      </div>
                      <a href={p.evidenceUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 font-mono text-[10px] text-white/45 underline decoration-white/20 underline-offset-2 transition-colors hover:text-white">
                        evidence <ExternalLink size={9} />
                      </a>
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-xl border border-white/[0.07] bg-black/25 px-4 py-3 text-[12px] leading-relaxed text-white/40">
                  "Free" here means a documented free tier at the linked evidence URL, re-checked when terms change —
                  never unlimited, never guaranteed uptime, and never a promise that model weights changed. LoRA
                  adapters, where they eventually exist, are separate files with their own compatibility gate.
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  )
}
