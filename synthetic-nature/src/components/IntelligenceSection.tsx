/**
 * IntelligenceSection.tsx — the ENZO Intelligence workspace tab.
 *
 * Flow: list of saved investigations → create (plain-English objective, scope,
 * source toggles, seed URLs, user documents) → detail workspace with six
 * connected views over the SAME data: Brief (objective + research questions),
 * Graph (entity/relationship map), Evidence (the source-linked claim ledger),
 * Runs (timeline + what changed vs the previous run), Report (clickable [E#]
 * citations), Analyst (Q&A answered from the ledger only).
 *
 * Runs stream over SSE (`phase`/`step`/`done`/`error`) with the same fetch+
 * reader contract as the agent run chat. The run continues server-side if
 * this tab closes — a returning user just re-opens the investigation.
 *
 * Auth follows the vault pattern: mintVaultToken() → x-vault-token, provider
 * keys sent per-request only, device id (x-enzo-owner) for ownership.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Plus, Play, Square, Trash2, RotateCw, Download, ExternalLink,
  ChevronDown, Loader2, FileText, Network, History, MessageSquare,
  ListChecks, AlertTriangle, Pencil,
} from 'lucide-react'
import { mintVaultToken } from '../lib/vaultToken'
import { getProviderKeys } from '../lib/keyStore'
import { getEnzoOwnerId } from '../lib/enzoOwner'
import IntelligenceGraph, { type GraphEntity, type GraphRelationship } from './IntelligenceGraph'
import NeuralMapGraphCanvas from './NeuralMapGraphCanvas'
import EntityExplainModal from './EntityExplainModal'
import { ReportBody } from './IntelligenceMarkdown'
import ErrorBoundary from './ErrorBoundary'

// ── Types (mirror the backend's src/intelligence/types.ts) ───────────────────

type ClaimStatus = 'supported' | 'unverified' | 'disputed'
type RunPhase = 'planning' | 'discovering' | 'extracting' | 'resolving' | 'verifying' | 'reporting' | 'done' | 'error' | 'cancelled'

interface Brief {
  objective: string
  scope: string
  connectors: { webSearch: boolean; websites: boolean; github: boolean; wikipedia: boolean; documents: boolean }
  seedUrls: string[]
  limits: { maxSearches: number; maxPages: number; maxLlmCalls: number; timeBudgetMs: number }
}

interface Evidence {
  id: string; runId: string; url: string; host: string; connector: string
  claim: string; quote: string; quoteVerified: boolean
  subject: string; entities: string[]
  retrievedAt: number; sourceDate?: string; status: ClaimStatus; note?: string
}

interface Entity {
  id: string; name: string; aliases: string[]; kind: string
  summary?: string; evidenceIds: string[]
}

interface Relationship {
  id: string; from: string; to: string; label: string
  status: 'supported' | 'hypothesis' | 'disputed'; evidenceIds: string[]
}

interface Discrepancy {
  id: string; topic: string
  a: { claimId: string; says: string }; b: { claimId: string; says: string }
  explanation: string; howToResolve: string
}

interface SourceDoc {
  id: string; url: string; title: string; host: string; connector: string
  fetchedAt: number; contentHash: string; text: string; ok: boolean; error?: string
}

interface RunChanges {
  newEvidence: number
  missingSources: Array<{ url: string; note: string }>
  changedSources: Array<{ url: string; note: string }>
  summary: string
}

interface Run {
  id: string; n: number; startedAt: number; finishedAt?: number; phase: RunPhase
  steps: string[]; questions: string[]
  sources: SourceDoc[]; evidenceIds: string[]
  entities: Entity[]; relationships: Relationship[]
  discrepancies: Discrepancy[]; openQuestions: string[]
  report: string; changes?: RunChanges
  stats: { searches: number; pages: number; llmCalls: number; wallMs: number }
  error?: string
}

interface Investigation {
  id: string; name: string; brief: Brief
  documents: Array<{ name: string; text: string }>
  questions: string[]; evidence: Evidence[]; runs: Run[]
  createdAt: number; updatedAt: number
}

interface IndexItem {
  id: string; name: string; objective: string; evidenceCount: number
  createdAt: number; updatedAt: number
  runs: Array<{ id: string; n: number; phase: RunPhase; startedAt: number; finishedAt?: number }>
}

// ── API helpers (vault pattern; device id binds ownership) ───────────────────

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

const STATUS_STYLE: Record<ClaimStatus, { dot: string; label: string }> = {
  supported: { dot: 'bg-emerald-400/80', label: 'supported' },
  unverified: { dot: 'bg-white/30', label: 'unverified' },
  disputed: { dot: 'bg-[#f0968a]', label: 'disputed' },
}

const PHASE_LABELS: Record<RunPhase, string> = {
  planning: 'Planning', discovering: 'Discovering sources', extracting: 'Extracting claims',
  resolving: 'Resolving entities', verifying: 'Verifying', reporting: 'Writing report',
  done: 'Done', error: 'Failed', cancelled: 'Cancelled',
}

// ── Report renderer (hand-rolled markdown-ish, like TerminalSection) ─────────
// The renderer itself lives in IntelligenceMarkdown.tsx — the node explainer
// overlay renders model prose with the same citation chips.

// ── Create / edit form ───────────────────────────────────────────────────────

interface FormPayload {
  name?: string
  objective: string
  scope: string
  connectors: Brief['connectors']
  seedUrls: string[]
  documents: Array<{ name: string; text: string }>
  limits?: Partial<Brief['limits']>
}

function InvestigationForm({
  initial, submitLabel, onSubmit, onCancel, busy, error,
}: {
  initial?: Investigation | null
  submitLabel: string
  onSubmit: (p: FormPayload) => void
  onCancel?: () => void
  busy?: boolean
  error?: string
}) {
  const [objective, setObjective] = useState(initial?.brief.objective ?? '')
  const [name, setName] = useState(initial && initial.name !== initial.brief.objective.slice(0, 60).replace(/\s+\S*$/, '') ? initial.name : '')
  const [scope, setScope] = useState(initial?.brief.scope ?? '')
  const [seedUrls, setSeedUrls] = useState((initial?.brief.seedUrls ?? []).join('\n'))
  const [connectors, setConnectors] = useState<Brief['connectors']>(
    initial?.brief.connectors ?? { webSearch: true, websites: true, github: false, wikipedia: false, documents: false },
  )
  const [documents, setDocuments] = useState<Array<{ name: string; text: string }>>(initial?.documents ?? [])
  const [docName, setDocName] = useState('')
  const [docText, setDocText] = useState('')
  const [limits, setLimits] = useState(initial?.brief.limits ?? { maxSearches: 8, maxPages: 10, maxLlmCalls: 24, timeBudgetMs: 240_000 })

  const toggle = (k: keyof Brief['connectors']) => setConnectors((c) => ({ ...c, [k]: !c[k] }))

  const addDocFromFile = async (file: File) => {
    if (file.size > 200_000) return
    const text = await file.text()
    setDocuments((d) => [...d, { name: file.name.slice(0, 120), text: text.slice(0, 20_000) }].slice(0, 5))
  }

  const submit = () => {
    if (!objective.trim()) return
    onSubmit({
      ...(name.trim() ? { name: name.trim() } : {}),
      objective: objective.trim(),
      scope: scope.trim(),
      connectors,
      seedUrls: seedUrls.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8),
      documents,
      limits,
    })
  }

  const chip = (label: string, k: keyof Brief['connectors'], hint: string) => (
    <button
      key={k}
      type="button"
      onClick={() => toggle(k)}
      title={hint}
      className={`rounded-full border px-3 py-1.5 font-mono-display text-[10px] uppercase tracking-[0.15em] transition-all ${
        connectors[k]
          ? 'border-white/40 bg-white/12 text-white'
          : 'border-white/10 text-white/60 hover:border-white/25 hover:text-white/70'
      }`}
    >
      {label}
    </button>
  )

  const inputCls = 'w-full rounded-xl border border-white/15 bg-black/30 px-4 py-2.5 text-sm text-white placeholder-white/25 outline-none transition-colors focus:border-white/30'
  const labelCls = 'mb-1.5 block font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45'

  return (
    <div className="space-y-5">
      <div>
        <label className={labelCls}>Objective — what should this investigation establish?</label>
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={3}
          placeholder="e.g. Investigate NovaGrid AI using public sources: map its corporate identity, products, repositories and credible reporting; verify its major public claims."
          className={`${inputCls} resize-none leading-relaxed`}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Name (optional)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="NovaGrid AI" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Scope & constraints (optional)</label>
          <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Public sources only; last 24 months" className={inputCls} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Sources</label>
        <div className="flex flex-wrap gap-2">
          {chip('Web search', 'webSearch', 'Search engines discover candidate pages')}
          {chip('Websites', 'websites', 'Fetch pages directly (seed URLs + one hop into their links)')}
          {chip('GitHub', 'github', 'Public repository metadata, releases and READMEs')}
          {chip('Wikipedia', 'wikipedia', 'Encyclopedic grounding for the objective')}
          {documents.length > 0 && chip('Documents', 'documents', 'Your own pasted/uploaded documents')}
        </div>
      </div>
      <div>
        <label className={labelCls}>Seed URLs (one per line — official site, repo, filing…)</label>
        <textarea value={seedUrls} onChange={(e) => setSeedUrls(e.target.value)} rows={2} placeholder="https://example.com" className={`${inputCls} resize-none font-mono text-xs`} />
      </div>
      <div>
        <label className={labelCls}>Your documents (optional — up to 5, treated as first-class sources)</label>
        {documents.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {documents.map((d, i) => (
              <span key={i} className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-3 py-1 text-xs text-white/70">
                <FileText size={11} className="text-white/40" />
                {d.name}
                <button type="button" onClick={() => setDocuments((ds) => ds.filter((_, j) => j !== i))} className="cursor-pointer text-white/60 hover:text-white">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        {documents.length < 5 && (
          <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
            <div className="flex items-center gap-2">
              <input value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="Document name" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-white placeholder-white/25 outline-none focus:border-white/25" />
              <label className="cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 font-mono-display text-[10px] uppercase tracking-widest text-white/60 transition-colors hover:border-white/30 hover:text-white">
                Upload .txt
                <input type="file" accept=".txt,.md,.csv,.json,text/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) addDocFromFile(f); e.target.value = '' }} />
              </label>
            </div>
            <textarea value={docText} onChange={(e) => setDocText(e.target.value)} rows={2} placeholder="…or paste the document text here" className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-white placeholder-white/25 outline-none focus:border-white/25" />
            <button
              type="button"
              disabled={!docText.trim()}
              onClick={() => { setDocuments((d) => [...d, { name: docName.trim() || `document-${d.length + 1}`, text: docText.trim().slice(0, 20_000) }]); setDocName(''); setDocText('') }}
              className="cursor-pointer rounded-lg border border-white/15 px-3 py-1 font-mono-display text-[10px] uppercase tracking-widest text-white/60 transition-all enabled:hover:border-white/30 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              + Add document
            </button>
          </div>
        )}
      </div>
      <details className="group">
        <summary className="cursor-pointer list-none font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/60 transition-colors hover:text-white">
          ▸ Run budgets (advanced)
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {([
            ['Searches', 'maxSearches', 0, 20],
            ['Pages', 'maxPages', 1, 30],
            ['LLM calls', 'maxLlmCalls', 4, 60],
            ['Minutes', 'minutes', 1, 10],
          ] as const).map(([label, key, min, max]) => (
            <div key={key}>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-white/60">{label}</label>
              <input
                type="number" min={min} max={max}
                value={key === 'minutes' ? Math.round(limits.timeBudgetMs / 60_000) : limits[key as 'maxSearches' | 'maxPages' | 'maxLlmCalls']}
                onChange={(e) => {
                  const v = Math.max(min, Math.min(max, Number(e.target.value) || min))
                  setLimits((l) => (key === 'minutes' ? { ...l, timeBudgetMs: v * 60_000 } : { ...l, [key]: v }))
                }}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-xs text-white outline-none focus:border-white/25"
              />
            </div>
          ))}
        </div>
      </details>
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-[#f0968a]/30 bg-[#f0968a]/[0.07] px-4 py-2.5 text-[13px] text-[#f0b0a6]">
          <AlertTriangle size={14} className="shrink-0" /> {error}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !objective.trim()}
          className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-white px-6 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-black transition-all hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="cursor-pointer rounded-full border border-white/15 px-5 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-white/55 transition-colors hover:border-white/30 hover:text-white">
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

type DetailTab = 'brief' | 'graph' | 'evidence' | 'runs' | 'report' | 'analyst'

const TABS: Array<{ key: DetailTab; label: string; icon: React.ComponentType<{ size?: number | string }> }> = [
  { key: 'brief', label: 'Brief', icon: ListChecks },
  { key: 'graph', label: 'Graph', icon: Network },
  { key: 'evidence', label: 'Evidence', icon: FileText },
  { key: 'runs', label: 'Runs', icon: History },
  { key: 'report', label: 'Report', icon: FileText },
  { key: 'analyst', label: 'Analyst', icon: MessageSquare },
]

export default function IntelligenceSection() {
  const [view, setView] = useState<'list' | 'create' | 'detail'>('list')
  const [list, setList] = useState<IndexItem[]>([])
  const [inv, setInv] = useState<Investigation | null>(null)
  const [loading, setLoading] = useState(true)
  const [opError, setOpError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<DetailTab>('brief')
  const [live, setLive] = useState<{ phase: RunPhase; steps: string[] } | null>(null)
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null)
  /** The node the explainer overlay is open for (null = closed). */
  const [explainEntityId, setExplainEntityId] = useState<string | null>(null)
  const [highlightEv, setHighlightEv] = useState<string | null>(null)
  const [evFilter, setEvFilter] = useState('')
  const [evStatus, setEvStatus] = useState<ClaimStatus | 'all'>('all')
  const [graph3d, setGraph3d] = useState(true)
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const [reportRunId, setReportRunId] = useState<string | null>(null)
  const [analystQ, setAnalystQ] = useState('')
  const [analystBusy, setAnalystBusy] = useState(false)
  const [transcript, setTranscript] = useState<Array<{ q: string; a: string; error?: string }>>([])
  const [editing, setEditing] = useState(false)
  const runAbort = useRef<AbortController | null>(null)
  const liveRef = useRef<HTMLDivElement | null>(null)

  const loadList = useCallback(async () => {
    setLoading(true)
    const r = await api('/api/intelligence/investigations')
    if (r.ok) setList(r.json?.investigations ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  // A lost SSE stream (tab switch, dropped connection) leaves `live` set while
  // the run has finished server-side — the header would be stuck on "Stop"
  // forever. A terminal run phase on the persisted record means the stream is
  // gone; recover (the `done` event normally handles this when the stream
  // survives).
  useEffect(() => {
    if (!live || !inv) return
    const last = inv.runs[inv.runs.length - 1]
    if (last && last.finishedAt && ['done', 'error', 'cancelled'].includes(last.phase)) setLive(null)
  }, [inv])

  const openDetail = async (id: string) => {
    setOpError('')
    setLive(null)
    const r = await api(`/api/intelligence/investigations/${id}`)
    if (r.ok && r.json?.investigation) {
      setInv(r.json.investigation)
      setView('detail')
      setTab('brief')
      setTranscript([])
      setSelectedEntity(null)
      setHighlightEv(null)
    } else {
      setOpError(r.json?.message || `Could not open the investigation (HTTP ${r.status})`)
    }
  }

  // ── Run (SSE) — same fetch+reader contract as the agent run chat ──
  const startRun = async (planOnly: boolean) => {
    if (!inv) return
    setOpError('')
    setLive({ phase: 'planning', steps: [] })
    const controller = new AbortController()
    runAbort.current = controller
    try {
      const token = await mintVaultToken()
      const keys = getProviderKeys()
      const res = await fetch(`/api/intelligence/investigations/${inv.id}/run`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-enzo-owner': getEnzoOwnerId(),
          ...(token ? { 'x-vault-token': token } : {}),
          ...(keys.groq ? { 'x-groq-key': keys.groq } : {}),
          ...(keys.exa ? { 'x-exa-key': keys.exa } : {}),
        },
        body: JSON.stringify({ planOnly, providerKeys: keys, limits: inv.brief.limits }),
      })
      if (!res.ok || !res.body) {
        let msg = `HTTP ${res.status}`
        try { const j = await res.json(); msg = j?.message || j?.error || msg } catch { /* */ }
        if (msg === 'no_groq_key') msg = 'A Groq key is required to run an investigation — add it in the Vault first.'
        throw new Error(msg)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() || ''
        for (const frame of frames) {
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          if (!data) continue
          try {
            const payload = JSON.parse(data)
            if (event === 'phase') setLive((l) => (l ? { ...l, phase: payload.phase } : l))
            else if (event === 'step') setLive((l) => (l ? { ...l, steps: [...l.steps, String(payload.text)].slice(-40) } : l))
            else if (event === 'done') {
              if (payload.investigation) setInv(payload.investigation)
              setLive(null)
            } else if (event === 'error') {
              setOpError(String(payload.text ?? 'Run failed'))
              setLive(null)
              void refreshAfterFailure(inv.id)
            }
          } catch { /* partial frame */ }
        }
      }
      // Stream closed: fetch the final state (covers server-side completion
      // after a client disconnect + reconnect).
      const r2 = await api(`/api/intelligence/investigations/${inv.id}`)
      if (r2.ok && r2.json?.investigation) setInv(r2.json.investigation)
      setLive(null)
    } catch (err: any) {
      if (String(err?.name) !== 'AbortError') setOpError(String(err?.message ?? err).slice(0, 300))
      setLive(null)
    } finally {
      runAbort.current = null
    }
  }

  const refreshAfterFailure = async (id: string) => {
    const r = await api(`/api/intelligence/investigations/${id}`)
    if (r.ok && r.json?.investigation) setInv(r.json.investigation)
  }

  const cancelRun = async () => {
    if (!inv) return
    await api(`/api/intelligence/investigations/${inv.id}/cancel`, { method: 'POST', body: {} })
    runAbort.current?.abort()
  }

  const deleteInv = async () => {
    if (!inv) return
    const r = await api(`/api/intelligence/investigations/${inv.id}`, { method: 'DELETE' })
    if (r.ok) { setInv(null); setView('list'); void loadList() }
  }

  const askAnalyst = async () => {
    if (!inv || !analystQ.trim() || analystBusy) return
    const q = analystQ.trim()
    setAnalystQ('')
    setTranscript((t) => [...t, { q, a: '' }])
    setAnalystBusy(true)
    const r = await api(`/api/intelligence/investigations/${inv.id}/analyst`, { method: 'POST', body: { question: q } })
    setAnalystBusy(false)
    setTranscript((t) => {
      const next = [...t]
      const last = next[next.length - 1]
      if (last && last.q === q) {
        last.a = r.ok ? String(r.json?.answer ?? '') : ''
        if (!r.ok) last.error = r.json?.message || `HTTP ${r.status}`
      }
      return next
    })
  }

  const jumpToEvidence = useCallback((evId: string) => {
    setTab('evidence')
    setEvFilter('')
    setEvStatus('all')
    setHighlightEv(evId)
    window.setTimeout(() => {
      document.getElementById(`ev-${evId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      window.setTimeout(() => setHighlightEv((h) => (h === evId ? null : h)), 2400)
    }, 120)
  }, [])

  const jumpToUrl = useCallback((url: string) => {
    setTab('evidence')
    setEvFilter(url)
  }, [])

  /** Ask the backend to explain a node — or to answer a doubt about it.
   *  The browser's provider key travels per request (BYOK), exactly like the
   *  run path, so the explainer works without a server-side key too. */
  const askEntity = useCallback(async (entityId: string, question?: string) => {
    if (!inv) return { error: 'No investigation is open.' }
    const token = await mintVaultToken()
    const keys = getProviderKeys()
    const res = await fetch(`/api/intelligence/investigations/${inv.id}/explain`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-enzo-owner': getEnzoOwnerId(),
        ...(token ? { 'x-vault-token': token } : {}),
        ...(keys.groq ? { 'x-groq-key': keys.groq } : {}),
      },
      body: JSON.stringify({ entityId, ...(question ? { question } : {}) }),
    })
    let json: any = null
    try { json = await res.json() } catch { /* empty body */ }
    if (!res.ok) return { error: json?.message || json?.error || `HTTP ${res.status}` }
    return {
      explanation: json?.explanation,
      answer: json?.answer,
      evidenceIds: json?.evidenceIds,
      entity: json?.entity,
    }
  }, [inv])

  /** Open the node explainer over the graph (a clean click on a node). */
  const openExplainer = useCallback((entityId: string) => {
    setSelectedEntity(entityId)
    setExplainEntityId(entityId)
  }, [])

  const latestRun = useMemo(() => (inv && inv.runs.length ? inv.runs[inv.runs.length - 1] : null), [inv])
  /** The GRAPH comes from the latest run that actually has entities — a
   *  plan-only run (phase "planning") carries questions but no graph, and
   *  using it would blank the graph tab of an investigation that already has
   *  one. */
  const graphRun = useMemo(() => {
    if (!inv) return null
    for (let i = inv.runs.length - 1; i >= 0; i--) {
      if (inv.runs[i].entities?.length) return inv.runs[i]
    }
    return latestRun
  }, [inv, latestRun])
  const evidenceWithRun = useMemo(() => {
    if (!inv) return []
    const runNo = new Map(inv.runs.map((r) => [r.id, r.n]))
    return inv.evidence.map((e) => ({ ...e, runN: runNo.get(e.runId) ?? 0 }))
  }, [inv])
  const filteredEvidence = useMemo(() => {
    const f = evFilter.trim().toLowerCase()
    return evidenceWithRun.filter((e) => {
      if (evStatus !== 'all' && e.status !== evStatus) return false
      if (!f) return true
      return e.claim.toLowerCase().includes(f) || e.quote.toLowerCase().includes(f)
        || e.host.toLowerCase().includes(f) || e.url.toLowerCase().includes(f) || e.id.toLowerCase() === f
    })
  }, [evidenceWithRun, evFilter, evStatus])

  const graphEntities: GraphEntity[] = useMemo(() => (graphRun?.entities ?? []).map((e) => ({
    ...e,
    disputed: e.evidenceIds.some((id) => inv?.evidence.find((x) => x.id === id)?.status === 'disputed'),
  })), [graphRun, inv])
  const graphRels: GraphRelationship[] = graphRun?.relationships ?? []
  /** The node the explainer shows: its identity plus the evidence rows it is
   *  grounded in (the ledger rows the model's citations point at). */
  const explainTarget = useMemo(() => {
    if (!explainEntityId || !inv) return null
    const ent = graphEntities.find((e) => e.id === explainEntityId)
    if (!ent) return null
    const evidence = ent.evidenceIds
      .map((id) => inv.evidence.find((x) => x.id === id))
      .filter((x): x is Evidence => !!x)
      .map((x) => ({
        id: x.id, claim: x.claim, quote: x.quote, quoteVerified: x.quoteVerified,
        host: x.host, url: x.url, status: x.status, sourceDate: x.sourceDate,
      }))
    return {
      entity: { id: ent.id, name: ent.name, kind: ent.kind, summary: ent.summary, aliases: ent.aliases },
      evidence,
    }
  }, [explainEntityId, graphEntities, inv])
  const selected = graphEntities.find((e) => e.id === selectedEntity) ?? null
  // reagraph (WebGL) node/edge mapping for the 3D view
  const mapNodes = useMemo(() => graphEntities.map((e) => ({
    id: e.id, label: e.name, type: e.kind, rejected: e.disputed,
  })), [graphEntities])
  const mapEdges = useMemo(() => graphRels.map((r) => ({
    id: r.id, source: r.from, target: r.to, label: r.label,
  })), [graphRels])

  // ── List view ──────────────────────────────────────────────────────────────
  if (view === 'list') {
    return (
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            <div className="font-mono-display text-[10px] uppercase tracking-[0.3em] text-white/55">Workspace · ENZO Intelligence</div>
            <h2 className="mt-2 font-garamond text-3xl text-white/95">Investigate once. Keep knowing.</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/45">
              Evidence-backed investigations over public sources: every claim carries its source and retrieval time,
              the graph connects what the evidence supports, and each re-run shows you what changed.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setOpError(''); setView('create') }}
            className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full bg-white px-5 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-black transition-all hover:bg-white/85"
          >
            <Plus size={14} /> New investigation
          </button>
        </header>

        {opError && (
          <div className="mb-5 flex items-center gap-2 rounded-xl border border-[#f0968a]/30 bg-[#f0968a]/[0.07] px-4 py-2.5 text-[13px] text-[#f0b0a6]">
            <AlertTriangle size={14} className="shrink-0" /> {opError}
          </div>
        )}

        {loading ? (
          <div className="grid h-40 place-items-center font-mono-display text-[10px] uppercase tracking-widest text-white/60">Loading investigations…</div>
        ) : list.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border border-white/15 text-white/50"><FileText size={20} /></div>
            <div className="text-sm text-white/60">No investigations yet.</div>
            <div className="mt-1 text-xs text-white/60">Describe what you want to know — ENZO plans the questions, gathers public sources, and keeps the evidence.</div>
          </div>
        ) : (
          <div className="grid gap-3">
            {list.map((item) => {
              const last = item.runs[item.runs.length - 1]
              return (
                <motion.button
                  key={item.id}
                  type="button"
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  onClick={() => void openDetail(item.id)}
                  className="group cursor-pointer rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-left transition-all hover:border-white/25 hover:bg-white/[0.05]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-medium text-white/90 group-hover:text-white">{item.name}</div>
                      <div className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-white/45">{item.objective}</div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {last && (
                        <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ${
                          last.phase === 'done' ? 'border-white/25 bg-white/[0.07] text-white/90'
                            : last.phase === 'error' ? 'border-[#f0968a]/30 bg-[#f0968a]/[0.08] text-[#f0b0a6]'
                              : 'border-white/15 bg-white/[0.05] text-white/50'
                        }`}>
                          {PHASE_LABELS[last.phase] ?? last.phase}
                        </span>
                      )}
                      <span className="font-mono text-[10px] uppercase tracking-widest text-white/60">
                        {item.evidenceCount} claims · {item.runs.length} run{item.runs.length === 1 ? '' : 's'} · {timeAgo(item.updatedAt)}
                      </span>
                    </div>
                  </div>
                </motion.button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // ── Create view ────────────────────────────────────────────────────────────
  if (view === 'create') {
    return (
      <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <button type="button" onClick={() => { setView('list'); setOpError('') }} className="mb-4 cursor-pointer font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/60 transition-colors hover:text-white">← Investigations</button>
          <div className="font-mono-display text-[10px] uppercase tracking-[0.3em] text-white/55">New investigation</div>
          <h2 className="mt-2 font-garamond text-3xl text-white/95">Say what you want to know.</h2>
          <p className="mt-2 text-sm leading-relaxed text-white/45">
            ENZO turns the objective into research questions, gathers public sources, extracts claims with their
            evidence, and builds a graph you can re-run later. You can review the plan before the full run.
          </p>
        </header>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
          <InvestigationForm
            submitLabel="Create investigation"
            busy={busy}
            error={opError}
            onSubmit={async (p) => {
              setBusy(true)
              setOpError('')
              const r = await api('/api/intelligence/investigations', { method: 'POST', body: p })
              setBusy(false)
              if (r.ok && r.json?.investigation) {
                setInv(r.json.investigation)
                setView('detail')
                setTab('brief')
                void loadList()
              } else {
                setOpError(r.json?.message || `Create failed (HTTP ${r.status})`)
              }
            }}
            onCancel={() => { setView('list'); setOpError('') }}
          />
        </div>
      </div>
    )
  }

  // ── Detail view ────────────────────────────────────────────────────────────
  if (!inv) return null
  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <button type="button" onClick={() => { setInv(null); setView('list'); setLive(null); void loadList() }} className="mb-4 cursor-pointer font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/60 transition-colors hover:text-white">← Investigations</button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="font-mono-display text-[10px] uppercase tracking-[0.3em] text-white/55">Investigation · {inv.id}</div>
            <h2 className="mt-1.5 truncate font-garamond text-3xl text-white/95">{inv.name}</h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-white/45">{inv.brief.objective}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {live ? (
              <button type="button" onClick={() => void cancelRun()} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[#f0968a]/40 bg-[#f0968a]/10 px-5 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-[#f0b0a6] transition-colors hover:bg-[#f0968a]/20">
                <Square size={13} /> Stop
              </button>
            ) : (
              <>
                <button type="button" onClick={() => void startRun(true)} disabled={busy} title="Generate/refresh the research questions without running the full pipeline" className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/15 px-5 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-white/70 transition-colors hover:border-white/30 hover:text-white disabled:opacity-40">
                  <ListChecks size={13} /> Plan
                </button>
                <button type="button" onClick={() => void startRun(false)} title={inv.runs.length ? 'Re-run: refresh sources and diff against the previous run' : 'Run the full pipeline'} className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-white px-5 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-black transition-all hover:bg-white/85">
                  {inv.runs.length ? <RotateCw size={13} /> : <Play size={13} />}
                  {inv.runs.length ? 'Re-run' : 'Run'}
                </button>
                <button type="button" onClick={() => setEditing((e) => !e)} title="Edit the brief" className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/15 px-4 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-white/70 transition-colors hover:border-white/30 hover:text-white">
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => { if (window.confirm(`Delete "${inv.name}" and all of its evidence?`)) void deleteInv() }}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/15 px-4 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-white/50 transition-colors hover:border-[#f0968a]/40 hover:text-[#f0b0a6]"
                >
                  <Trash2 size={13} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Live run progress */}
        <AnimatePresence>
          {live && (
            <motion.div
              ref={liveRef}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/40"
            >
              <div className="flex items-center gap-3 border-b border-white/[0.07] bg-white/[0.03] px-4 py-2.5">
                <Loader2 size={13} className="animate-spin text-white/60" />
                <span className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/70">{PHASE_LABELS[live.phase] ?? live.phase}</span>
                <span className="ml-auto font-mono text-[10px] text-white/60">{live.steps.length} steps</span>
              </div>
              <div className="max-h-44 overflow-y-auto scrollbar-thin px-4 py-3 font-mono text-[11px] leading-relaxed text-white/50">
                {live.steps.map((s, i) => <div key={i} className="whitespace-pre-wrap">{s}</div>)}
                {live.steps.length === 0 && <div className="text-white/60">working…</div>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {opError && !live && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-[#f0968a]/30 bg-[#f0968a]/[0.07] px-4 py-2.5 text-[13px] text-[#f0b0a6]">
            <AlertTriangle size={14} className="shrink-0" /> {opError}
          </div>
        )}
      </header>

      {/* Edit brief inline */}
      <AnimatePresence>
        {editing && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-6 overflow-hidden">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
              <div className="mb-4 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Edit brief</div>
              <InvestigationForm
                initial={inv}
                submitLabel="Save brief"
                busy={busy}
                error={opError}
                onSubmit={async (p) => {
                  setBusy(true)
                  const r = await api(`/api/intelligence/investigations/${inv.id}`, { method: 'PATCH', body: p })
                  setBusy(false)
                  if (r.ok && r.json?.investigation) { setInv(r.json.investigation); setEditing(false) }
                  else setOpError(r.json?.message || `Save failed (HTTP ${r.status})`)
                }}
                onCancel={() => setEditing(false)}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tabs */}
      <div className="mb-5 flex flex-wrap gap-1.5 border-b border-white/[0.07] pb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-4 py-1.5 font-mono-display text-[10px] uppercase tracking-[0.2em] transition-all ${
              tab === t.key ? 'bg-white/12 text-white' : 'text-white/50 hover:bg-white/[0.06] hover:text-white/80'
            }`}
          >
            <t.icon size={11} />
            {t.label}
            {t.key === 'evidence' && inv.evidence.length > 0 && <span className="ml-0.5 font-mono text-[9px] text-white/60">{inv.evidence.length}</span>}
            {t.key === 'runs' && inv.runs.length > 0 && <span className="ml-0.5 font-mono text-[9px] text-white/60">{inv.runs.length}</span>}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
          {/* ── BRIEF ── */}
          {tab === 'brief' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <div className="mb-3 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Objective</div>
                <p className="text-[13px] leading-relaxed text-white/75">{inv.brief.objective}</p>
                {inv.brief.scope && (
                  <>
                    <div className="mb-2 mt-5 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Scope</div>
                    <p className="text-[13px] leading-relaxed text-white/60">{inv.brief.scope}</p>
                  </>
                )}
                <div className="mb-2 mt-5 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Sources</div>
                <div className="flex flex-wrap gap-1.5">
                  {([['Web search', inv.brief.connectors.webSearch], ['Websites', inv.brief.connectors.websites], ['GitHub', inv.brief.connectors.github], ['Wikipedia', inv.brief.connectors.wikipedia], ['Documents', inv.brief.connectors.documents]] as const).map(([label, on]) => (
                    <span key={label} className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] ${on ? 'border-white/25 bg-white/[0.07] text-white/80' : 'border-white/[0.07] text-white/60 line-through'}`}>{label}</span>
                  ))}
                </div>
                {inv.brief.seedUrls.length > 0 && (
                  <>
                    <div className="mb-2 mt-5 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Seed URLs</div>
                    <div className="space-y-1">
                      {inv.brief.seedUrls.map((u) => (
                        <a key={u} href={u} target="_blank" rel="noreferrer" className="block truncate font-mono text-[11px] text-white/50 transition-colors hover:text-white/85">{u}</a>
                      ))}
                    </div>
                  </>
                )}
                {inv.documents.length > 0 && (
                  <>
                    <div className="mb-2 mt-5 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Your documents</div>
                    <div className="flex flex-wrap gap-1.5">
                      {inv.documents.map((d, i) => <span key={i} className="rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-0.5 font-mono text-[10px] text-white/60">{d.name}</span>)}
                    </div>
                  </>
                )}
                <div className="mb-2 mt-5 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Run budgets</div>
                <div className="font-mono text-[11px] text-white/60">
                  {inv.brief.limits.maxSearches} searches · {inv.brief.limits.maxPages} pages · {inv.brief.limits.maxLlmCalls} LLM calls · {Math.round(inv.brief.limits.timeBudgetMs / 60_000)} min
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <div className="mb-3 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Research questions</div>
                {inv.questions.length ? (
                  <ol className="space-y-2.5">
                    {inv.questions.map((q, i) => (
                      <li key={i} className="flex gap-3 text-[13px] leading-relaxed text-white/75">
                        <span className="mt-0.5 font-mono text-[10px] text-white/60">{String(i + 1).padStart(2, '0')}</span>
                        {q}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="text-sm text-white/60">
                    No plan yet — run planning to generate the research questions, review them here, then run the investigation.
                  </div>
                )}
                {/* Dedicated actions in-panel — the header pills are easy to
                    miss and the Brief copy used to tell the user to RUN
                    without a button anywhere in the panel. */}
                {!live && (
                  <div className="mt-5 border-t border-white/[0.07] pt-4">
                    {inv.questions.length ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void startRun(false)}
                          className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-white px-5 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-black transition-all hover:bg-white/85"
                        >
                          <Play size={13} /> Run investigation
                        </button>
                        <div className="mt-2 text-[12px] text-white/60">Full pipeline: sources → claims → graph → report → diff vs previous run.</div>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void startRun(true)}
                          disabled={busy}
                          className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/15 px-5 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-white/70 transition-colors hover:border-white/30 hover:text-white disabled:opacity-40"
                        >
                          <ListChecks size={13} /> Run planning
                        </button>
                        <div className="mt-2 text-[12px] text-white/60">Generates the research questions only — nothing is fetched yet.</div>
                      </>
                    )}
                  </div>
                )}
                {latestRun?.stats && inv.runs.length > 0 && (
                  <div className="mt-6 border-t border-white/[0.07] pt-4">
                    <div className="mb-2 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Latest run (#{latestRun.n})</div>
                    <div className="font-mono text-[11px] text-white/60">
                      {latestRun.stats.pages} pages · {latestRun.stats.searches} searches · {latestRun.stats.llmCalls} LLM calls · {Math.round(latestRun.stats.wallMs / 1000)}s · {inv.evidence.length} claims in ledger
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── GRAPH ── */}
          {tab === 'graph' && (
            <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  {([['2D', false], ['3D', true]] as const).map(([label, v]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setGraph3d(v)}
                      className={`cursor-pointer rounded-full border px-3 py-1 font-mono-display text-[10px] uppercase tracking-[0.2em] transition-all ${
                        graph3d === v ? 'border-white/40 bg-white/12 text-white' : 'border-white/10 text-white/60 hover:border-white/25 hover:text-white/70'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="ml-auto font-mono text-[9px] uppercase tracking-widest text-white/60">
                    {graphEntities.length} nodes · {graphRels.length} edges
                  </span>
                </div>
                {graph3d ? (
                  graphEntities.length === 0 ? (
                    <IntelligenceGraph entities={graphEntities} relationships={graphRels} selectedId={selectedEntity} onSelect={setSelectedEntity} onActivate={openExplainer} />
                  ) : (
                    // If WebGL is unavailable the 3D canvas throws — fall back to
                    // the 2D SVG graph instead of taking the tab down.
                    <ErrorBoundary fallback={<IntelligenceGraph entities={graphEntities} relationships={graphRels} selectedId={selectedEntity} onSelect={setSelectedEntity} onActivate={openExplainer} />}>
                      <NeuralMapGraphCanvas nodes={mapNodes} edges={mapEdges} selectedId={selectedEntity} onSelect={setSelectedEntity} onActivate={openExplainer} layout="3d" />
                    </ErrorBoundary>
                  )
                ) : (
                  <IntelligenceGraph entities={graphEntities} relationships={graphRels} selectedId={selectedEntity} onSelect={setSelectedEntity} onActivate={openExplainer} />
                )}
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                {selected ? (
                  <>
                    <div className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">{selected.kind}</div>
                    <h3 className="mt-1 text-lg font-medium text-white/95">{selected.name}</h3>
                    {selected.summary && <p className="mt-2 text-[13px] leading-relaxed text-white/60">{selected.summary}</p>}
                    {selected.aliases && selected.aliases.length > 0 && (
                      <div className="mt-2 font-mono text-[10px] text-white/60">also: {selected.aliases.join(', ')}</div>
                    )}
                    <div className="mb-2 mt-4 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Supporting evidence ({selected.evidenceIds.length})</div>
                    <div className="max-h-64 space-y-1.5 overflow-y-auto scrollbar-thin">
                      {selected.evidenceIds.map((id) => {
                        const ev = inv.evidence.find((x) => x.id === id)
                        if (!ev) return null
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => jumpToEvidence(id)}
                            className="block w-full cursor-pointer rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2 text-left transition-colors hover:border-white/20"
                          >
                            <span className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${STATUS_STYLE[ev.status].dot}`} />
                            <span className="font-mono text-[10px] text-white/60">[{ev.id}]</span>
                            <span className="ml-1 text-[12px] leading-snug text-white/70">{ev.claim.slice(0, 110)}{ev.claim.length > 110 ? '…' : ''}</span>
                          </button>
                        )
                      })}
                    </div>
                    <div className="mb-2 mt-4 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Relationships</div>
                    <div className="space-y-1.5">
                      {graphRels.filter((r) => r.from === selected.id || r.to === selected.id).map((r) => {
                        const other = graphEntities.find((e) => e.id === (r.from === selected.id ? r.to : r.from))
                        return (
                          <div key={r.id} className="flex items-center gap-2 text-[12px] text-white/60">
                            <span className={`font-mono text-[9px] uppercase tracking-widest ${r.status === 'disputed' ? 'text-[#f0a096]' : r.status === 'supported' ? 'text-emerald-300/70' : 'text-white/60'}`}>{r.status}</span>
                            <span>{r.label}</span>
                            <button type="button" onClick={() => setSelectedEntity(other?.id ?? null)} className="cursor-pointer truncate text-white/85 underline decoration-white/20 underline-offset-2 hover:decoration-white/60">{other?.name ?? '?'}</button>
                          </div>
                        )
                      })}
                      {graphRels.filter((r) => r.from === selected.id || r.to === selected.id).length === 0 && (
                        <div className="text-xs text-white/60">No evidenced relationships yet.</div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-sm leading-relaxed text-white/60">
                    Click a node to inspect it: what the evidence says it is, the claims behind it, and its
                    relationships. Node size = supporting claims; coral outline = disputed evidence.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── EVIDENCE ── */}
          {tab === 'evidence' && (
            <div>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <input
                  value={evFilter}
                  onChange={(e) => setEvFilter(e.target.value)}
                  placeholder="Filter claims, quotes, hosts, [E#]…"
                  className="min-w-56 flex-1 rounded-xl border border-white/15 bg-black/30 px-4 py-2 text-sm text-white placeholder-white/25 outline-none focus:border-white/30"
                />
                {(['all', 'supported', 'unverified', 'disputed'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setEvStatus(s)}
                    className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-all ${
                      evStatus === s ? 'border-white/40 bg-white/12 text-white' : 'border-white/10 text-white/60 hover:text-white/70'
                    }`}
                  >
                    {s === 'all' ? 'All' : STATUS_STYLE[s].label}
                  </button>
                ))}
              </div>
              {filteredEvidence.length === 0 ? (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center text-sm text-white/60">
                  {inv.evidence.length === 0 ? 'No evidence yet — run the investigation to collect source-backed claims.' : 'Nothing matches this filter.'}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredEvidence.map((ev) => (
                    <div
                      key={ev.id}
                      id={`ev-${ev.id}`}
                      className={`rounded-xl border p-4 transition-all ${
                        highlightEv === ev.id ? 'border-white/45 bg-white/[0.08]' : 'border-white/10 bg-white/[0.03]'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[ev.status].dot}`} title={ev.status} />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] leading-relaxed text-white/85">{ev.claim}</div>
                          <div className="mt-1.5 border-l-2 border-white/10 pl-3 text-[12.5px] italic leading-relaxed text-white/45">
                            “{ev.quote}”
                            {!ev.quoteVerified && <span className="ml-2 font-mono text-[9px] uppercase not-italic tracking-widest text-[#f0a096]/70">paraphrase</span>}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-white/60">
                            <span className="text-white/55">[{ev.id}]</span>
                            <a href={ev.url.startsWith('document:') ? undefined : ev.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-white/50 transition-colors hover:text-white">
                              {ev.host} <ExternalLink size={9} />
                            </a>
                            <span>via {ev.connector}</span>
                            <span>retrieved {timeAgo(ev.retrievedAt)}</span>
                            {ev.sourceDate && <span>dated {ev.sourceDate}</span>}
                            <span>run #{ev.runN}</span>
                            {ev.note && <span className="text-white/45">— {ev.note}</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {latestRun?.discrepancies && latestRun.discrepancies.length > 0 && (
                <div className="mt-6">
                  <div className="mb-3 flex items-center gap-2 font-mono-display text-[10px] uppercase tracking-[0.25em] text-[#f0a096]/80">
                    <AlertTriangle size={12} /> Competing claims ({latestRun.discrepancies.length})
                  </div>
                  <div className="grid gap-2">
                    {latestRun.discrepancies.map((d) => (
                      <div key={d.id} className="rounded-xl border border-[#f0968a]/20 bg-[#f0968a]/[0.04] p-4">
                        <div className="text-[13px] font-medium text-white/85">{d.topic}</div>
                        <div className="mt-2 grid gap-1.5 text-[12.5px] leading-relaxed text-white/60">
                          <div className="flex gap-2"><button type="button" onClick={() => jumpToEvidence(d.a.claimId)} className="shrink-0 cursor-pointer font-mono text-[10px] text-white/50 underline decoration-white/20 hover:text-white">[{d.a.claimId}]</button> {d.a.says}</div>
                          <div className="flex gap-2"><button type="button" onClick={() => jumpToEvidence(d.b.claimId)} className="shrink-0 cursor-pointer font-mono text-[10px] text-white/50 underline decoration-white/20 hover:text-white">[{d.b.claimId}]</button> {d.b.says}</div>
                        </div>
                        {d.explanation && <div className="mt-2 text-[12px] text-white/45">{d.explanation}</div>}
                        {d.howToResolve && <div className="mt-1 text-[12px] italic text-white/60">To resolve: {d.howToResolve}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── RUNS ── */}
          {tab === 'runs' && (
            <div className="space-y-3">
              {inv.runs.length === 0 && (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center text-sm text-white/60">
                  No runs yet.
                </div>
              )}
              {[...inv.runs].reverse().map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  open={openRunId === run.id}
                  onToggle={() => setOpenRunId((cur) => (cur === run.id ? null : run.id))}
                  onOpenReport={() => { setReportRunId(run.id); setTab('report') }}
                  onJumpEvidence={jumpToEvidence}
                  onJumpUrl={jumpToUrl}
                />
              ))}
            </div>
          )}

          {/* ── REPORT ── */}
          {tab === 'report' && (() => {
            const reportRun = inv.runs.find((r) => r.id === reportRunId) ?? latestRun
            return (
            <div>
              {reportRun?.report ? (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Report · run #{reportRun.n}{reportRun.id !== latestRun?.id ? ' (older run)' : ''} · {timeAgo(reportRun.finishedAt ?? reportRun.startedAt)}</div>
                    <button
                      type="button"
                      onClick={() => {
                        const blob = new Blob([reportRun.report], { type: 'text/markdown' })
                        const a = document.createElement('a')
                        a.href = URL.createObjectURL(blob)
                        a.download = `${inv.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-run${reportRun.n}.md`
                        a.click()
                        URL.revokeObjectURL(a.href)
                      }}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/15 px-3.5 py-1.5 font-mono-display text-[10px] uppercase tracking-widest text-white/60 transition-colors hover:border-white/30 hover:text-white"
                    >
                      <Download size={11} /> .md
                    </button>
                  </div>
                  <ReportBody text={reportRun.report} onCite={jumpToEvidence} onJumpUrl={jumpToUrl} />
                </div>
              ) : (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center text-sm text-white/60">
                  No report yet — run the investigation first.
                </div>
              )}
            </div>
            )
          })()}

          {/* ── ANALYST ── */}
          {tab === 'analyst' && (
            <div className="mx-auto max-w-3xl">
              <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[12px] leading-relaxed text-white/45">
                The analyst answers only from this investigation's collected evidence — it cites [E#] for every
                factual assertion and says when the evidence is insufficient.
              </div>
              {transcript.length === 0 && (
                <div className="mb-4 flex flex-wrap gap-2">
                  {['What does the evidence establish overall?', 'What is still unverified?', 'What contradicts what?'].map((s) => (
                    <button key={s} type="button" onClick={() => setAnalystQ(s)} className="cursor-pointer rounded-full border border-white/12 px-3.5 py-1.5 text-xs text-white/55 transition-colors hover:border-white/30 hover:text-white">
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <div className="space-y-4">
                {transcript.map((t, i) => (
                  <div key={i} className="space-y-2">
                    <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-white/[0.10] px-4 py-2.5 text-[13px] text-white/90">{t.q}</div>
                    <div className="max-w-[92%] rounded-2xl rounded-bl-sm border border-white/10 bg-black/35 px-4 py-3">
                      {t.error ? (
                        <span className="text-[13px] text-[#f0b0a6]">{t.error}</span>
                      ) : t.a ? (
                        <ReportBody text={t.a} onCite={jumpToEvidence} onJumpUrl={jumpToUrl} />
                      ) : (
                        <Loader2 size={14} className="animate-spin text-white/40" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="sticky bottom-4 mt-5 flex gap-2">
                <input
                  value={analystQ}
                  onChange={(e) => setAnalystQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void askAnalyst() } }}
                  placeholder={inv.evidence.length ? 'Ask about the evidence…' : 'Run the investigation first — the analyst reads its evidence ledger.'}
                  disabled={!inv.evidence.length || analystBusy}
                  className="flex-1 rounded-full border border-white/15 bg-black/50 px-5 py-3 text-sm text-white placeholder-white/25 outline-none backdrop-blur-md focus:border-white/30 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => void askAnalyst()}
                  disabled={!analystQ.trim() || analystBusy || !inv.evidence.length}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-white px-5 py-3 font-mono-display text-[11px] uppercase tracking-[0.2em] text-black transition-all hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {analystBusy ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />} Ask
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* ── node explainer (opens over the graph on a node click) ── */}
      {explainTarget && (
        <EntityExplainModal
          entity={explainTarget.entity}
          evidence={explainTarget.evidence}
          ask={askEntity}
          onClose={() => setExplainEntityId(null)}
          onJumpEvidence={(id) => { setExplainEntityId(null); jumpToEvidence(id) }}
          onJumpUrl={(url) => { setExplainEntityId(null); jumpToUrl(url) }}
        />
      )}
    </div>
  )
}

// ── Run card (runs tab) ──────────────────────────────────────────────────────

function RunCard({ run, open, onToggle, onOpenReport, onJumpEvidence, onJumpUrl }: { run: Run; open: boolean; onToggle: () => void; onOpenReport: () => void; onJumpEvidence: (id: string) => void; onJumpUrl: (url: string) => void }) {
  const [openSteps, setOpenSteps] = useState(false)
  const statusStyle = run.phase === 'done'
    ? 'border-white/25 bg-white/[0.07] text-white/90'
    : run.phase === 'error'
      ? 'border-[#f0968a]/30 bg-[#f0968a]/[0.08] text-[#f0b0a6]'
      : 'border-white/15 bg-white/[0.05] text-white/50'
  return (
    <div className={`rounded-2xl border p-5 transition-colors ${open ? 'border-white/25 bg-white/[0.05]' : 'border-white/10 bg-white/[0.03]'}`}>
      <button type="button" onClick={onToggle} className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-3">
          <ChevronDown size={13} className={`text-white/40 transition-transform ${open ? 'rotate-180' : ''}`} />
          <span className="font-mono text-[11px] text-white/45">RUN {String(run.n).padStart(2, '0')}</span>
          <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ${statusStyle}`}>
            {PHASE_LABELS[run.phase] ?? run.phase}
          </span>
          {run.error && <span className="font-mono text-[10px] text-[#f0a096]/80">{run.error}</span>}
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-white/60">
          {timeAgo(run.startedAt)} · {run.stats.pages} pages · {run.stats.searches} searches · {run.stats.llmCalls} llm · {Math.round(run.stats.wallMs / 1000)}s
        </div>
      </button>

      {open && (
        <div className="mt-4 space-y-4 border-t border-white/[0.07] pt-4">
          {run.questions.length > 0 && (
            <div>
              <div className="mb-1.5 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Research questions</div>
              <ol className="space-y-1">
                {run.questions.map((q, i) => <li key={i} className="text-[12.5px] leading-relaxed text-white/60"><span className="mr-1.5 font-mono text-[10px] text-white/60">{i + 1}.</span>{q}</li>)}
              </ol>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-white/60">{run.sources.filter((s) => s.ok).length}/{run.sources.length} sources · {run.entities.length} entities · {run.relationships.length} edges · {run.evidenceIds.length} claims</span>
            {run.report && (
              <button type="button" onClick={onOpenReport} className="cursor-pointer rounded-full border border-white/15 px-3 py-1 font-mono-display text-[10px] uppercase tracking-[0.2em] text-white/70 transition-colors hover:border-white/30 hover:text-white">
                Open report ↗
              </button>
            )}
          </div>
          {run.report && (
            <div className="max-h-56 overflow-y-auto scrollbar-thin rounded-xl border border-white/[0.07] bg-black/30 p-3">
              <ReportBody text={run.report.slice(0, 2500) + (run.report.length > 2500 ? '\n\n…' : '')} onCite={onJumpEvidence} onJumpUrl={onJumpUrl} />
            </div>
          )}
          {run.openQuestions.length > 0 && (
            <div>
              <div className="mb-1.5 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Open questions</div>
              <ul className="space-y-1">
                {run.openQuestions.map((q, i) => <li key={i} className="text-[12.5px] leading-relaxed text-white/55">— {q}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {run.changes && (
        <div className="mt-4 rounded-xl border border-white/[0.07] bg-black/25 p-4">
          <div className="mb-2 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">What changed vs run #{run.n - 1}</div>
          <div className="text-[12.5px] text-white/60">{run.changes.summary}</div>
          <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px]">
            <span className="rounded-full border border-emerald-400/25 bg-emerald-400/[0.07] px-2.5 py-0.5 text-emerald-300/80">+{run.changes.newEvidence} new claims</span>
            {run.changes.changedSources.length > 0 && <span className="rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-0.5 text-white/60">{run.changes.changedSources.length} changed source(s)</span>}
            {run.changes.missingSources.length > 0 && <span className="rounded-full border border-[#f0968a]/25 bg-[#f0968a]/[0.06] px-2.5 py-0.5 text-[#f0a096]/80">{run.changes.missingSources.length} unavailable</span>}
          </div>
          {(run.changes.changedSources.length > 0 || run.changes.missingSources.length > 0) && (
            <div className="mt-3 space-y-1.5">
              {run.changes.changedSources.map((c) => (
                <div key={c.url} className="text-[12px] text-white/50">
                  <span className="mr-1.5 font-mono text-[9px] uppercase tracking-widest text-white/60">changed</span>
                  <a href={c.url} target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:text-white">{c.url.slice(0, 90)}</a> — {c.note}
                </div>
              ))}
              {run.changes.missingSources.map((c) => (
                <div key={c.url} className="text-[12px] text-white/50">
                  <span className="mr-1.5 font-mono text-[9px] uppercase tracking-widest text-[#f0a096]/70">missing</span>
                  <span className="underline decoration-white/20 underline-offset-2">{c.url.slice(0, 90)}</span> — {c.note}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {run.openQuestions.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/45">Open questions</div>
          <ul className="space-y-1">
            {run.openQuestions.map((q, i) => <li key={i} className="text-[12.5px] leading-relaxed text-white/55">— {q}</li>)}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpenSteps((s) => !s)} className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-white/45 transition-colors hover:border-white/25 hover:text-white/80">
          Audit log ({run.steps.length}) {openSteps ? <ChevronDown size={10} className="rotate-180" /> : <ChevronDown size={10} />}
        </button>
        <span className="font-mono text-[10px] text-white/60">
          {run.sources.filter((s) => s.ok).length}/{run.sources.length} sources ok · {run.evidenceIds.length} claims collected
        </span>
      </div>
      {openSteps && (
        <div className="mt-3 max-h-64 overflow-y-auto scrollbar-thin rounded-xl border border-white/[0.07] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-white/45">
          {run.steps.map((s, i) => <div key={i} className="whitespace-pre-wrap">{s}</div>)}
        </div>
      )}

      {run.sources.some((s) => !s.ok) && (
        <div className="mt-3 text-[11.5px] leading-relaxed text-white/60">
          <span className="font-mono text-[9px] uppercase tracking-widest text-white/60">unavailable this run: </span>
          {run.sources.filter((s) => !s.ok).map((s) => `${s.url.slice(0, 60)} (${s.error ?? 'failed'})`).join(' · ')}
        </div>
      )}
      {run.evidenceIds.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {run.evidenceIds.slice(0, 24).map((id) => (
            <button key={id} type="button" onClick={() => onJumpEvidence(id)} className="cursor-pointer rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9.5px] text-white/45 transition-colors hover:border-white/30 hover:text-white">
              {id}
            </button>
          ))}
          {run.evidenceIds.length > 24 && <span className="self-center font-mono text-[9.5px] text-white/60">+{run.evidenceIds.length - 24} more in the ledger</span>}
        </div>
      )}
    </div>
  )
}
