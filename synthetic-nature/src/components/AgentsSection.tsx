/**
 * AgentsSection.tsx — the Custom Agent Builder workspace tab.
 *
 * Flow: Describe (plain English, optional internet-gathering toggle + reference
 * URLs) → the backend composes an expert-manual draft + gathers skills/knowledge
 * → Review (everything editable, gathered items as check-cards) → test-run
 * inline (SSE: content + search steps + lessons) → Save. Saved agents: run,
 * run-history timeline, Learned (memory) + Knowledge panels, schedule picker,
 * delete.
 *
 * Auth follows the vault pattern: mintVaultToken() → x-vault-token header, and
 * provider keys are sent per-request only (never stored by the agents backend).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { mintVaultToken } from '../lib/vaultToken'
import { getProviderKeys } from '../lib/keyStore'

// ── Types (mirror the backend's AgentEntry / GatherResult) ───────────────────

type ToolName =
  | 'web_search' | 'deep_research' | 'gmail_list' | 'gmail_send'
  | 'calendar_list' | 'calendar_create' | 'recommend_model' | 'compare_models' | 'document_assist'

interface AgentSchedule {
  kind: 'daily' | 'interval'
  time?: string
  intervalMinutes?: number
  timezone: string
}

interface Agent {
  id: string
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  model: string
  skills: string[]
  knowledge: string[]
  memory: string[]
  schedule: AgentSchedule | null
  createdAt: number
  updatedAt: number
  lastRunAt?: number
}

interface GatherCandidate {
  id: string
  name: string
  description: string
  source: 'bundled' | 'learned' | 'github'
  sourceUrl?: string
}

interface GatherNote {
  note: string
  source: string
}

interface GatherResult {
  queries: string[]
  bundled: GatherCandidate[]
  learned: GatherCandidate[]
  github: GatherCandidate[]
  knowledge: GatherNote[]
  warnings: string[]
}

interface DraftResult {
  draft: {
    name: string
    description: string
    systemPrompt: string
    tools: string[]
    model: string
    modelReason: string
  }
  gather: GatherResult | null
}

interface RunRecord {
  startedAt: number
  finishedAt: number
  status: 'ok' | 'error'
  trigger: 'manual' | 'schedule'
  steps: string[]
  output: string
  lessons: string[]
}

const TOOL_LABELS: Record<ToolName, string> = {
  web_search: 'Web search',
  deep_research: 'Deep research',
  gmail_list: 'Read Gmail',
  gmail_send: 'Send Gmail',
  calendar_list: 'Read calendar',
  calendar_create: 'Create events',
  recommend_model: 'Recommend models',
  compare_models: 'Compare models',
  document_assist: 'Edit text',
}

const SOURCE_LABELS: Record<GatherCandidate['source'], string> = {
  bundled: 'Bundled skill',
  learned: 'Your learned skill',
  github: 'Learned from GitHub',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; json: any }> {
  const token = await mintVaultToken()
  const res = await fetch(path, {
    method: init.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-vault-token': token } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  let json: any = null
  try { json = await res.json() } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, json }
}

async function apiWithKeys(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: any }> {
  const token = await mintVaultToken()
  const keys = getProviderKeys()
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-vault-token': token } : {}),
      ...(keys.groq ? { 'x-groq-key': keys.groq } : {}),
      ...(keys.exa ? { 'x-exa-key': keys.exa } : {}),
      ...(keys.openrouter ? { 'x-openrouter-key': keys.openrouter } : {}),
    },
    body: JSON.stringify({ ...body, providerKeys: keys }),
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

// ── Main component ───────────────────────────────────────────────────────────

export default function AgentsSection() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [view, setView] = useState<'list' | 'create' | 'detail'>('list')
  const [detail, setDetail] = useState<Agent | null>(null)

  const refresh = useCallback(async () => {
    const r = await api('/api/agents')
    // Non-ok (e.g. an expired vault token after the in-api retry) leaves the
    // previous list untouched — a 401 must not repaint "No agents yet" over
    // agents the user can still open.
    if (r.ok) setAgents(r.json.agents || [])
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <div className="w-full">
      {/* Header */}
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <div className="font-mono-display text-[10px] uppercase tracking-[0.3em] text-white/40">
            Workspace · Custom Agents
          </div>
          <h2 className="mt-2 text-2xl font-semibold text-white">
            Describe a task once. It becomes an agent.
          </h2>
          <p className="mt-1 max-w-xl text-sm text-white/50">
            Plain English in — expert manual, tools, model pinning, domain knowledge and
            accumulating memory out. Runs on demand or on a schedule.
          </p>
        </div>
        <button
          onClick={() => setView('create')}
          className="shrink-0 rounded-full border border-white/15 bg-white/10 px-5 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-white/20"
        >
          + New agent
        </button>
      </div>

      {view === 'list' && (
        <AgentList
          agents={agents}
          onRefresh={() => void refresh()}
          onOpen={(a) => { setDetail(a); setView('detail') }}
          onRun={async (a) => { setDetail(a); setView('detail') }}
          onDeleted={() => void refresh()}
        />
      )}

      {view === 'create' && (
        <CreateAgentModal
          onClose={() => setView('list')}
          onSaved={() => { setView('list'); void refresh() }}
        />
      )}

      {view === 'detail' && detail && (
        <AgentDetail
          agent={detail}
          onBack={() => { setDetail(null); setView('list'); void refresh() }}
          onAgentChanged={(a) => setDetail(a)}
        />
      )}
    </div>
  )
}

// ── List ──────────────────────────────────────────────────────────────────────

function AgentList({
  agents, onOpen, onDeleted,
}: {
  agents: Agent[]
  onRefresh: () => void
  onOpen: (a: Agent) => void
  onRun: (a: Agent) => void
  onDeleted: () => void
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null)

  if (!agents.length) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl border border-white/10 bg-white/[0.04] p-10 text-center"
      >
        <div className="mx-auto max-w-md">
          <div className="font-mono-display text-[10px] uppercase tracking-[0.3em] text-white/40">
            No agents yet
          </div>
          <p className="mt-3 text-sm text-white/60">
            Try: <span className="text-white/90">"Every morning check my Gmail for invoices and
            draft replies for the urgent ones."</span> ENZO writes the operating manual, picks the
            tools, finds domain knowledge, and remembers what it learns across runs.
          </p>
        </div>
      </motion.div>
    )
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {agents.map((a) => (
        <motion.div
          key={a.id}
          layout
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="group rounded-2xl border border-white/10 bg-white/[0.04] p-5 transition hover:border-white/20"
        >
          <div className="flex items-start justify-between gap-3">
            <button onClick={() => onOpen(a)} className="min-w-0 flex-1 text-left">
              <div className="truncate text-base font-semibold text-white">{a.name}</div>
              <div className="mt-0.5 line-clamp-2 text-xs text-white/50">{a.description}</div>
            </button>
            {confirmId === a.id ? (
              <div className="flex shrink-0 gap-1.5">
                <button
                  onClick={async () => { await api(`/api/agents/${a.id}`, { method: 'DELETE' }); setConfirmId(null); onDeleted() }}
                  className="rounded-full bg-red-500/80 px-3 py-1 text-[10px] font-medium text-white"
                >
                  Delete
                </button>
                <button onClick={() => setConfirmId(null)} className="rounded-full bg-white/10 px-3 py-1 text-[10px] text-white/70">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmId(a.id)}
                className="shrink-0 text-white/25 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                aria-label="Delete agent"
              >
                ✕
              </button>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 font-mono-display text-[9px] uppercase tracking-wider text-white/60">
              {a.model.split('/').pop()}
            </span>
            {a.tools.slice(0, 3).map((t) => (
              <span key={t} className="rounded-full bg-white/5 px-2.5 py-0.5 font-mono-display text-[9px] uppercase tracking-wider text-white/45">
                {TOOL_LABELS[t as ToolName] || t}
              </span>
            ))}
            {a.schedule && (
              <span className="rounded-full bg-emerald-400/10 px-2.5 py-0.5 font-mono-display text-[9px] uppercase tracking-wider text-emerald-300/90">
                ⏱ {a.schedule.kind === 'daily' ? `daily ${a.schedule.time}` : `every ${a.schedule.intervalMinutes}m`}
              </span>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between text-[11px] text-white/40">
            <div className="flex gap-2">
              {a.memory.length > 0 && <span className="text-white/50">Learned: {a.memory.length}</span>}
              {a.knowledge.length > 0 && <span>Knowledge: {a.knowledge.length}</span>}
            </div>
            <span>last run {timeAgo(a.lastRunAt)}</span>
          </div>

          <button
            onClick={() => onOpen(a)}
            className="mt-4 w-full rounded-lg border border-white/10 bg-white/[0.06] py-2 font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/80 transition hover:bg-white/15"
          >
            Open
          </button>
        </motion.div>
      ))}
    </div>
  )
}

// ── Create modal (3 steps: describe → review → test-run → save) ──────────────

function CreateAgentModal({
  onClose, onSaved,
}: {
  onClose: () => void
  onSaved: () => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [description, setDescription] = useState('')
  const [urls, setUrls] = useState('')
  const [internet, setInternet] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftResult['draft'] | null>(null)
  const [gather, setGather] = useState<GatherResult | null>(null)

  // Review form
  const [name, setName] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [tools, setTools] = useState<string[]>([])
  const [scheduleKind, setScheduleKind] = useState<'none' | 'daily' | 'interval'>('none')
  const [dailyTime, setDailyTime] = useState('09:00')
  const [intervalMin, setIntervalMin] = useState(30)
  const [pickedSkills, setPickedSkills] = useState<string[]>([])
  const [pickedKnowledge, setPickedKnowledge] = useState<string[]>([])
  const [savedAgent, setSavedAgent] = useState<Agent | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const runDraft = async () => {
    setDrafting(true); setDraftError(null)
    try {
      const urlList = urls.split(/[\n,]/).map((u) => u.trim()).filter(Boolean)
      const r = await apiWithKeys('/api/agents/draft', {
        description,
        gatherInternet: internet,
        urls: urlList,
      })
      if (!r.ok) {
        setDraftError(r.json?.message || r.json?.error || 'Drafting failed.')
        return
      }
      setDraft(r.json.draft)
      setGather(r.json.gather)
      setName(r.json.draft.name)
      setSystemPrompt(r.json.draft.systemPrompt)
      setTools(r.json.draft.tools || [])
      // Everything gathered is pre-checked for review — the user unchecks.
      const g: GatherResult = r.json.gather || { queries: [], bundled: [], learned: [], github: [], knowledge: [], warnings: [] }
      setPickedSkills([...g.bundled.map((c: GatherCandidate) => c.id), ...g.learned.map((c: GatherCandidate) => c.id), ...g.github.map((c: GatherCandidate) => c.id)])
      setPickedKnowledge(g.knowledge.map((n: GatherNote) => n.note))
      setStep(2)
    } catch (e: any) {
      setDraftError(String(e?.message || e))
    } finally {
      setDrafting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const body: Record<string, unknown> = {
        name, description,
        systemPrompt, tools, model: draft?.model,
        skills: pickedSkills,
        knowledge: pickedKnowledge,
        memory: [],
      }
      if (scheduleKind === 'daily') {
        body.schedule = { kind: 'daily', time: dailyTime, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      } else if (scheduleKind === 'interval') {
        body.schedule = { kind: 'interval', intervalMinutes: intervalMin, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      } else {
        body.schedule = null
      }
      const r = await api('/api/agents', { method: 'POST', body })
      if (!r.ok) {
        setSaveError(r.json?.message || r.json?.error || `Save failed (HTTP ${r.status}).`)
        return
      }
      setSavedAgent(r.json.agent)
      setStep(3)
    } finally {
      setSaving(false)
    }
  }

  const toggle = (arr: string[], v: string, set: (a: string[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  const allCandidates: GatherCandidate[] = [
    ...(gather?.bundled || []), ...(gather?.learned || []), ...(gather?.github || []),
  ]

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      {/* Step indicator */}
      <div className="mb-6 flex items-center gap-3 font-mono-display text-[10px] uppercase tracking-[0.25em]">
        {(['Describe', 'Review', 'Test'] as const).map((label, i) => (
          <div key={label} className={`flex items-center gap-2 ${step === i + 1 ? 'text-white' : 'text-white/30'}`}>
            <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${step === i + 1 ? 'border-white/60 bg-white/10' : 'border-white/15'}`}>{i + 1}</span>
            {label}
            {i < 2 && <span className="ml-1 text-white/20">—</span>}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
          <label className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">
            What should this agent do?
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Every morning check my Gmail for invoices and draft replies for the urgent ones."
            className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-black/30 p-4 text-sm text-white placeholder-white/25 outline-none focus:border-white/30"
          />

          <label className="mt-5 block font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">
            Reference URLs (optional)
          </label>
          <textarea
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            rows={2}
            placeholder="https://docs.example.com/invoice-rules — up to 5, fetched and distilled into notes"
            className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white placeholder-white/25 outline-none focus:border-white/30"
          />

          <label className="mt-5 flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={internet}
              onChange={(e) => setInternet(e.target.checked)}
              className="h-4 w-4 accent-white"
            />
            <span className="text-xs text-white/70">
              Search the internet for skills (finds GitHub repos for this domain and learns from
              them — nothing is ever executed, only read as text)
            </span>
          </label>

          {draftError && <div className="mt-4 rounded-lg bg-red-500/10 px-4 py-2 text-xs text-red-300">{draftError}</div>}

          <div className="mt-6 flex items-center justify-end gap-3">
            <button onClick={onClose} className="rounded-full px-4 py-2 text-xs text-white/50 hover:text-white/80">Cancel</button>
            <button
              onClick={runDraft}
              disabled={drafting || description.trim().length < 10}
              className="rounded-full border border-white/15 bg-white/10 px-6 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-white/20 disabled:opacity-40"
            >
              {drafting ? 'Building draft…' : 'Draft my agent →'}
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          {/* Name + description */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
            <label className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-white outline-none focus:border-white/30"
            />
            <label className="mt-4 block font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">Task</label>
            <div className="mt-2 text-xs text-white/60">{description}</div>
          </div>

          {/* Expert manual */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
            <div className="flex items-center justify-between">
              <label className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">
                Expert manual (system prompt)
              </label>
              <span className="font-mono text-[10px] text-white/30">{systemPrompt.length}/8000</span>
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={10}
              className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-black/30 p-4 font-mono text-xs leading-relaxed text-white/90 outline-none focus:border-white/30"
            />
          </div>

          {/* Tools */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
            <label className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">
              Tools this agent may use
            </label>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(Object.keys(TOOL_LABELS) as ToolName[]).map((t) => (
                <label key={t} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition ${tools.includes(t) ? 'border-white/40 bg-white/10 text-white' : 'border-white/10 text-white/50 hover:text-white/80'}`}>
                  <input
                    type="checkbox"
                    checked={tools.includes(t)}
                    onChange={() => toggle(tools, t, setTools)}
                    className="h-3.5 w-3.5 accent-white"
                  />
                  {TOOL_LABELS[t]}
                </label>
              ))}
            </div>
          </div>

          {/* Model + schedule */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
              <label className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">Model</label>
              <div className="mt-2 text-sm text-white">{draft?.model || 'groq/llama-3.3-70b-versatile'}</div>
              <div className="mt-1 text-[11px] text-white/45">{draft?.modelReason}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
              <label className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">Schedule</label>
              <div className="mt-3 flex flex-wrap gap-2">
                {(['none', 'daily', 'interval'] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setScheduleKind(k)}
                    className={`rounded-full px-4 py-1.5 font-mono-display text-[10px] uppercase tracking-wider transition ${scheduleKind === k ? 'bg-white/15 text-white' : 'bg-white/5 text-white/45 hover:text-white/80'}`}
                  >
                    {k === 'none' ? 'On demand' : k}
                  </button>
                ))}
              </div>
              {scheduleKind === 'daily' && (
                <input type="time" value={dailyTime} onChange={(e) => setDailyTime(e.target.value)} className="mt-3 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white outline-none" />
              )}
              {scheduleKind === 'interval' && (
                <div className="mt-3 flex items-center gap-2 text-xs text-white/60">
                  every
                  <input type="number" min={5} max={1440} value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value) || 30)} className="w-20 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-sm text-white outline-none" />
                  minutes
                </div>
              )}
              <div className="mt-2 text-[10px] text-white/35">
                Scheduled runs are read-only and use server-configured keys only.
              </div>
            </div>
          </div>

          {/* Gathered skills */}
          {allCandidates.length > 0 && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
              <label className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">
                Gathered skills ({allCandidates.length})
              </label>
              <div className="mt-3 space-y-2">
                {allCandidates.map((c) => (
                  <label key={`${c.source}-${c.id}`} className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-white/20">
                    <input
                      type="checkbox"
                      checked={pickedSkills.includes(c.id)}
                      onChange={() => toggle(pickedSkills, c.id, setPickedSkills)}
                      className="mt-0.5 h-4 w-4 accent-white"
                    />
                    <div className="min-w-0">
                      <div className="text-xs text-white">{c.name}</div>
                      <div className="mt-0.5 line-clamp-1 text-[11px] text-white/45">{c.description}</div>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-white/35">
                        <span className="rounded-full bg-white/5 px-2 py-0.5">{SOURCE_LABELS[c.source]}</span>
                        {c.sourceUrl && <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="truncate underline hover:text-white/60">{c.sourceUrl}</a>}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Gathered knowledge notes */}
          {(gather?.knowledge?.length || 0) > 0 && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
              <label className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">
                Distilled knowledge ({gather!.knowledge.length})
              </label>
              <div className="mt-3 space-y-2">
                {gather!.knowledge.map((n) => (
                  <label key={n.note.slice(0, 40)} className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 transition hover:border-white/20">
                    <input
                      type="checkbox"
                      checked={pickedKnowledge.includes(n.note)}
                      onChange={() => toggle(pickedKnowledge, n.note, setPickedKnowledge)}
                      className="mt-0.5 h-4 w-4 accent-white"
                    />
                    <div className="min-w-0">
                      <div className="text-xs text-white/90">{n.note}</div>
                      <div className="mt-1 truncate text-[10px] text-white/35">from {n.source}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {gather?.warnings?.length ? (
            <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-[11px] text-amber-200/80">
              {gather.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          ) : null}

          {saveError && <div className="rounded-lg bg-red-500/10 px-4 py-2 text-xs text-red-300">{saveError}</div>}

          <div className="flex items-center justify-between">
            <button onClick={() => setStep(1)} className="rounded-full px-4 py-2 text-xs text-white/50 hover:text-white/80">← Back</button>
            <button
              onClick={save}
              disabled={saving || !systemPrompt.trim()}
              className="rounded-full border border-white/15 bg-white/10 px-6 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-white/20 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save & test →'}
            </button>
          </div>
        </div>
      )}

      {step === 3 && savedAgent && (
        <TestRunPanel
          agent={savedAgent}
          onDone={onSaved}
        />
      )}
    </motion.div>
  )
}

// ── Test-run panel (inline mini-chat over the SSE run route) ─────────────────

function TestRunPanel({
  agent, onDone,
}: {
  agent: Agent
  onDone: () => void
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
      <div className="font-mono-display text-[10px] uppercase tracking-[0.25em] text-white/40">
        Test run — {agent.name}
      </div>
      <AgentRunChat agentId={agent.id} compact />
      <div className="mt-5 flex items-center justify-between">
        <span className="text-[11px] text-white/40">Saved. Run it from the agents list any time.</span>
        <button
          onClick={() => { onDone() }}
          className="rounded-full border border-white/15 bg-white/10 px-6 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-white/20"
        >
          Done
        </button>
      </div>
    </div>
  )
}

/** Streaming mini-chat: content + search steps + lessons, one SSE connection
 *  per message. Write-confirmation cards render inside the transcript; a
 *  "yes, send it" reply completes the confirm flow on the next turn (the prior
 *  transcript is replayed to the backend as messages[]).
 *  When turns/setTurns are passed in, the transcript lives in the PARENT — the
 *  detail view's AnimatePresence unmounts this component on every tab switch,
 *  and state held here would die with it. */
interface Turn { role: 'user' | 'agent'; text: string; steps?: string[]; lessons?: string[] }

function AgentRunChat({
  agentId, compact, turns: liftedTurns, setTurns: liftSetTurns, onRunComplete,
}: {
  agentId: string
  compact?: boolean
  turns?: Turn[]
  setTurns?: Dispatch<SetStateAction<Turn[]>>
  onRunComplete?: () => void
}) {
  const [ownTurns, setOwnTurns] = useState<Turn[]>([])
  const turns = liftedTurns ?? ownTurns
  const setTurns = liftSetTurns ?? setOwnTurns
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns, running])

  const send = async () => {
    const message = input.trim()
    if (!message || running) return
    // The transcript BEFORE this send — the backend appends this message
    // itself, so replaying it would duplicate the user turn.
    const history = turns
      .filter((t) => t.text.trim())
      .slice(-10)
      .map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text }))
    setInput('')
    setRunning(true)
    setTurns((prev) => [...prev, { role: 'user', text: message }, { role: 'agent', text: '', steps: [] }])

    try {
      const token = await mintVaultToken()
      const keys = getProviderKeys()
      const res = await fetch(`/api/agents/${agentId}/run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-vault-token': token } : {}),
          ...(keys.groq ? { 'x-groq-key': keys.groq } : {}),
          ...(keys.exa ? { 'x-exa-key': keys.exa } : {}),
          ...(keys.openrouter ? { 'x-openrouter-key': keys.openrouter } : {}),
        },
        // providerKeys lets the backend resolve the agent's pinned provider
        // (an OpenRouter-pinned agent must not fall back to a keyless Groq
        // call just because the run chat only sends the Groq header).
        // messages: prior turns, so multi-turn runs keep context.
        body: JSON.stringify({ message, confirmWrites: true, providerKeys: keys, messages: history }),
      })
      if (!res.ok) {
        // A non-2xx body here is a small JSON error (401 expired vault token,
        // 404 deleted agent, 429 rate limit), not an SSE stream — parsing it
        // as one leaves a silent blank agent turn.
        let msg = `HTTP ${res.status}`
        try {
          const j = await res.json()
          msg = j?.message || j?.error || msg
        } catch { /* body wasn't JSON */ }
        throw new Error(msg)
      }
      const reader = res.body?.getReader()
      if (!reader) throw new Error('No stream')
      const decoder = new TextDecoder()
      let buffer = ''
      const append = (fn: (t: Turn) => Turn) =>
        setTurns((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1])])

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() || ''
        for (const frame of frames) {
          if (!frame.trim()) continue
          let ev = ''
          let data: string | null = null
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim()
            else if (line.startsWith('data:')) data = line.startsWith('data: ') ? line.slice(6) : line.slice(5)
          }
          if (data === null) continue
          let payload: any
          try { payload = JSON.parse(data) } catch { continue }

          if (ev === 'content' && payload.text) {
            append((t) => ({ ...t, text: t.text + payload.text }))
          } else if (ev === 'search' && payload.text) {
            append((t) => ({ ...t, steps: [...(t.steps || []), payload.text] }))
          } else if (ev === 'error' && payload.text) {
            append((t) => ({ ...t, text: t.text + (t.text ? '\n' : '') + `⚠ ${payload.text}` }))
          } else if (ev === 'lessons' && Array.isArray(payload.lessons) && payload.lessons.length) {
            append((t) => ({ ...t, lessons: payload.lessons }))
          }
        }
      }
    } catch (e: any) {
      setTurns((prev) => [...prev.slice(0, -1), { role: 'agent', text: `⚠ ${e?.message || e}` }])
    } finally {
      setRunning(false)
      // Memory/lastRunAt/run-history all changed server-side — let the detail
      // view refresh its agent entry and run list without a manual reload.
      onRunComplete?.()
    }
  }

  return (
    <div className="mt-3">
      <div
        ref={scrollRef}
        className={`overflow-y-auto rounded-xl border border-white/10 bg-black/30 ${compact ? 'max-h-72' : 'max-h-[28rem]'} p-4`}
      >
        {!turns.length && (
          <div className="py-6 text-center text-xs text-white/35">
            Type a message and run — or just say "run your task".
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`mb-3 ${t.role === 'user' ? 'text-right' : ''}`}>
            {t.role === 'user' ? (
              <span className="inline-block max-w-[85%] rounded-xl bg-white/10 px-3 py-1.5 text-xs text-white/90">{t.text}</span>
            ) : (
              <div className="max-w-full text-sm">
                {t.steps?.map((s, j) => (
                  <div key={j} className="font-mono-display text-[10px] uppercase tracking-wider text-white/35">{s}</div>
                ))}
                {t.text && <div className="whitespace-pre-wrap text-white/90">{t.text}</div>}
                {t.lessons?.length ? (
                  <div className="mt-1 rounded-lg bg-emerald-400/10 px-3 py-1.5 text-[10px] text-emerald-300/80">
                    learned: {t.lessons.join(' · ')}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ))}
        {running && <div className="font-mono-display text-[10px] uppercase tracking-wider text-white/30">working…</div>}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), void send())}
          placeholder={running ? 'Running…' : 'Message your agent'}
          disabled={running}
          className="flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-white placeholder-white/25 outline-none focus:border-white/30 disabled:opacity-50"
        />
        <button
          onClick={() => void send()}
          disabled={running || !input.trim()}
          className="rounded-xl border border-white/15 bg-white/10 px-5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-white transition hover:bg-white/20 disabled:opacity-40"
        >
          Run
        </button>
      </div>
    </div>
  )
}

// ── Agent detail: chat + history + learned + knowledge ──────────────────────

function AgentDetail({
  agent, onBack, onAgentChanged,
}: {
  agent: Agent
  onBack: () => void
  onAgentChanged: (a: Agent) => void
}) {
  const [tab, setTab] = useState<'run' | 'history' | 'learned' | 'knowledge'>('run')
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [gathering, setGathering] = useState(false)
  const [gatherProposal, setGatherProposal] = useState<GatherResult | null>(null)
  // The run transcript lives HERE (not in AgentRunChat) so it survives the
  // AnimatePresence tab switch — chat history is the context a "yes, send it"
  // confirmation reply needs.
  const [chatTurns, setChatTurns] = useState<Turn[]>([])

  const loadRuns = useCallback(async () => {
    const r = await api(`/api/agents/${agent.id}/runs`)
    if (r.ok) setRuns(r.json.runs || [])
  }, [agent.id])

  useEffect(() => { void loadRuns() }, [loadRuns])
  // Runs happen on the run tab — reload on every return to history so the
  // timeline (and the tab's count) reflects the latest run.
  useEffect(() => { if (tab === 'history') void loadRuns() }, [tab, loadRuns])

  const refreshAgent = useCallback(async () => {
    // No single-agent GET exists; both needs are served by one round of the
    // list + runs endpoints (each 60/min bucketed).
    const [lr, rr] = await Promise.all([api('/api/agents'), api(`/api/agents/${agent.id}/runs`)])
    if (lr.ok) {
      const fresh = (lr.json.agents || []).find((a: Agent) => a.id === agent.id)
      if (fresh) onAgentChanged(fresh)
    }
    if (rr.ok) setRuns(rr.json.runs || [])
  }, [agent.id, onAgentChanged])

  const [opError, setOpError] = useState<string | null>(null)
  // Every mutating tab action goes through this wrapper so a failed fetch
  // (expired token, 429, network) surfaces as a banner instead of a silent
  // no-op — and never as an unhandled promise rejection.
  const guarded = async (fn: () => Promise<boolean>) => {
    try {
      setOpError(null)
      await fn()
    } catch (e: any) {
      setOpError(String(e?.message || e))
    }
  }

  const applyGather = () => guarded(async () => {
    if (!gatherProposal) return true
    const skills = [...new Set([...agent.skills, ...gatherProposal.bundled.map((c) => c.id), ...gatherProposal.learned.map((c) => c.id), ...gatherProposal.github.map((c) => c.id)])]
    const knowledge = [...agent.knowledge, ...gatherProposal.knowledge.map((n) => n.note)]
    const r = await api(`/api/agents/${agent.id}`, { method: 'PUT', body: { skills, knowledge } })
    if (!r.ok) { setOpError(r.json?.message || r.json?.error || `Apply failed (HTTP ${r.status}).`); return false }
    onAgentChanged(r.json.agent); setGatherProposal(null)
    return true
  })

  const delMemory = (idx: number) => guarded(async () => {
    const r = await api(`/api/agents/${agent.id}/memory/${idx}`, { method: 'DELETE' })
    if (!r.ok) { setOpError(r.json?.message || r.json?.error || `Delete failed (HTTP ${r.status}).`); return false }
    onAgentChanged(r.json.agent)
    return true
  })

  const clearMemory = () => guarded(async () => {
    const r = await api(`/api/agents/${agent.id}/memory`, { method: 'DELETE' })
    if (!r.ok) { setOpError(r.json?.message || r.json?.error || `Clear failed (HTTP ${r.status}).`); return false }
    onAgentChanged(r.json.agent)
    return true
  })

  const delKnowledge = (idx: number) => guarded(async () => {
    const r = await api(`/api/agents/${agent.id}/knowledge/${idx}`, { method: 'DELETE' })
    if (!r.ok) { setOpError(r.json?.message || r.json?.error || `Delete failed (HTTP ${r.status}).`); return false }
    onAgentChanged(r.json.agent)
    return true
  })

  const regather = () => guarded(async () => {
    setGathering(true)
    try {
      const r = await apiWithKeys(`/api/agents/${agent.id}/gather`, { internet: true })
      if (!r.ok) { setOpError(r.json?.message || r.json?.error || `Gather failed (HTTP ${r.status}).`); return false }
      setGatherProposal(r.json.proposed)
      return true
    } finally {
      setGathering(false)
    }
  })

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <button onClick={onBack} className="text-white/40 transition hover:text-white/80">←</button>
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold text-white">{agent.name}</h3>
          <div className="truncate text-xs text-white/45">{agent.description}</div>
        </div>
      </div>

      <div className="mb-5 flex gap-1.5">
        {(['run', 'history', 'learned', 'knowledge'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 font-mono-display text-[10px] uppercase tracking-[0.2em] transition ${tab === t ? 'bg-white/12 text-white' : 'text-white/40 hover:text-white/80'}`}
          >
            {t === 'run' ? 'Run' : t === 'history' ? `History (${runs.length})` : t === 'learned' ? `Learned (${agent.memory.length})` : `Knowledge (${agent.knowledge.length})`}
          </button>
        ))}
      </div>

      {opError && <div className="mb-4 rounded-lg bg-red-500/10 px-4 py-2 text-xs text-red-300">{opError}</div>}

      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          {tab === 'run' && (
            <AgentRunChat
              agentId={agent.id}
              turns={chatTurns}
              setTurns={setChatTurns}
              onRunComplete={() => { void refreshAgent() }}
            />
          )}

          {tab === 'history' && (
            <div className="space-y-3">
              {!runs.length && <div className="rounded-xl border border-white/10 bg-white/[0.04] p-6 text-center text-xs text-white/40">No runs yet.</div>}
              {runs.map((r, i) => (
                <div key={i} className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                  <div className="flex items-center justify-between font-mono-display text-[10px] uppercase tracking-wider">
                    <span className={r.status === 'ok' ? 'text-emerald-300/80' : 'text-red-300/80'}>
                      {r.status} · {r.trigger} · {new Date(r.startedAt).toLocaleString()}
                    </span>
                  </div>
                  {r.steps?.length ? (
                    <div className="mt-2 space-y-0.5">
                      {r.steps.map((s, j) => <div key={j} className="font-mono-display text-[10px] text-white/35">{s}</div>)}
                    </div>
                  ) : null}
                  <div className="mt-2 line-clamp-6 whitespace-pre-wrap text-xs text-white/80">{r.output || '(no output)'}</div>
                  {r.lessons?.length ? (
                    <div className="mt-2 text-[10px] text-emerald-300/70">learned: {r.lessons.join(' · ')}</div>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {tab === 'learned' && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/50">Distilled after every run — injected into the next one.</span>
                {agent.memory.length > 0 && (
                  <button onClick={() => void clearMemory()} className="text-[10px] text-white/40 hover:text-red-300">clear all</button>
                )}
              </div>
              <div className="mt-4 space-y-2">
                {!agent.memory.length && <div className="text-xs text-white/35">Nothing learned yet — run the agent a couple of times.</div>}
                {agent.memory.map((m, i) => (
                  <div key={i} className="group flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
                    <span className="text-xs text-white/85">{m}</span>
                    <button onClick={() => void delMemory(i)} className="shrink-0 text-white/20 opacity-0 transition group-hover:opacity-100 hover:text-red-400" aria-label="Forget">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'knowledge' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/50">Distilled domain notes used in every run.</span>
                <button
                  onClick={() => void regather()}
                  disabled={gathering}
                  className="rounded-full border border-white/15 bg-white/10 px-4 py-1.5 font-mono-display text-[10px] uppercase tracking-wider text-white transition hover:bg-white/20 disabled:opacity-40"
                >
                  {gathering ? 'Gathering…' : 'Refresh knowledge'}
                </button>
              </div>

              {gatherProposal && (
                <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-4">
                  <div className="text-xs text-emerald-200/90">Proposed additions — review before applying:</div>
                  <div className="mt-2 space-y-1 text-[11px] text-white/70">
                    {gatherProposal.bundled.map((c) => <div key={c.id}>· skill: {c.name} (bundled)</div>)}
                    {gatherProposal.learned.map((c) => <div key={c.id}>· skill: {c.name} (learned)</div>)}
                    {gatherProposal.github.map((c) => <div key={c.id}>· skill: {c.name} ({c.sourceUrl})</div>)}
                    {gatherProposal.knowledge.map((n, i) => <div key={i}>· note: {n.note.slice(0, 100)}…</div>)}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => void applyGather()} className="rounded-full bg-emerald-400/20 px-4 py-1.5 text-[10px] text-emerald-200 hover:bg-emerald-400/30">Apply</button>
                    <button onClick={() => setGatherProposal(null)} className="rounded-full bg-white/10 px-4 py-1.5 text-[10px] text-white/60">Dismiss</button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {!agent.knowledge.length && <div className="rounded-xl border border-white/10 bg-white/[0.04] p-6 text-center text-xs text-white/40">No knowledge notes yet.</div>}
                {agent.knowledge.map((k, i) => (
                  <div key={i} className="group flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
                    <span className="text-xs text-white/85">{k}</span>
                    <button onClick={() => void delKnowledge(i)} className="shrink-0 text-white/20 opacity-0 transition group-hover:opacity-100 hover:text-red-400" aria-label="Remove note">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
