import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import * as keyVault from '../lib/keyVault'
import gsap from 'gsap'
import { motion, AnimatePresence } from 'framer-motion'
import {
  History,
  Trash2,
  Pencil,
  ChevronDown,
  Search,
  X,
  RefreshCw,
  Paperclip,
  Code2,
  Rocket,
  Layers,
  Palette,
  ImageIcon,
  ArrowUp,
  Cpu,
  Zap,
  Globe,
  Brain,
  PlugZap,
  Plus,
  Download,
  Mic,
  MicOff,
  Minus,
  Square,
  Eye,
  ExternalLink,
  FolderOpen,
  Play,
  Copy,
  Check,
  Monitor,
} from 'lucide-react'
import { useVoiceInput } from '../hooks/useVoiceInput'
import Switch from './Switch'
import { TextShimmer } from './ui/text-shimmer'
import { VSCodeWindow } from './ui/VSCodeWindow'
import { PermissionRequestDialog, InlinePermissionPrompt, ConfirmationDialog } from './ui/PermissionRequest'
import { DocumentEditor } from './ui/DocumentEditor'
import { ModelComparison } from './ui/ModelComparison'
import { ResearchWindow } from './ui/ResearchWindow'
import { ResearchProgress } from './ui/ResearchProgress'
import { FloatPanelTab } from './ui/FloatPanelTab'
import { FloatTopBarTab } from './ui/FloatTopBarTab'
import type { CatalogModel } from '../App'
import { mintVaultToken } from '../lib/vaultToken'
import { closestPeer } from '../lib/modelPeer'
import { storeCodeTask, downloadTaskZip, getCodeTask, loadCodeTasks, removeCodeTask, type StoredCodeTask } from '../lib/codeStorage'

// Words that appear in nearly every coding task (filenames, structure) and are
// useless as discriminators when matching a prompt against saved projects.
const EDIT_STOP_WORDS = new Set([
  'index', 'html', 'style', 'css', 'script', 'javascript', 'typescript', 'app',
  'file', 'files', 'project', 'website', 'page', 'web', 'js', 'ts', 'json',
  'edit', 'editing', 'update', 'change', 'modify', 'make', 'add', 'new',
  'section', 'button', 'buttons', 'menu', 'color', 'colors', 'font', 'text',
])

// Phrases that signal an intent to MODIFY existing work rather than build
// fresh. Fresh-build verbs (build/create/generate/make) are deliberately absent
// so "build a basketball scoreboard site" never edits a saved task that merely
// shares words with it.
const EDIT_INTENT_RE =
  /\b(edit|editing|update|change|modify|tweak|redo|rewrite|refactor|adjust|improve|extend|continue|fix|add|remove|replace|style|restyle|redesign|transform|revamp|theme)\b/i

// Best-effort match of a user prompt to one of their SAVED projects (the My
// Projects drawer). Strongest signal: the exact task title mentioned in the
// prompt; next: distinctive tokens from the prompt appearing in a task's file
// names or contents. Non-title matches need BOTH an edit-intent verb AND at
// least 2 distinctive hits (so "make me a portfolio site" never hijacks a
// saved project that mentions "portfolio"), and a tie between projects
// resolves to no match (ambiguous).
function findEditTargetTask(prompt: string, tasks: StoredCodeTask[]): StoredCodeTask | null {
  const p = prompt.toLowerCase()
  const words = p.split(/[^a-z0-9]+/).filter((w) => w.length >= 5 && !EDIT_STOP_WORDS.has(w))
  let best: StoredCodeTask | null = null
  let bestScore = 0
  let bestTitleHit = false
  let secondScore = 0
  for (const t of tasks) {
    const title = (t.title || '').toLowerCase().trim()
    const hay = [title, ...Object.keys(t.files || {})].join(' ').toLowerCase()
    const contentHay = (t.files ? Object.values(t.files) : []).join(' ').toLowerCase()
    let score = 0
    let titleHit = false
    if (title.length >= 3 && p.includes(title)) {
      score += 5 // exact title mention
      titleHit = true
    }
    for (const w of words) {
      if (hay.includes(w) || contentHay.includes(w)) score += 1
    }
    if (score > bestScore) {
      secondScore = bestScore
      bestScore = score
      best = t
      bestTitleHit = titleHit
    } else if (score > secondScore) {
      secondScore = score
    }
  }
  if (!best || bestScore < 2) return null
  if (!bestTitleHit && !EDIT_INTENT_RE.test(prompt)) return null
  if (!bestTitleHit && secondScore >= bestScore) return null
  return best
}

// ─── Interfaces & Types ──────────────────────────────────────────────────────
export interface ChatMessage {
  id?: string
  role: 'user' | 'assistant'
  text: string
  mode?: string
  reasoning?: string
  image?: string
  timestamp?: string
  modelUsed?: string
  researchSteps?: string[]
  interrupted?: boolean
}

export type ChatMode = 'normal' | 'thinking' | 'research' | 'coding' | 'image-gen'

export interface LearnedSkill {
  id: string
  name: string
  sourceUrl: string
  description: string
  keywords: string[]
  learnedAt: number
  model: string
}

export interface AttachedFile {
  id: string
  name: string
  type: string
  size: number
  content: string
  isImage: boolean
  previewUrl?: string
}

// ─── Sub-Component: SynthesisTimer ───────────────────────────────────────────

function SynthesisTimer({ initialSeconds = 25 }: { initialSeconds?: number }) {
  const [seconds, setSeconds] = useState(initialSeconds)
  useEffect(() => {
    const interval = setInterval(() => {
      setSeconds((prev) => (prev > 1 ? prev - 1 : 1))
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <span>
      {seconds > 1 ? `⏳ Synthesizing report… Estimated completion: ~${seconds}s remaining` : '⏳ Wrapping up synthesis…'}
    </span>
  )
}

// ─── Service Connections Component ───────────────────────────────────────────
function ServiceConnections() {
  const [connections, setConnections] = useState({
    gmail: false,
    calendar: false,
    drive: false,
  })
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    // Check connection status from backend
    fetch('/api/gmail/status')
      .then((r) => r.json())
      .then((data) => {
        setConnections({
          gmail: data.connected || false,
          calendar: data.connected || false,
          drive: false, // Drive status not yet implemented
        })
      })
      .catch(() => {
        // Silently fail - user may not have connected yet
      })
  }, [])

  const handleConnect = async (_service: 'gmail' | 'calendar' | 'drive') => {
    try {
      const response = await fetch(`/api/gmail/auth-url`)
      const data = await response.json()
      if (data.url) {
        const width = 500
        const height = 600
        const left = window.screenX + (window.outerWidth - width) / 2
        const top = window.screenY + (window.outerHeight - height) / 2
        const popup = window.open(
          data.url,
          'google-oauth',
          `width=${width},height=${height},left=${left},top=${top},popup=yes`
        )

        if (popup) {
          const checkClosed = setInterval(() => {
            if (popup.closed) {
              clearInterval(checkClosed)
              // Refresh connection status
              fetch('/api/gmail/status')
                .then((r) => r.json())
                .then((data) => {
                  setConnections((prev) => ({
                    ...prev,
                    gmail: data.connected || false,
                    calendar: data.connected || false,
                  }))
                })
            }
          }, 500)
        }
      }
    } catch (err) {
      console.error('Failed to get auth URL:', err)
    }
  }

  const handleDisconnect = async () => {
    try {
      // x-enzo-csrf is what makes this a non-simple CORS request, so the browser
      // must preflight it and index.ts's origin allowlist gets a say. Without the
      // header the server returns 403 (see requireSameSite in featureRoutes.ts).
      await fetch('/api/gmail/disconnect', { method: 'POST', headers: { 'x-enzo-csrf': '1' } })
      setConnections({ gmail: false, calendar: false, drive: false })
    } catch (err) {
      console.error('Failed to disconnect:', err)
    }
  }

  const connectedCount = Object.values(connections).filter(Boolean).length

  return (
    <div className="mobile-menu-glass rounded-2xl p-4 border border-white/10">
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="w-full flex items-center justify-between"
      >
        <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50">
          Services
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <div className={`w-2 h-2 rounded-full ${connectedCount > 0 ? 'bg-emerald-400' : 'bg-white/20'}`} />
            <span className="text-[10px] text-white/60">
              {connectedCount}/3
            </span>
          </div>
          <ChevronDown
            size={12}
            className={`text-white/40 transition-transform ${showDetails ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {showDetails && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="mt-3 space-y-2 pt-3 border-t border-white/10"
        >
          {[
            { id: 'gmail', label: 'Gmail', icon: '✉️' },
            { id: 'calendar', label: 'Calendar', icon: '📅' },
            { id: 'drive', label: 'Drive', icon: '📁' },
          ].map((service) => (
            <div
              key={service.id}
              className="flex items-center justify-between py-1.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm">{service.icon}</span>
                <span className="text-[11px] text-white/70">{service.label}</span>
              </div>
              {connections[service.id as keyof typeof connections] ? (
                <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                  Connected
                </span>
              ) : (
                <button
                  onClick={() => handleConnect(service.id as 'gmail' | 'calendar' | 'drive')}
                  className="text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
                >
                  Connect
                </button>
              )}
            </div>
          ))}

          {connectedCount > 0 && (
            <button
              onClick={handleDisconnect}
              className="w-full mt-2 py-1.5 text-[10px] text-rose-400/70 hover:text-rose-400 transition-colors border border-white/10 rounded-lg"
            >
              Disconnect All
            </button>
          )}
        </motion.div>
      )}
    </div>
  )
}

export interface ChatSession {
  id: string
  title: string
  model: string
  chatMode: string
  isImageSession: boolean
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  // Stable on-disk project container id for this session's coding work. Kept so
  // every save upserts the SAME folder and a "continue" extends the real files
  // instead of forking a new project. Survives reload via session persistence.
  projectId?: string
}

interface TerminalSectionProps {
  activeModel: CatalogModel
  setActiveModel: (m: CatalogModel) => void
  catalog?: CatalogModel[]
  onRefreshCatalog?: () => Promise<void> | void
  activeTab?: string
  setActiveTab?: (tab: 'marketplace' | 'terminal' | 'vault') => void
}

function ToggleSwitch({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between w-full text-left py-0.5">
      <span className="font-mono-display text-[10px] uppercase tracking-widest text-white/70">
        {label}
      </span>
      <Switch checked={value} onChange={onChange} />
    </div>
  )
}

// Categorization helper for catalog model sections
function getModelCategory(m: CatalogModel): 'text' | 'coding' | 'moe' | 'image-gen' | 'general' {
  const name = (m.name || '').toLowerCase()
  const desc = (m.description || '').toLowerCase()
  const tags = m.tags || []

  if (name.includes('moe') || desc.includes('moe') || name.includes('mixtral') || name.includes('expert') || name.includes('deepseek-v')) {
    return 'moe'
  }
  if (tags.includes('Image Gen') || m.type === 'image' || m.type === 'image-gen' || name.includes('flux') || name.includes('diffus') || name.includes('zimage')) {
    return 'image-gen'
  }
  if (tags.includes('Coding') || name.includes('code') || name.includes('coder') || desc.includes('coding') || desc.includes('programm')) {
    return 'coding'
  }
  if (tags.includes('Reasoning') || name.includes('think') || name.includes('reason') || name.includes('r1') || name.includes('o1') || name.includes('qwq') || name.includes('nemotron')) {
    return 'text'
  }
  if (tags.includes('General Chat') || m.type === 'text') {
    return 'general'
  }
  return 'general'
}

// Typewriter: types `text` out char-by-char after an optional `delay` (for
// sequencing several fields so the card reads like a person typing it).
function Typewriter({ text, speed = 11, delay = 0 }: { text: string; speed?: number; delay?: number }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    setCount(0)
    if (!text) return
    let tick: ReturnType<typeof setInterval>
    const start = setTimeout(() => {
      tick = setInterval(() => {
        setCount((c) => {
          if (c >= text.length) {
            clearInterval(tick)
            return c
          }
          return c + 1
        })
      }, speed)
    }, delay)
    return () => {
      clearTimeout(start)
      clearInterval(tick)
    }
  }, [text, speed, delay])
  return (
    <>
      {text.slice(0, count)}
      {count < text.length && <span className="animate-pulse text-white/40">▌</span>}
    </>
  )
}

// Deep per-model profile returned by the backend /api/model-info endpoint
// (web-sourced, refreshed daily). Fields may be empty when unknown.
interface ModelInfo {
  summary: string
  architecture: string
  context: string
  strengths: string[]
  weaknesses: string[]
  bestFor: string[]
  speed: string
  pricing: string
  benchmarks: string
  release: string
  sources: string[]
}

// Telemetry helper to return weaknesses, strengths and speed for tooltips
function getModelTelemetry(m: CatalogModel) {
  const id = m.id.toLowerCase()
  const name = m.name.toLowerCase()
  const provider = m.provider.toLowerCase()

  let speed = 'Medium Latency'
  let strengths = 'General discussion, writing, editing'
  let weaknesses = 'May struggle with advanced math or code'

  if (provider === 'groq') {
    speed = 'Ultra Fast (Sub-second response)'
  } else if (id.includes('8b') || id.includes('8x') || id.includes('mini') || id.includes('flash') || id.includes('nano')) {
    speed = 'Fast'
  } else if (m.type === 'image' || m.type === 'image-gen') {
    speed = 'Slow (Requires visual synthesis)'
  }

  if (id.includes('code') || id.includes('coder') || name.includes('coder')) {
    strengths = 'Advanced coding, scripting, debugging, algorithms'
    weaknesses = 'Poetic writing, conversational prose'
  } else if (id.includes('think') || id.includes('reason') || id.includes('r1') || id.includes('o1') || id.includes('o3') || id.includes('cot') || name.includes('think')) {
    strengths = 'Complex logic, math, multi-step planning, rigorous proofs'
    weaknesses = 'Conversational speed, higher thinking latency'
  } else if (m.type === 'image' || m.type === 'image-gen') {
    strengths = 'High-fidelity image generation, styling assets'
    weaknesses = 'Cannot process text conversational Q&A'
  } else if (id.includes('moe') || id.includes('mixtral') || id.includes('70b') || id.includes('v3')) {
    strengths = 'High-accuracy general reasoning, detailed answers'
    weaknesses = 'Higher context resource consumption'
  }

  return { speed, strengths, weaknesses }
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Compact status/latency chip for a model card row.
function modelHealthChip(m: CatalogModel): { text: string; cls: string; title: string } | null {
  const h = m.health
  if (!h) return null
  switch (h.status) {
    case 'online':
      return { text: formatLatency(h.latencyMs), cls: 'text-emerald-400', title: `online · checked ${timeAgo(h.checkedAt)}` }
    case 'degraded':
      return { text: `SLOW ${formatLatency(h.latencyMs)}`, cls: 'text-amber-400', title: `degraded (${h.latencyMs}ms) · checked ${timeAgo(h.checkedAt)}` }
    case 'offline':
      return { text: 'OFFLINE', cls: 'text-red-400', title: `offline (${h.error || 'unreachable'}) · checked ${timeAgo(h.checkedAt)}` }
    case 'n/a':
      return { text: 'N/A', cls: 'text-white/25', title: 'not probed (image generation)' }
    default:
      return null
  }
}

// No default greeting — start blank


interface MessageSegment {
  type: 'text' | 'code'
  content: string
  language?: string
}

function parseMessageText(text: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  const lines = text.split('\n')
  let inCodeBlock = false
  let currentLanguage = ''
  let currentContent: string[] = []
  let currentText: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        segments.push({
          type: 'code',
          content: currentContent.join('\n'),
          language: currentLanguage,
        })
        currentContent = []
        inCodeBlock = false
      } else {
        if (currentText.length > 0) {
          segments.push({
            type: 'text',
            content: currentText.join('\n'),
          })
          currentText = []
        }
        inCodeBlock = true
        const match = line.trim().match(/^```([a-zA-Z0-9+#-]+)/)
        currentLanguage = match ? match[1] : 'txt'
      }
    } else {
      if (inCodeBlock) {
        currentContent.push(line)
      } else {
        currentText.push(line)
      }
    }
  }

  if (inCodeBlock) {
    segments.push({
      type: 'code',
      content: currentContent.join('\n'),
      language: currentLanguage,
    })
  } else if (currentText.length > 0) {
    segments.push({
      type: 'text',
      content: currentText.join('\n'),
    })
  }

  return segments
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const regex = /(\*\*(.*?)\*\*)|(`([^`]+)`)|(https?:\/\/[^\s]+)|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match
  let keyIdx = 0

  while ((match = regex.exec(text)) !== null) {
    const textBefore = text.substring(lastIndex, match.index)
    if (textBefore) {
      parts.push(textBefore)
    }

    if (match[1]) { // Bold **text**
      parts.push(
        <strong key={keyIdx++} className="font-semibold text-white">
          {match[2]}
        </strong>
      )
    } else if (match[3]) { // Code `code`
      parts.push(
        <code key={keyIdx++} className="bg-white/10 px-1 py-0.5 rounded font-mono text-[11px] text-white">
          {match[4]}
        </code>
      )
    } else if (match[5]) { // URL
      parts.push(
        <a
          key={keyIdx++}
          href={match[5]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#34d399] underline underline-offset-2 hover:text-[#6ee7b7] transition-colors"
        >
          {match[5]}
        </a>
      )
    } else if (match[6]) { // Email
      parts.push(
        <a
          key={keyIdx++}
          href={`mailto:${match[6]}`}
          className="text-[#34d399] underline underline-offset-2 hover:text-[#6ee7b7] transition-colors"
        >
          {match[6]}
        </a>
      )
    }

    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex))
  }

  return parts
}

function renderMarkdownText(text: string) {
  const lines = text.split('\n')
  return lines.map((line, lineIdx) => {
    // 1. Heading 1
    if (line.startsWith('# ')) {
      return (
        <h1 key={lineIdx} className="text-lg font-bold font-mono-display text-white mt-4 mb-2 tracking-wide border-b border-white/10 pb-1">
          {renderInlineMarkdown(line.substring(2))}
        </h1>
      )
    }

    // 2. Heading 2
    if (line.startsWith('## ')) {
      return (
        <h2 key={lineIdx} className="text-base font-bold font-mono-display text-white/95 mt-3 mb-1.5 tracking-wide">
          {renderInlineMarkdown(line.substring(3))}
        </h2>
      )
    }

    // 3. Heading 3
    if (line.startsWith('### ')) {
      return (
        <h3 key={lineIdx} className="text-sm font-semibold font-mono-display text-white/80 mt-2.5 mb-1.5 tracking-wide">
          {renderInlineMarkdown(line.substring(4))}
        </h3>
      )
    }

    // 4. Bullet list items
    const trimmed = line.trim()
    const isBullet = trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')
    if (isBullet) {
      const cleanLine = trimmed.replace(/^[-*•]\s+/, '')
      return (
        <ul key={lineIdx} className="list-disc list-inside pl-4 text-white/70 text-[13px] leading-relaxed my-1">
          <li>{renderInlineMarkdown(cleanLine)}</li>
        </ul>
      )
    }

    // 5. Standard line
    return (
      <p key={lineIdx} className="min-h-[1.4em] leading-relaxed text-white/70 text-[13.5px] whitespace-pre-wrap break-words">
        {renderInlineMarkdown(line)}
      </p>
    )
  })
}

function renderMessageContent(text: string) {
  const imgMatch = text.match(/!\[([^\]]*)\]\(([^)]+)\)/)
  if (imgMatch) {
    const caption = imgMatch[1] || 'Generated Image'
    const src = imgMatch[2]
    return (
      <div className="mt-1 group relative border border-white/[0.08] rounded-2xl overflow-hidden bg-black/30 shadow-2xl max-w-[380px] select-none">
        <img src={src} alt={caption} className="w-full h-auto object-cover max-h-[320px] transition-transform duration-700 group-hover:scale-[1.02]" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-400 p-4 flex items-end">
          <div className="flex gap-2">
            <a href={src} download="enzo.png" className="rounded-full bg-white/90 px-3 py-1.5 text-[10px] font-sans font-semibold text-black hover:bg-white cursor-pointer">Download</a>
            <button type="button" onClick={() => navigator.clipboard.writeText(src)} className="rounded-full bg-white/10 border border-white/20 px-3 py-1.5 text-[10px] font-sans text-white hover:bg-white/20 cursor-pointer">Copy URI</button>
          </div>
        </div>
      </div>
    )
  }

  const segments = parseMessageText(text)

  return (
    <div className="space-y-3">
      {segments.map((seg, idx) => {
        if (seg.type === 'code') {
          return <VSCodeWindow key={idx} code={seg.content} language={seg.language || 'txt'} />
        }

        return (
          <div key={idx} className="space-y-1">
            {renderMarkdownText(seg.content)}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Pull a live-previewable HTML document out of an assistant reply.
 * Accepts a ```html fence (the common coding-mode shape) or a bare document,
 * but only when it actually looks like a real page — small inline snippets and
 * non-HTML code blocks are ignored so we never open a preview for e.g. a
 * python script.
 */
function extractPreviewHtml(text: string): string | null {
  if (!text || typeof text !== 'string') return null
  const fence = text.match(/```(?:html|HTML)\s*\n([\s\S]*?)```/)
  const body = (fence ? fence[1] : text).trim()
  if (!body) return null

  const lower = body.toLowerCase()
  const isDocument =
    lower.includes('<!doctype html') ||
    lower.includes('<html') ||
    lower.includes('<body') ||
    lower.includes('</body>') ||
    lower.includes('</html>') ||
    (lower.includes('</') && (lower.includes('<style') || lower.includes('<script') || lower.includes('<header') || lower.includes('<nav') || lower.includes('<main') || lower.includes('<section')))
  if (!isDocument) return null
  if (body.length < 120 && !lower.includes('<!doctype') && !lower.includes('<html')) return null

  return body
}

/**
 * Extract a multi-file project from a coding reply. The model emits one fence
 * per file using the path as its label:
 *   ```file:index.html ... ```
 *   ```file:css/styles.css ... ```
 *   ```file:js/app.js ... ```
 * Returns { "path": content } or null when no ```file: blocks are present.
 *
 * `salvage` (used when a reply is FINALIZED — stream end or user stop)
 * rescues the LAST file fence when generation was cut mid-file: its partial
 * content is kept instead of silently dropped, so an interrupted build never
 * loses the file it was writing. A later "continue" overwrites it with the
 * completed version.
 */
function extractProjectFiles(text: string, salvage = false): Record<string, string> | null {
  if (!text || typeof text !== 'string') return null
  const files: Record<string, string> = {}
  const re = /```file:([^\n]+?)\s*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const p = m[1].trim().replace(/^\/+/, '').replace(/\\/g, '/')
    if (!p || p.includes('..') || p.length > 200) continue
    files[p] = m[2].replace(/\n+$/, '')
  }
  if (salvage) {
    // Find the last ```file: opener and check whether it ever closed.
    const openers = Array.from(text.matchAll(/```file:([^\n]+?)\s*\n/g))
    const last = openers[openers.length - 1]
    if (last && last.index !== undefined) {
      const contentStart = last.index + last[0].length
      const after = text.slice(contentStart)
      const closerIdx = after.indexOf('\n```')
      if (closerIdx === -1) {
        // Unterminated final fence → generation was cut inside this file.
        const p = last[1].trim().replace(/^\/+/, '').replace(/\\/g, '/')
        const partial = after.replace(/\n+$/, '')
        if (p && !p.includes('..') && p.length <= 200 && partial.trim().length > 0) {
          files[p] = partial
        }
      }
    }
  }
  return Object.keys(files).length >= 1 ? files : null
}

/**
 * Frontend twin of the server's codingReplyIncompleteReason: is a finished
 * coding reply still structurally incomplete (open fence, missing referenced
 * css/js, no closing </html>, an empty file)? Returns a reason or '' when whole.
 * Drives the browser auto-continue safety net so a build that ends short gets
 * "continue" re-sent automatically instead of the user typing it.
 */
function codingReplyIncompleteReason(text: string): string {
  if (!text) return ''
  const openers = (text.match(/^```[^`\s][^\n]*$/gm) || []).length
  const closers = (text.match(/^```\s*$/gm) || []).length
  if (openers > closers) return 'an open code fence was never closed'
  const files = extractProjectFiles(text)
  if (!files) return ''
  const paths = new Set(Object.keys(files))
  const indexKey = Object.keys(files).find((p) => p === 'index.html' || p.endsWith('/index.html'))
  if (indexKey) {
    const html = files[indexKey]
    if (!/<\/html\s*>/i.test(html)) return 'index.html has no closing </html> tag'
    if (!/<\/body\s*>/i.test(html)) return 'index.html has no closing </body> tag'
    const refs = [...html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((r) => r && !/^(?:https?:|data:|#|mailto:|\/\/)/i.test(r))
      .map((r) => r.replace(/^\.?\//, '').split(/[?#]/)[0])
    for (const ref of refs) {
      if (/\.(?:css|js|mjs)$/i.test(ref) && !paths.has(ref)) return `references ${ref} which was not emitted yet`
    }
  }
  for (const [p, content] of Object.entries(files)) {
    if (content.trim().length === 0) return `file ${p} is empty`
  }
  return ''
}



export default function TerminalSection({
  activeModel,
  setActiveModel,
  catalog = [],
  onRefreshCatalog,
  activeTab,
  setActiveTab,
}: TerminalSectionProps) {
  const isImageActive =
    activeModel.type === 'image' ||
    activeModel.type === 'image-gen' ||
    activeModel.tags?.includes('Image Gen') ||
    activeModel.id.startsWith('pollinations/') ||
    activeModel.id.toLowerCase().includes('flux') ||
    activeModel.id.toLowerCase().includes('zimage')

  // History key for legacy compatibility
  const HISTORY_KEY = 'enzo.terminal.history'
  const SESSIONS_KEY = 'enzo.chat.v3.sessions'
  // Last-active session id — lets us restore the previous conversation on the
  // next visit, even weeks/months later, regardless of which model is selected.
  const ACTIVE_SESSION_KEY = 'enzo.chat.v3.active-session'

  // Sessions state for History drawer & multi-session support
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      const saved = localStorage.getItem(SESSIONS_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      }
    } catch {
      /* ignore */
    }
    return []
  })

  const [activeSessionId, setActiveSessionId] = useState<string>('')

  // Messages state — fresh on boot; restored later from localStorage
  const [messages, setMessages] = useState<ChatMessage[]>([])

  // ResearchWindow ids closed by the user (X) — those render as plain content.
  const [dismissedWindows, setDismissedWindows] = useState<string[]>([])

  // Terminal window chrome — Claude-style mac traffic-light controls.
  const [termMaximized, setTermMaximized] = useState(false)
  const [termMinimized, setTermMinimized] = useState(false)
  // True while the maximized portal should be in the DOM (also covers its exit tween).
  const [maxShown, setMaxShown] = useState(false)
  // Overview panel inside the maximized view — collapsed by default, summoned
  // by the floating FloatPanelTab (separate from the traffic lights), and it
  // auto-dismisses after 5s without interaction.
  const [maxPanelOpen, setMaxPanelOpen] = useState(false)
  const termDockedRef = useRef<HTMLDivElement>(null)
  const maxRootRef = useRef<HTMLDivElement>(null)
  const maxPanelRef = useRef<HTMLDivElement>(null)
  // Header drawer (Terminal / Marketplace / Vault nav) inside the maximized
  // view — same open/close pattern as the overview panel.
  const [maxHeaderOpen, setMaxHeaderOpen] = useState(false)
  const maxHeaderRef = useRef<HTMLDivElement>(null)

  // Escape exits the fullscreen terminal.
  useEffect(() => {
    if (!termMaximized) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTermMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [termMaximized])

  // GSAP entrance for the maximized portal (scale + rise).
  useLayoutEffect(() => {
    const el = maxRootRef.current
    if (!maxShown || !el) return
    gsap.fromTo(
      el,
      { opacity: 0, scale: 0.9, y: 28, filter: 'blur(6px)' },
      { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', duration: 0.5, ease: 'power3.out' },
    )
  }, [maxShown])

  // Overview panel comes up collapsed every time the fullscreen terminal opens.
  useLayoutEffect(() => {
    if (maxShown) setMaxPanelOpen(false)
  }, [maxShown])

  // GSAP slide for the overview panel (0 ↔ 240px).
  useLayoutEffect(() => {
    const el = maxPanelRef.current
    if (!el) return
    if (maxPanelOpen) {
      gsap.to(el, { width: 240, duration: 0.35, ease: 'power2.out', overwrite: 'auto' })
    } else {
      gsap.to(el, { width: 0, duration: 0.3, ease: 'power2.in', overwrite: 'auto' })
    }
  }, [maxPanelOpen])

  // Auto-dismiss: 5s after the panel opens it slides shut again.
  useEffect(() => {
    if (!maxPanelOpen) return
    const t = window.setTimeout(() => setMaxPanelOpen(false), 5000)
    return () => window.clearTimeout(t)
  }, [maxPanelOpen])

  // Header drawer comes up closed every time the fullscreen terminal opens.
  useLayoutEffect(() => {
    if (maxShown) setMaxHeaderOpen(false)
  }, [maxShown])

  // GSAP slide for the header drawer (0 ↔ ~56px).
  useLayoutEffect(() => {
    const el = maxHeaderRef.current
    if (!el) return
    if (maxHeaderOpen) {
      gsap.to(el, { height: 56, duration: 0.35, ease: 'power2.out', overwrite: 'auto' })
    } else {
      gsap.to(el, { height: 0, duration: 0.3, ease: 'power2.in', overwrite: 'auto' })
    }
  }, [maxHeaderOpen])

  // Auto-dismiss: 5s after the header opens it slides shut again.
  useEffect(() => {
    if (!maxHeaderOpen) return
    const t = window.setTimeout(() => setMaxHeaderOpen(false), 5000)
    return () => window.clearTimeout(t)
  }, [maxHeaderOpen])

  // GSAP exit for the maximized portal; unmounts only after the tween finishes.
  useLayoutEffect(() => {
    if (termMaximized) {
      setMaxShown(true)
    } else if (maxShown) {
      const el = maxRootRef.current
      if (el) {
        gsap.to(el, {
          opacity: 0,
          scale: 0.92,
          y: 20,
          filter: 'blur(6px)',
          duration: 0.26,
          ease: 'power3.in',
          onComplete: () => setMaxShown(false),
        })
      } else {
        setMaxShown(false)
      }
    }
  }, [termMaximized, maxShown])

  // GSAP minimize for the docked terminal: fade + collapse, then tuck it away.
  useLayoutEffect(() => {
    const el = termDockedRef.current
    if (!el) return
    if (termMinimized) {
      gsap.to(el, {
        height: 0,
        opacity: 0,
        duration: 0.34,
        ease: 'power2.in',
        overwrite: 'auto',
        onComplete: () => {
          el.style.visibility = 'hidden'
        },
      })
    } else {
      el.style.visibility = ''
      gsap.fromTo(
        el,
        { height: 0, opacity: 0 },
        { height: 600, opacity: 1, duration: 0.4, ease: 'power3.out', overwrite: 'auto' },
      )
    }
  }, [termMinimized])

  // Input & Modes
  const [inputValue, setInputValue] = useState('')
  const [chatMode, setChatMode] = useState<'normal' | 'thinking' | 'research' | 'coding' | 'image-gen'>('normal')
  const [webSearch, setWebSearch] = useState(false)
  const [autoFallback, setAutoFallback] = useState(true)
  const [isIncognito, setIsIncognito] = useState(false)
  const [isRoasting, setIsRoasting] = useState(false)

  // Research depth dialog — appears in normal mode when a research-intent query
  // is detected. User picks surface search (stays normal) or deep research (switches mode).
  const [researchPromptDialog, setResearchPromptDialog] = useState<{
    show: boolean
    pendingMessage: string
  } | null>(null)

  // Auto mode (per-message): the backend LLM decides the best execution mode
  // (normal/thinking/research/coding) for this message. We only reflect what
  // actually ran — the user's mode toggle is never mutated.
  const [autoRoutedMode, setAutoRoutedMode] = useState<string | null>(null)
  const autoRoutedModeRef = useRef<string | null>(null)

  // Live code-preview: when a coding reply
  // contains a full HTML page it is registered on the backend and rendered in
  // a right-hand side panel; the same URL opens full-screen in a new tab.
  // Multi-file projects (```file:path blocks) save on disk and preview as a
  // real project with a file-tree strip.
  const [preview, setPreview] = useState<{
    id: string
    url: string
    title: string
    isProject?: boolean
    files?: { path: string; size: number }[]
  } | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewCopied, setPreviewCopied] = useState(false)
  const [previewFrameKey, setPreviewFrameKey] = useState(0)
  const previewPostAtRef = useRef(0)
  const previewPostedHtmlRef = useRef<string | null>(null)
  const previewLatestHtmlRef = useRef<string | null>(null)
  // Set when the user manually closes the panel; auto-open stays suppressed
  // for the rest of that turn so a newer throttle frame doesn't yank it back.
  const previewDismissedRef = useRef(false)
  // Auto-continue safety net: when a coding reply's SSE fully closes but the
  // project is still incomplete (server hit its round budget / provider dropped),
  // the browser re-sends "continue" itself, up to MAX_AUTO_CONTINUE times, so the
  // user never has to type it. Reset on every real user message.
  const forcedPromptRef = useRef<string | null>(null)
  const autoContinueCountRef = useRef(0)
  const MAX_AUTO_CONTINUE = 5
  const [autoContinuing, setAutoContinuing] = useState(false)
  // Stable on-disk project container id for the active session. Every project
  // save sends this so it upserts ONE folder instead of forking a new one each
  // time, and a "continue" turn extends the real files. Synced from the active
  // session below so it follows session switches / restores.
  const sessionProjectIdRef = useRef<string>('')
  // Serializes project saves. Streaming fires saves repeatedly (throttled) and
  // the finish save bypasses the throttle — without chaining, the first (id-less)
  // save could still be in flight when the next reads the id, minting a second
  // folder. Each save awaits the prior so the id is pinned before the next runs.
  const projectSaveChainRef = useRef<Promise<unknown>>(Promise.resolve())

  // Image Gen options
  const [imageAspect, setImageAspect] = useState('1:1')
  const [imageNegative, setImageNegative] = useState('')
  const [imageUncensored, setImageUncensored] = useState(false)
  const [imageModel, setImageModel] = useState('flux')
  const [imageQuality, setImageQuality] = useState('fhd')
  const [imageSeed, setImageSeed] = useState('')

  // Streaming & UI states
  const [isStreaming, setIsStreaming] = useState(false)
  const [researchSteps, setResearchSteps] = useState<string[]>([])
  // Expandable "Working…" ledger — collapsed by default so it just shows the
  // working text; clicking the arrow expands it to reveal the explored pages.
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [thoughtChain, setThoughtChain] = useState<string>('')
  const [streamedText, setStreamedText] = useState('')
  // Auto-retry status: the backend hit a provider rate-limit mid-build and is
  // waiting out the cooldown before resuming the stream from where it stopped.
  const [retryInfo, setRetryInfo] = useState<{ provider: string; etaSec: number; cycle: number; status?: string } | null>(null)
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false)
  const [historyTab, setHistoryTab] = useState<'text' | 'image'>('text')
  // "My Projects" drawer: lists every coding task mirrored to localStorage
  // (codeStorage) with open-in-tab / run / zip / delete. Refreshed on open.
  const [showProjectsDrawer, setShowProjectsDrawer] = useState(false)
  // Editing banner: set when the user picks "Edit" on a saved project — tells
  // the user the next coding request will target that project's real files.
  const [editNotice, setEditNotice] = useState<{ title: string } | null>(null)
  const [projectList, setProjectList] = useState<StoredCodeTask[]>([])
  const [historySearch, setHistorySearch] = useState('')
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const modelSearchRef = useRef<HTMLInputElement | null>(null)
  const [historyIndex, setHistoryIndex] = useState(-1)
  // Abort controller for the in-flight chat stream — lets the send button
  // become a Stop button that cancels generation (like real AI platforms).
  const abortRef = useRef<AbortController | null>(null)

  // Learned skills dropdown (/skills)
  const [showSkillsPanel, setShowSkillsPanel] = useState(false)
  const [skillsList, setSkillsList] = useState<LearnedSkill[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState('')
  const [skillsRefresh, setSkillsRefresh] = useState(false)
  const [skillsImporting, setSkillsImporting] = useState(false)

  // File Attachment & Drag-and-Drop state
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [downloadingPDF, setDownloadingPDF] = useState<number | null>(null)

  // ── Permission & Feature Dialog States ────────────────────────────────
  const [permissionDialog, setPermissionDialog] = useState<{
    isOpen: boolean
    service: 'gmail' | 'calendar' | 'drive' | 'google'
    authUrl?: string
  }>({ isOpen: false, service: 'google' })

  const [inlinePermission, setInlinePermission] = useState<{
    show: boolean
    service: 'gmail' | 'calendar' | 'drive'
    authUrl: string
  } | null>(null)

  const [confirmationDialog, setConfirmationDialog] = useState<{
    isOpen: boolean
    title: string
    description: string
    actionLabel: string
    details?: Record<string, string>
    onConfirm: () => void
  } | null>(null)

  const [documentEditor, setDocumentEditor] = useState<{
    isOpen: boolean
    content: string
    instruction?: string
  }>({ isOpen: false, content: '' })

  const [modelComparison, setModelComparison] = useState<{
    isOpen: boolean
  }>({ isOpen: false })

  // Pending tool confirmation state (for future use)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_pendingToolConfirmation, setPendingToolConfirmation] = useState<{
    toolName: string
    args: any
    message: string
  } | null>(null)

  // ── Voice input (Web Speech API, Google/Apple cloud STT) ─────────────
  const voice = useVoiceInput()
  const voiceBaselineRef = useRef('')

  // Live merge voice transcript into the textarea: baseline + final + interim.
  useEffect(() => {
    if (!voice.isListening) return
    const base = voiceBaselineRef.current
    const needsSpace = base.length > 0 && !base.endsWith(' ')
    const final = voice.finalText ? (needsSpace ? ' ' : '') + voice.finalText : ''
    const needsSpaceAfterFinal = final && !final.endsWith(' ')
    const interim =
      voice.interimText
        ? (final ? (needsSpaceAfterFinal ? ' ' : '') : needsSpace ? ' ' : '') + voice.interimText
        : ''
    setInputValue(base + final + interim)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.isListening, voice.finalText, voice.interimText])

  const startVoice = () => {
    voiceBaselineRef.current = inputValue
    voice.reset()
    voice.start()
  }
  const stopVoice = () => {
    voice.stop()
    const base = voiceBaselineRef.current
    const needsSpace = base.length > 0 && !base.endsWith(' ')
    const final = voice.finalText ? (needsSpace ? ' ' : '') + voice.finalText : ''
    const needsSpaceAfterFinal = final && !final.endsWith(' ')
    const interim =
      voice.interimText
        ? (final ? (needsSpaceAfterFinal ? ' ' : '') : needsSpace ? ' ' : '') + voice.interimText
        : ''
    const tail = final + interim
    if (tail) setInputValue(base + tail)
  }

  const handleDownloadPDF = async (text: string, index: number) => {
    setDownloadingPDF(index)
    try {
      const response = await fetch('/api/download-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `ENZO_Research_Report_${index}`,
          markdown: text,
        }),
      })
      if (!response.ok) throw new Error('PDF generation failed')
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ENZO_Research_Report_${index}.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err: any) {
      alert(`Could not download PDF: ${err.message}`)
    } finally {
      setDownloadingPDF(null)
    }
  }

  // Only surface the "Download PDF" export on responses that are actually worth
  // saving as a report: research-mode replies, turns where research actually ran
  // (steps captured), or substantive structured long-form answers. Short casual
  // replies (chat, mode toggles, commands) and raw code dumps never show it.
  const shouldShowDownloadPDF = (m: ChatMessage): boolean => {
    if (m.role !== 'assistant') return false
    if (m.interrupted) return false
    if (m.mode === 'research') return true
    if (m.researchSteps && m.researchSteps.length > 0) return true
    const text = (m.text || '').trim()
    if (text.length < 600) return false
    // Substantive content worth exporting — require report-like markdown
    // structure (headings, lists, tables, bold sections). A long plain-text
    // paragraph or code dump without that structure gets no PDF button.
    const hasStructure =
      /(^|\n)(#{1,3}\s|\d+\.\s|[-*]\s|\*\*|__|>\s|table)/m.test(text) &&
      /(^|\n)(#{1,3}\s|\d+\.\s|[-*]\s|>\s)/m.test(text)
    return hasStructure && (text.length >= 600)
  }

  // True when a message is genuine research output — display it inside the
  // Windows-exe style ResearchWindow popup instead of a plain chat bubble.
  // A message only counts as research when it actually researched (recorded
  // steps) or produced a substantive structured report. Interrupted (Stop)
  // partial drafts and short/general replies in research mode must NEVER
  // render inside the popup — they stay as plain bubbles.
  const isResearchMessage = (m: ChatMessage): boolean => {
    if (m.role !== 'assistant') return false
    if (m.interrupted) return false
    if (m.researchSteps && m.researchSteps.length > 0) return true
    if (m.mode === 'research') {
      const text = (m.text || '').trim()
      // Substantive structured research report (headings/lists + length) even
      // if the steps ledger was empty — but not a short general reply.
      const hasStructure =
        /(^|\n)(#{1,3}\s|\d+\.\s|[-*]\s|>\s|##|Key Takeaways)/m.test(text) &&
        text.length >= 500
      return hasStructure
    }
    return false
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const processFiles = (files: FileList | File[]) => {
    const fileArray = Array.from(files)
    fileArray.forEach((file) => {
      const isImage = file.type.startsWith('image/')
      const fileId = `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`

      if (isImage) {
        const reader = new FileReader()
        reader.onload = (e) => {
          const result = e.target?.result as string
          if (result) {
            setAttachedFiles((prev) => [
              ...prev,
              {
                id: fileId,
                name: file.name,
                type: file.type,
                size: file.size,
                content: result,
                isImage: true,
                previewUrl: result,
              },
            ])
          }
        }
        reader.readAsDataURL(file)
      } else {
        const reader = new FileReader()
        reader.onload = (e) => {
          const result = (e.target?.result as string) || ''
          setAttachedFiles((prev) => [
            ...prev,
            {
              id: fileId,
              name: file.name,
              type: file.type || 'text/plain',
              size: file.size,
              content: result,
              isImage: false,
            },
          ])
        }
        reader.readAsText(file)
      }
    })
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files)
      e.target.value = ''
    }
  }

  const removeAttachment = (id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragging) setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files)
    }
  }

  // Return all catalog models so user can view/select them and configure missing keys if needed
  const availableCatalog = useMemo(() => {
    return catalog
  }, [catalog])

  // Recommended & Hovered model details for premium categorized catalog picker
  const [recommendedModel, setRecommendedModel] = useState<CatalogModel | null>(null)
  const [recommendationReason, setRecommendationReason] = useState<string>('')
  const [hoveredModel, setHoveredModel] = useState<CatalogModel | null>(null)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [liveInfo, setLiveInfo] = useState<{ id: string; info: ModelInfo } | null>(null)

  // Fetch the user's learned skills into the /skills dropdown panel.
  // Requires a vault session token (proves the browser already holds a provider key).
  const loadSkillsPanel = useCallback(async () => {
    setShowSkillsPanel(true)
    setSkillsLoading(true)
    setSkillsError('')
    try {
      const token = await mintVaultToken()
      const headers: Record<string, string> = {}
      if (token) headers['x-vault-token'] = token
      const res = await fetch('/api/skills', { headers })
      if (!res.ok) {
        setSkillsError(`Vault access required (HTTP ${res.status}). Add a provider key in the Vault tab.`)
        setSkillsList([])
        return
      }
      const data = await res.json()
      setSkillsList(Array.isArray(data?.skills) ? data.skills : [])
    } catch (err) {
      console.error('Failed to load skills:', err)
      setSkillsError('Failed to load skills. Is the backend on port 5001?')
      setSkillsList([])
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  const unlearnSkill = useCallback(async (id: string) => {
    try {
      const token = await mintVaultToken()
      const headers: Record<string, string> = {}
      if (token) headers['x-vault-token'] = token
      const res = await fetch(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE', headers })
      if (res.ok) {
        setSkillsList((prev) => prev.filter((s) => s.id !== id))
      } else {
        console.error('Unlearn failed:', res.status)
      }
    } catch (err) {
      console.error('Unlearn failed:', err)
    }
  }, [])

  // Bulk-import the bundled Claude Code skills from awesome-claude-skills (many
  // <dir>/SKILL.md modules) via the backend, then refresh the dropdown.
  const importAwesomeSkills = useCallback(async () => {
    setSkillsImporting(true)
    setSkillsError('')
    try {
      const token = await mintVaultToken()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['x-vault-token'] = token
      const res = await fetch('/api/skills/import', {
        method: 'POST',
        headers,
        body: JSON.stringify({ repoUrl: 'https://github.com/ComposioHQ/awesome-claude-skills' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSkillsError(data?.message || `Import failed (HTTP ${res.status}).`)
        return
      }
      if (data?.success && data?.imported > 0) {
        setSkillsError('')
        await loadSkillsPanel()
      } else {
        setSkillsError(data?.imported === 0 ? 'All awesome-claude-skills modules are already learned.' : 'Import returned no new skills.')
      }
    } catch (err) {
      console.error('Skill import failed:', err)
      setSkillsError('Skill import failed. Is the backend on port 5001?')
    } finally {
      setSkillsImporting(false)
    }
  }, [loadSkillsPanel])

  // On hover, pull a deep, web-sourced (daily-refreshed) profile for this exact
  // model from the backend — covers models from every provider.
  useEffect(() => {
    if (!hoveredModel) return
    const m = hoveredModel
    setLiveInfo(null)
    let cancelled = false
    const t = setTimeout(() => {
      fetch('/api/model-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: m.id, name: m.name, provider: m.provider,
          keys: {
            groq: keyVault.getItem('enzo.keys.groq') || '',
            openrouter: keyVault.getItem('enzo.keys.openrouter') || keyVault.getItem('enzo-openrouter-key') || '',
            exa: keyVault.getItem('enzo.keys.exa') || '',
          },
        }),
      })
        .then((r) => (r.ok ? r.json() : { info: null }))
        .then((j) => {
          if (!cancelled && j.info) setLiveInfo({ id: m.id, info: j.info })
        })
        .catch(() => {})
    }, 250) // debounce quick hovers
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [hoveredModel])

  useEffect(() => {
    if (!showModelPicker || availableCatalog.length === 0) return

    // 1. Local fast heuristic recommendation based on user chat history
    const userMessages = messages.filter((m) => m.role === 'user')
    const lastMsgText = userMessages.length > 0 ? userMessages[userMessages.length - 1].text.toLowerCase() : ''

    if (!lastMsgText) {
      // Empty session: no task to route on, so stay in the user's power class.
      const defaultModel = closestPeer(availableCatalog, activeModel) || availableCatalog[0]
      setRecommendedModel(defaultModel)
      setRecommendationReason(
        activeModel
          ? `Same power class as ${activeModel.name} — a balanced start for a fresh session.`
          : 'Best balanced model for starting a new chat session.',
      )
      return
    }

    let localRecId = ''
    let localReason = ''
    let localIsImage = false

    if (/\b(code|coding|python|js|ts|javascript|typescript|react|html|css|sql|function|bug|compile|debug)\b/.test(lastMsgText)) {
      const codeModel = closestPeer(
        availableCatalog.filter((m) => m.tags?.includes('Coding') || m.name.toLowerCase().includes('code') || m.name.toLowerCase().includes('coder')),
        activeModel,
      )
      if (codeModel) {
        localRecId = codeModel.id
        localReason = 'Recommended for programming & software engineering tasks based on your request.'
      }
    } else if (/\b(image|draw|paint|picture|generate image|photo|art|portrait)\b/.test(lastMsgText)) {
      const imgModel = availableCatalog.find((m) => m.type === 'image' || m.type === 'image-gen' || m.tags?.includes('Image Gen'))
      if (imgModel) {
        localRecId = imgModel.id
        localReason = 'Recommended for visual synthesis and image generation based on your query.'
        localIsImage = true
      }
    } else if (/\b(think|thinking|math|reason|logic|r1|explain|why|complex|solve|physics)\b/.test(lastMsgText)) {
      const reasonModel = closestPeer(
        availableCatalog.filter((m) => m.tags?.includes('Reasoning') || m.name.toLowerCase().includes('r1') || m.name.toLowerCase().includes('think')),
        activeModel,
      )
      if (reasonModel) {
        localRecId = reasonModel.id
        localReason = 'Recommended for complex logical reasoning, math, or step-by-step planning.'
      }
    }

    if (localRecId) {
      const found = availableCatalog.find((m) => m.id === localRecId)
      if (found) {
        setRecommendedModel(found)
        setRecommendationReason(localReason)
      }
    } else {
      const generalModel = closestPeer(availableCatalog, activeModel) || availableCatalog[0]
      setRecommendedModel(generalModel)
      setRecommendationReason(
        activeModel
          ? `Closest all-rounder to ${activeModel.name} at the same power level.`
          : 'Recommended as the best all-rounder model for general queries.',
      )
    }

    // 2. Refine via /api/recommend — the same picker LLM the backend uses for
    //    auto-fallback, anchored to the model the user is currently on so the
    //    suggestion is a peer instead of whatever the prompt hardcoded.
    //    Skipped for image tasks: the backend's candidate list is chat-only, so
    //    it would override a correct local image pick with a text model.
    if (localIsImage) return

    fetch('/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: lastMsgText, currentModel: activeModel?.id || '' })
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.recommendations && data.recommendations.length > 0) {
          const first = data.recommendations[0]
          const normalizedRecId = String(first.id).toLowerCase()
          const matched = availableCatalog.find((m) => {
            const mId = m.id.toLowerCase()
            const mName = m.name.toLowerCase()
            return mId.includes(normalizedRecId) || mName.includes(normalizedRecId)
          })
          if (matched) {
            setRecommendedModel(matched)
            setRecommendationReason(first.reason || 'AI suggested this model based on your prompt details.')
          }
        }
      })
      .catch((err) => console.warn('Backend recommendation error:', err))
  }, [showModelPicker, messages, availableCatalog, activeModel])

  const messagesContainerRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const userCmds = messages.filter((m) => m.role === 'user').map((m) => m.text)
      if (userCmds.length === 0) return
      const newIdx = Math.min(historyIndex + 1, userCmds.length - 1)
      setHistoryIndex(newIdx)
      setInputValue(userCmds[userCmds.length - 1 - newIdx] || '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const userCmds = messages.filter((m) => m.role === 'user').map((m) => m.text)
      if (userCmds.length === 0) return
      const newIdx = Math.max(historyIndex - 1, -1)
      setHistoryIndex(newIdx)
      setInputValue(newIdx === -1 ? '' : userCmds[userCmds.length - 1 - newIdx] || '')
    } else if (e.key === 'Escape') {
      setInputValue('')
      setHistoryIndex(-1)
    }
  }

  // Sync sessions to localStorage
  useEffect(() => {
    if (typeof window === 'undefined' || isIncognito) return
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
    } catch {
      /* ignore */
    }
  }, [sessions, isIncognito])

  // Sync legacy history to localStorage
  useEffect(() => {
    if (typeof window === 'undefined' || isIncognito) return
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(messages))
    } catch {
      /* ignore */
    }
  }, [messages, isIncognito])

  // Auto-scroll on new messages
  useEffect(() => {
    const el = messagesContainerRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, isStreaming, researchSteps, thoughtChain, streamedText])

  // Auto-retry countdown: ticks the ETA down while the backend waits out a
  // provider cooldown before resuming the paused stream.
  useEffect(() => {
    if (!retryInfo) return
    const timer = setInterval(() => {
      setRetryInfo((prev) => {
        if (!prev) return prev
        if (prev.etaSec <= 1) return null // stream resumes now (or a fresh retry event arrives)
        return { ...prev, etaSec: prev.etaSec - 1 }
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [retryInfo])

  // Tracks which model the current session was minted/restored for. Used instead
  // of a module-level flag so the boot logic is StrictMode-safe (dev double-runs
  // effects): the same model id on a re-run is a no-op, a changed id means the
  // user explicitly switched models, and a fresh mount restores the last chat.
  const initModelRef = useRef<string | null>(null)
  // Tracks the last *chat* model so we can restore it when leaving image-gen mode.
  const prevChatModelRef = useRef<CatalogModel | null>(null)
  // Tracks the last *text-chat state* (session id + messages) so leaving
  // image-gen returns to the exact conversation that was paused, not a fresh one.
  const prevChatSessionRef = useRef<{ id: string | null; messages: ChatMessage[]; chatMode: string } | null>(null)
  // Ref to the composer textarea so its height can be managed from an effect
  // (React resets .value on re-render but leaves the manually-set inline height,
  // which is what made the box stay expanded after sending a long prompt).
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // When true, the next handleSend call skips the research intent intercept
  // (used by the ResearchDepthDialog after the user has already made a choice).
  const skipResearchCheckRef = useRef(false)

  // Ensure an active session exists
  useEffect(() => {
    if (!activeModel) return
    const isImg = isImageActive

    const lastInit = initModelRef.current
    initModelRef.current = activeModel.id

    // Explicit "Launch workspace" from the marketplace: the user deliberately
    // picked this model, so NEVER restore the previous conversation — mint a
    // brand-new session, even on a fresh remount that would otherwise resurrect
    // the last chat. The flag is consumed exactly once (cleared on read), so a
    // plain tab-switch remount or model switch still behaves normally.
    const launchedId = (() => {
      try {
        const v = window.sessionStorage.getItem('enzo.workspace.launched-model')
        if (v != null) window.sessionStorage.removeItem('enzo.workspace.launched-model')
        return v || ''
      } catch {
        return ''
      }
    })()
    if (launchedId && launchedId === activeModel.id) {
      const newSess: ChatSession = {
        id: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        title: `${activeModel.name || activeModel.id} Session`,
        model: activeModel.id,
        chatMode,
        isImageSession: isImg,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      setSessions((prev) => [newSess, ...prev])
      setActiveSessionId(newSess.id)
      setMessages([])
    setDismissedWindows([])
      return
    }

    if (lastInit !== null && lastInit === activeModel.id) {
      // Same model on a re-run (StrictMode second pass / unrelated re-render) — no-op.
      return
    }
    if (lastInit !== null && lastInit !== activeModel.id) {
      // User explicitly switched models → mint a fresh session for the new model.
      const newSess: ChatSession = {
        id: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        title: `${activeModel.name || activeModel.id} Session`,
        model: activeModel.id,
        chatMode,
        isImageSession: isImg,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      setSessions((prev) => [newSess, ...prev])
      setActiveSessionId(newSess.id)
      setMessages([])
    setDismissedWindows([])
      return
    }

    // First mount of this component instance (fresh page load, login, or a
    // tab-switch remount): ALWAYS restore the last conversation so returning
    // users pick up exactly where they left off — even after weeks/months away.
    // Prefer the stored active-session id, then the most recent session, then a
    // brand-new session.
    const restoredId = (() => {
      try {
        return window.localStorage.getItem(ACTIVE_SESSION_KEY) || ''
      } catch {
        return ''
      }
    })()
    const candidates = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    const byKey = restoredId ? sessions.find((s) => s.id === restoredId) : undefined
    // Prefer the stored active session, but only if it holds a real conversation.
    // Otherwise fall back to the most recent session that has messages, then any
    // session, then a brand-new one — so a returning user always lands on their
    // last actual conversation (even if the active key went stale/empty).
    const restored = (byKey && byKey.messages.length > 0 && byKey) ||
      candidates.find((s) => s.messages.length > 0) ||
      byKey ||
      candidates[0]
    if (restored) {
      setActiveSessionId(restored.id)
      setMessages(restored.messages)
      setChatMode((restored.chatMode as ChatMode) || chatMode)
      return
    }
    const newSess: ChatSession = {
      id: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      title: `${activeModel.name || activeModel.id} Session`,
      model: activeModel.id,
      chatMode,
      isImageSession: isImg,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setSessions((prev) => [newSess, ...prev])
    setActiveSessionId(newSess.id)
    setMessages([])
    setDismissedWindows([])
  }, [activeModel?.id])

  // Persist the active session id so the next visit can restore it.
  useEffect(() => {
    if (!activeSessionId) return
    try {
      window.localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId)
    } catch {
      /* ignore */
    }
  }, [activeSessionId])

  // Follow the active session's stable project container id. Switching sessions
  // (boot restore, drawer click, model switch, new chat) points saves + the
  // chat request at the right on-disk folder — or a clean slate for a session
  // that has no project yet.
  useEffect(() => {
    const sess = sessions.find((s) => s.id === activeSessionId)
    sessionProjectIdRef.current = sess?.projectId || ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  // Restore the active model from the active session (boot restore, drawer click,
  // tab-switch remount). This runs whenever activeSessionId lands on a session
  // whose stored model differs from the current tag — so a returning user sees
  // the same model they were chatting with instead of a default reset to Llama.
  // `initModelRef` is primed BEFORE `setActiveModel` so the boot effect's
  // "user switched models → mint fresh session" branch is a no-op (StrictMode-safe).
  useEffect(() => {
    if (!activeSessionId || isIncognito) return
    const sess = sessions.find((s) => s.id === activeSessionId)
    if (!sess?.model || !catalog?.length) return
    if (sess.model === activeModel.id) return
    const found =
      catalog.find((m) => m.id === sess.model) ||
      catalog.find((m) => m.id && sess.model && (m.id.includes(sess.model) || sess.model.includes(m.id)))
    if (found && found.id !== activeModel.id) {
      initModelRef.current = found.id
      setActiveModel(found)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  // Keep the active session's messages in lock-step with the live conversation
  // (captures every message — including commands, stream errors and roasts —
  // so a session never loads as an empty chat box in the history drawer).
  useEffect(() => {
    if (!activeSessionId || isIncognito) return
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSessionId) return s
        const firstUser = messages.find((m) => m.role === 'user')
        const title = firstUser?.text ? firstUser.text.slice(0, 30) : s.title
        return { ...s, messages, title, updatedAt: Date.now() }
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeSessionId, isIncognito])

  const clearHistory = () => {
    setMessages([])
    setDismissedWindows([])
    setSessions([])
    setActiveSessionId('')
    setDismissedWindows([])
    try {
      window.localStorage.removeItem(HISTORY_KEY)
      window.localStorage.removeItem(SESSIONS_KEY)
      window.localStorage.removeItem(ACTIVE_SESSION_KEY)
    } catch {
      /* ignore */
    }
  }

  // Start a brand-new chat while KEEPING the currently selected model (e.g. a
  // deepseek conversation gets a fresh thread but stays on deepseek — no manual
  // re-selection). Mirrors the session-minting used on model switches, but the
  // model id is left untouched so the boot/switch effects don't fire again.
  const startNewChat = () => {
    setShowHistoryDrawer(false)
    setDismissedWindows([])
    const newSess: ChatSession = {
      id: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      title: activeModel.name ? `${activeModel.name} New Chat` : `${activeModel.id} New Chat`,
      model: activeModel.id,
      chatMode,
      isImageSession: isImageActive,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setSessions((prev) => [newSess, ...prev])
    setActiveSessionId(newSess.id)
    setMessages([])
    setInputValue('')
    setHistoryIndex(-1)
    setStreamedText('')
    setThoughtChain('')
    setResearchSteps([])
    setAutoRoutedMode(null)
    setRetryInfo(null)
  }

  // Detect whether a user message has research intent (used in normal mode to
  // offer surface vs deep research before sending).
  const isResearchIntent = (text: string): boolean => {
    const t = text.toLowerCase().trim()
    // Very short queries are never research
    if (t.length < 15) return false
    // Skip code/image generation queries
    if (/^(write|generate|create|make|build|code|draw|design)\b/i.test(t)) return false
    const patterns = [
      /\b(research|investigate|look into|find out|gather information|gather data)\b/i,
      /\bwhat (is|are|was|were) the (latest|current|recent|state of)\b/i,
      /\banalyze\b.{0,40}\b(topic|subject|issue|problem|trend|market|sector)\b/i,
      /\b(summarize|overview|summary) (of|on|about)\b/i,
      /\b(explain in depth|explain thoroughly|deep dive|deep.?dive)\b/i,
      /\bcomprehensive (overview|analysis|report|summary|guide)\b/i,
      /\b(tell me everything|find everything|know everything) (about|on|regarding)\b/i,
      /\bwhat (do|does) (the|most) (studies|research|experts|scientists) (say|think|show|suggest)\b/i,
      /\bhow (does|do|did|has|have).{0,60}\b(work|evolved|changed|developed|impact)\b/i,
      /\b(pros and cons|advantages and disadvantages|compare|comparison) (of|between)\b/i,
      /\blatest (developments?|news|research|findings|trends?) (in|on|about|regarding)\b/i,
      /\b(history|historical (context|background)) (of|on|about)\b/i,
    ]
    return patterns.some((p) => p.test(t))
  }

  const handleModeChange = (mode: 'normal' | 'thinking' | 'research' | 'coding' | 'image-gen') => {
    const previousMode = chatMode

    // Image-gen is the ONLY mode that requires a different model (Pollinations image model).
    // All other modes are purely behavioral — the user's chosen model is preserved.
    if (mode === 'image-gen' && previousMode !== 'image-gen') {
      // Entering image-gen from a text chat ALWAYS opens a fresh image chat:
      // pause the current conversation (session + messages), then mint a brand-new
      // empty image session. Leaving image-gen restores the paused conversation.
      prevChatModelRef.current = activeModel
      prevChatSessionRef.current = {
        id: activeSessionId,
        messages,
        chatMode: previousMode,
      }
      let imgModel: CatalogModel | undefined
      if (catalog.length > 0) {
        imgModel = catalog.find(
          (m) => m.id === 'flux-schnell' || m.id.includes('flux') || m.type?.includes('image')
        )
        if (imgModel) {
          // Pre-seed the boot effect's model tracker so the model switch below
          // does NOT also mint a session ("switched models" branch) — the fresh
          // image session is minted explicitly, exactly once.
          initModelRef.current = imgModel.id
          setActiveModel(imgModel)
        }
      }
      const imgSess: ChatSession = {
        id: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        title: 'Image Generation',
        model: imgModel?.id || activeModel?.id || '',
        chatMode: 'image-gen',
        isImageSession: true,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      setSessions((prev) => [imgSess, ...prev])
      setActiveSessionId(imgSess.id)
      setMessages([])
      setDismissedWindows([])
    } else if (previousMode === 'image-gen' && mode !== 'image-gen') {
      // Leaving image-gen — restore the previously saved chat model and the
      // conversation that was paused when image-gen was entered.
      const restored = prevChatModelRef.current
      if (restored) {
        initModelRef.current = restored.id
        setActiveModel(restored)
        prevChatModelRef.current = null
      }
      const saved = prevChatSessionRef.current
      if (saved) {
        setMessages(saved.messages)
        if (saved.id) setActiveSessionId(saved.id)
        prevChatSessionRef.current = null
      }
      setDismissedWindows([])
    }
    // For all other mode transitions: model stays exactly as the user chose it.
    setChatMode(mode)
  }

  // Composer auto-grow/shrink. A controlled textarea gets .value reset on every
  // re-render but keeps whatever inline height was set last — so after sending
  // a long prompt the box would stay expanded. Resize from one effect whenever
  // the text (or stream state) changes; 'auto' then scrollHeight gives a clean
  // collapse back to a single line when emptied.
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(Math.max(el.scrollHeight, 28), 140) + 'px'
  }, [inputValue, isStreaming])

  const getRealModelId = (model: CatalogModel) => {
    if (model.provider === 'Groq') {
      if (model.id.startsWith('groq/')) return model.id
      if (model.id === 'llama-3.3-70b') return 'groq/llama-3.3-70b-versatile'
      if (model.id === 'qwen3-32b') return 'groq/qwen/qwen3.6-27b'
      return `groq/${model.id}`
    }
    if (model.provider === 'Pollinations') {
      if (model.id.startsWith('pollinations/')) return model.id
      if (model.id === 'minimax-m3') return 'pollinations/minimax-m3'
      if (model.id === 'flux-schnell') return 'pollinations/flux'
      return `pollinations/${model.id}`
    }
    if (model.provider === 'HuggingFace') {
      if (model.id.startsWith('hf/')) return model.id
      return `hf/${model.id}`
    }
    if (model.provider === 'NVIDIA') {
      let cleanId = model.id
      if (cleanId.startsWith('nvidia/')) {
        cleanId = cleanId.substring('nvidia/'.length)
      }
      if (cleanId === 'nemotron-3-ultra' || cleanId === 'nemotron-3-ultral') {
        return 'nvidia/nvidia/llama-3.1-nemotron-70b-instruct'
      }
      if (cleanId === 'nemotron-3-nano-8b-v1') {
        return 'nvidia/meta/llama-3.3-70b-instruct'
      }
      if (cleanId === 'mixtral-8x22b-instruct' || cleanId === 'mixtral-8x22b-instruct-v0.1') {
        return 'nvidia/mistralai/mixtral-8x22b-instruct-v0.1'
      }
      if (cleanId.includes('/')) {
        return `nvidia/${cleanId}`
      }
      return `nvidia/nvidia/${cleanId}`
    }
    if (model.provider === 'LLM7') {
      if (model.id.startsWith('llm7/')) return model.id
      return `llm7/${model.id}`
    }
    if (model.provider === 'Google') {
      if (model.id.startsWith('google/')) return model.id
      return `google/${model.id}`
    }
    if (model.provider === 'Puter') {
      if (model.id.startsWith('puter/')) return model.id
      return `puter/${model.id}`
    }

    switch (model.id) {
      case 'llama-3.3-70b':
        return 'groq/llama-3.3-70b-versatile'
      case 'qwen3-32b':
        return 'groq/qwen/qwen3.6-27b'
      case 'minimax-m3':
        return 'pollinations/minimax-m3'
      case 'nemotron-3-ultra':
        return 'nvidia/nvidia/llama-3.1-nemotron-70b-instruct'
      case 'deepseek-r1':
        return 'openrouter/deepseek/deepseek-r1'
      case 'flux-schnell':
        return 'pollinations/flux'
      case 'phi-3-medium':
        return 'openrouter/microsoft/phi-3-medium-128k-instruct'
      case 'gemini-2.5-flash':
        return 'openrouter/google/gemini-2.5-flash'
      case 'claude-3.5-sonnet':
        return 'openrouter/anthropic/claude-3.5-sonnet'
      default:
        return model.id
    }
  }

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    // A forced prompt (browser auto-continue) bypasses the input box + its guard.
    const forced = forcedPromptRef.current
    forcedPromptRef.current = null
    if ((!inputValue.trim() && attachedFiles.length === 0 && !forced) || isStreaming) return

    let prompt = forced ?? inputValue.trim()
    // A real user message resets the auto-continue budget; a forced "continue"
    // does not (so the net can fire several rounds for one build).
    if (!forced) { autoContinueCountRef.current = 0; setAutoContinuing(false) }
    if (attachedFiles.length > 0) {
      const attachmentsText = attachedFiles
        .map((f) => {
          if (f.isImage) {
            return `[ATTACHED IMAGE: ${f.name} (${formatFileSize(f.size)})]\nData URI: ${f.content}`
          }
          const ext = f.name.includes('.') ? f.name.split('.').pop() : ''
          return `[ATTACHED FILE: ${f.name} (${formatFileSize(f.size)})]\n\`\`\`${ext}\n${f.content}\n\`\`\``
        })
        .join('\n\n')
      prompt = prompt ? `${prompt}\n\n${attachmentsText}` : attachmentsText
      setAttachedFiles([])
    }

    setInputValue('')
    setHistoryIndex(-1)

    // In normal mode: detect research-intent queries and offer the user a choice
    // between surface search (quick, stays in normal mode) and deep research
    // (switches to research mode, runs the full multi-source synthesis engine).
    // We only show this dialog if the user hasn't already explicitly chosen a mode.
    if (chatMode === 'normal' && isResearchIntent(prompt) && !skipResearchCheckRef.current) {
      setResearchPromptDialog({ show: true, pendingMessage: prompt })
      return  // wait for dialog selection before sending
    }
    // Reset the bypass flag after checking (one-shot).
    skipResearchCheckRef.current = false

    // Auto-toggle Web Search ON when user prompt asks for email, calendar, or search tasks
    const lowerPrompt = prompt.toLowerCase()
    const isToolOrSearchIntent = /\b(mail|email|inbox|gmail|calendar|schedule|event|search|google|lookup|find out|latest|unread|check|fetch)\b/i.test(lowerPrompt)
    let activeWebSearch = webSearch
    if (isToolOrSearchIntent && !webSearch) {
      setWebSearch(true)
      activeWebSearch = true
    }

    const newMsg: ChatMessage = { role: 'user', text: prompt }
    setMessages((prev) => [...prev, newMsg])
    setIsStreaming(true)
    setStreamedText('')
    setThoughtChain('')
    setResearchSteps([])
    setAutoRoutedMode(null)
    setRetryInfo(null)
    previewDismissedRef.current = false

    // Editing an older saved project? Match the prompt against the My Projects
    // store. The pinned target either comes from a free-form mention (title or
    // a distinctive fact) or from the drawer's "Edit" button (via editNotice +
    // the pinned session project id). Pin it as the edit target so the backend
    // injects the REAL current files and the model edits them, not a fresh build.
    const editTarget = findEditTargetTask(prompt, loadCodeTasks())
    const editTask: StoredCodeTask | null =
      editTarget ?? (editNotice ? getCodeTask(sessionProjectIdRef.current) ?? null : null)
    if (editTask) {
      sessionProjectIdRef.current = editTask.id
      setChatMode('coding') // editing a saved project always runs as a coding build
      commitPreview({
        id: editTask.id,
        url: editTask.kind === 'project' ? `/api/project/${editTask.id}/` : `/api/preview/${editTask.id}`,
        title: editTask.title,
        isProject: editTask.kind === 'project',
        files: Object.keys(editTask.files).map((path) => ({ path, size: (editTask.files[path] || '').length })),
      })
    }
    setEditNotice(null)

    // Check system terminal commands
    const cmd = prompt.trim().toLowerCase()
    if (cmd === 'clear' || cmd === '/clear') {
      clearHistory()
      setIsStreaming(false)
      return
    }

    if (cmd === 'help' || cmd === '/help') {
      const helpText = `[AVAILABLE SYSTEM COMMANDS]

help        Display this terminal command reference
about       Display system node status & active provider configuration
models      List all registered catalog AI model nodes
clear       Reset active terminal chat screen
history     Open session history drawer

[MEMORY & SKILLS]
/remember <fact>      Teach ENZO a durable long-term fact (works across all models/APIs)
/forget [query]       Forget a memory / fact (or "/forget all")
/memory               List the current cross-model memory store
/learn <repo-url>     Clone a GitHub repo & distill it into a reusable skill
/skills               List learned skills
/unlearn <name>       Delete a learned skill

[COGNITIVE EXECUTION MODES]
• Normal    Standard LLM chat routing
• Thinking  Deep step-by-step reasoning execution
• Research  Vector search & web synthesis engine
• Coding    Production software generation engine
• Image Gen Text-to-image synthesis pipeline`
      setMessages((prev) => [...prev, { role: 'assistant', text: helpText, mode: chatMode }])
      setIsStreaming(false)
      return
    }

    if (cmd === 'about' || cmd === '/about') {
      const aboutText = `[ENZO AI SYSTEM STATUS]

Active Node   : ${activeModel.name}
Provider      : ${activeModel.provider}
Pricing Tier  : ${activeModel.free ? 'FREE' : 'PAID'}
Cognitive Mode: ${chatMode.toUpperCase()}
Web Search    : ${webSearch ? 'ENABLED' : 'DISABLED'}
Auto Fallback : ${autoFallback ? 'ENABLED' : 'DISABLED'}
Incognito     : ${isIncognito ? 'ACTIVE' : 'DISABLED'}
Roast Engine  : ${isRoasting ? 'ACTIVE' : 'DISABLED'}`
      setMessages((prev) => [...prev, { role: 'assistant', text: aboutText, mode: chatMode }])
      setIsStreaming(false)
      return
    }

    if (cmd === 'models' || cmd === '/models') {
      const modelList = catalog.length > 0
        ? catalog.map((m) => `• ${m.name} (${m.provider}) - ${m.free ? 'FREE' : 'PAID'}`).join('\n')
        : 'No active catalog models available.'
      setMessages((prev) => [...prev, { role: 'assistant', text: `[MODEL MATRIX CATALOG]\n\n${modelList}`, mode: chatMode }])
      setIsStreaming(false)
      return
    }

    if (cmd === 'history' || cmd === '/history') {
      setShowHistoryDrawer(true)
      setMessages((prev) => [...prev, { role: 'assistant', text: 'Opened session history drawer.', mode: chatMode }])
      setIsStreaming(false)
      return
    }

    if (cmd === '/skills') {
      setMessages((prev) => [...prev, { role: 'assistant', text: 'Opened learned-skills panel.', mode: chatMode }])
      setIsStreaming(false)
      await loadSkillsPanel()
      return
    }

    // 1. Roast Mode
    if (isRoasting) {
      try {
        const roastRes = await fetch('/api/meme', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: prompt }),
        })
        if (roastRes.ok) {
          const roastData = await roastRes.json()
          const asstMsg: ChatMessage = {
            role: 'assistant',
            text: `💀 ROAST DETECTED:\n# ${roastData.text || roastData.roast || ''}\n_${roastData.sub || ''}_`,
            mode: chatMode,
          }
          setMessages((prev) => [...prev, asstMsg])
        }
      } catch (err) {
        console.error('Roast failed:', err)
      } finally {
        setIsStreaming(false)
      }
      return
    }

    // 2. Image generation
    if (isImageActive) {
      try {
        setStreamedText('Requesting image synthesis from Pollinations gateway…')
        const imgController = new AbortController()
        abortRef.current = imgController
        const imgRes = await fetch('/api/image/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: imgController.signal,
          body: JSON.stringify({
            prompt,
            model: imageModel,
            aspect: imageAspect,
            quality: imageQuality,
            seed: imageSeed.trim() === '' ? undefined : Number(imageSeed),
            enhance: true,
            negative: imageNegative,
            uncensoredMode: imageUncensored ? 'on' : 'off',
            providerKeys: {
              huggingface: keyVault.getItem('enzo.keys.huggingface') || '',
              pollinations: keyVault.getItem('enzo.keys.pollinations') || '',
              cloudflare: keyVault.getItem('enzo.keys.cloudflare') || '',
              cloudflareAccount: keyVault.getItem('enzo.keys.cloudflareAccount') || '',
            },
          }),
        })
        if (!imgRes.ok) {
          const errDetail = await imgRes.text()
          throw new Error(errDetail)
        }
        const imgData = await imgRes.json()
        const finalImg = imgData.dataUrl || imgData.url
        const markdownImg = `Here is your synthesized image:\n\n![Generated Image](${finalImg})`
        const asstMsg: ChatMessage = {
          role: 'assistant',
          text: markdownImg,
          image: finalImg,
          mode: chatMode,
        }
        setMessages((prev) => [...prev, asstMsg])
        setStreamedText('')
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          setStreamedText('')
          return
        }
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: `Image generation failed: ${err.message || err}`,
            mode: chatMode,
          },
        ])
        setStreamedText('')
      } finally {
        abortRef.current = null
        setIsStreaming(false)
      }
      return
    }

    // 3. Real SSE Chat streaming
    let fullText = ''
    // Reasoning chain, kept alongside the answer so it survives into the
    // finished message. The live `thoughtChain` state is cleared on completion,
    // so without this the whole point of thinking mode scrolled away the moment
    // the answer landed.
    let reasoningText = ''
    try {
      const realModel = getRealModelId(activeModel)
      const orKey = keyVault.getItem('enzo.keys.openrouter') || ''
      const nvKey = keyVault.getItem('enzo-nvidia-key') || ''
      const hfKey = keyVault.getItem('enzo.keys.huggingface') || ''
      const groqKey = keyVault.getItem('enzo.keys.groq') || ''
      const llm7Key = keyVault.getItem('enzo.keys.llm7') || ''
      const googleKey = keyVault.getItem('enzo.keys.google') || keyVault.getItem('enzo.keys.gemini') || ''
      const puterKey = keyVault.getItem('enzo.keys.puter') || ''
      const cloudflareKey = keyVault.getItem('enzo.keys.cloudflare') || ''
      const cloudflareAccount = keyVault.getItem('enzo.keys.cloudflareAccount') || ''

      // Create a fresh abort controller for this request so Stop can cancel it.
      const controller = new AbortController()
      abortRef.current = controller

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-auto-fallback': autoFallback ? 'true' : 'false',
          'x-exa-key': keyVault.getItem('enzo.keys.exa') || '',
          'x-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        },
        signal: controller.signal,
        body: JSON.stringify({
          message: prompt,
          chosenModel: realModel,
          chatMode: editTask ? 'coding' : chatMode,
          webSearch: activeWebSearch ? 'on' : 'off',
          autoFallback,
          // Active session's on-disk project container — lets the backend
          // inject the AUTHORITATIVE current files so a "continue"/extension
          // request extends the real code instead of restarting. Session-scoped
          // (not tied to the transient preview), so it holds across the turn.
          // When the user is editing one of their saved projects (drawer Edit or
          // a free-form mention), the matched project's id replaces it.
          projectId: editTask ? editTask.id : sessionProjectIdRef.current || undefined,
          // The saved task's files, when editing a project that has no on-disk
          // container (e.g. a single-HTML preview task) — the backend injects
          // these as the project's current state instead of reading the folder.
          projectFiles: editTask
            ? Object.entries(editTask.files).slice(0, 60).map(([path, content]) => ({ path, content: content.slice(0, 140000) }))
            : undefined,
          messages: messages.map(m => ({
            role: m.role,
            parts: [{ type: 'text', text: m.text }],
            // Interrupted flag tells the backend this reply was cut off
            // mid-generation, so a "continue" resumes it instead of restarting.
            ...(m.interrupted ? { interrupted: true } : {}),
            // Include reasoning if present
            ...(m.reasoning ? { reasoning: m.reasoning } : {})
          })),
          providerKeys: {
            openrouter: orKey,
            groq: groqKey,
            nvidia: nvKey,
            huggingface: hfKey,
            llm7: llm7Key,
            google: googleKey,
            puter: puterKey,
            cloudflare: cloudflareKey,
            cloudflareAccount,
          },
        }),
      })

      if (!response.ok) {
        const errTxt = await response.text()
        throw new Error(errTxt || 'API server returned an error.')
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      if (!reader) {
        throw new Error('Readable stream not supported.')
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() || ''

        for (const frame of frames) {
          if (!frame.trim()) continue

          let frameEvent = ''
          let dataLine: string | null = null
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) frameEvent = line.slice(6).trim()
            else if (line.startsWith('data:')) {
              dataLine = line.startsWith('data: ') ? line.slice(6) : line.slice(5)
            }
          }
          if (dataLine === null) continue
          if (dataLine === '[CLOSE]') continue

          let decoded = dataLine
          try {
            const parsed = JSON.parse(dataLine)
            if (typeof parsed === 'string') decoded = parsed
          } catch {
            /* raw payload */
          }

           if (frameEvent === 'reasoning') {
            reasoningText += decoded + '\n'
            setThoughtChain((prev) => prev + decoded + '\n')
          } else if (frameEvent === 'search') {
            setResearchSteps((prev) => [...prev, decoded])
          } else if (frameEvent === 'mode') {
            // Auto mode (per-message): the backend LLM picked the best execution
            // mode for this turn. Reflect it in the live reply; never touch the
            // user's mode toggle.
            try {
              const payload = JSON.parse(dataLine)
              if (payload?.mode) {
                autoRoutedModeRef.current = String(payload.mode)
                setAutoRoutedMode(String(payload.mode))
              }
            } catch { /* ignore bad payload */ }
          } else if (frameEvent === 'research-prompt') {
            // Backend is suggesting the user might want to switch to research mode.
            // Surface the dialog mid-stream (the current stream will still finish).
            try {
              const payload = JSON.parse(dataLine)
              if (payload?.query) {
                setResearchPromptDialog({ show: true, pendingMessage: payload.query })
              }
            } catch { /* ignore bad payload */ }
          } else if (frameEvent === 'build') {
            // Build-verify progress metadata — never part of the reply text.
            continue
          } else if (frameEvent === 'retry') {
            // Auto-retry after a rate-limit, OR a thunder-pause (sustained-rate
            // ceiling): the backend is parked and will resume the stream from
            // where it stopped. `status: 'pacing'` = proactive rate guard.
            try {
              const payload = JSON.parse(dataLine)
              if (payload && typeof payload.provider === 'string') {
                setRetryInfo({
                  provider: payload.provider,
                  etaSec: Number(payload.etaSec) || 10,
                  cycle: Number(payload.cycle) || 1,
                  ...(payload.status ? { status: String(payload.status) } : {}),
                })
              }
            } catch { /* ignore bad payload */ }
          } else {
            if (decoded.startsWith('[Server Error:')) {
              // Keep whatever was already streamed (the partial build) as the
              // message so the user can "continue" from it, with the error as
              // a trailing notice instead of replacing the whole reply.
              const partial = (fullText || '').trim()
              const text = partial
                ? `${fullText}\n\n${decoded}`
                : decoded
              // Register the partial build so the preview panel keeps showing
              // the files produced before the failure. Salvage: the stream is
              // over, so if the server died mid-file the half-written file is
              // still worth keeping in the preview.
              if (partial) syncPreviewFromText(fullText, true, true)
              setMessages((prev) => [
                ...prev,
                { role: 'assistant', text, mode: chatMode, interrupted: true },
              ])
              setIsStreaming(false)
              setStreamedText('')
              setThoughtChain('')
              setResearchSteps([])
              setRetryInfo(null)
              abortRef.current = null
              return
            }
            if (decoded.startsWith('[SYSTEM:')) {
              // Ignore system notices so they don't leak into message content or PDF
              continue
            }
            // Check for special agent tool responses
            if (decoded.includes('"not_connected":true') && decoded.includes('"authUrl"')) {
              try {
                const toolResult = JSON.parse(decoded)
                if (toolResult.not_connected && toolResult.authUrl) {
                  // Determine which service based on the message context
                  const service: 'gmail' | 'calendar' | 'drive' =
                    decoded.includes('gmail') ? 'gmail' :
                    decoded.includes('calendar') ? 'calendar' :
                    decoded.includes('drive') ? 'drive' : 'gmail' // default to gmail for general "google" requests
                  setInlinePermission({
                    show: true,
                    service,
                    authUrl: toolResult.authUrl,
                  })
                }
              } catch {
                // Not JSON, treat as normal text
              }
            }
            if (decoded.includes('"status":"needs_confirmation"')) {
              try {
                const toolResult = JSON.parse(decoded)
                if (toolResult.status === 'needs_confirmation' && toolResult.proposed) {
                  setPendingToolConfirmation({
                    toolName: toolResult.proposed.toolName || 'action',
                    args: toolResult.proposed,
                    message: toolResult.message || 'Please confirm this action.',
                  })
                }
              } catch {
                // Not JSON, treat as normal text
              }
            }
            fullText += decoded
            setStreamedText(fullText)
          }
        }
      }

      setIsStreaming(false)
      const finalMsg: ChatMessage = {
        role: 'assistant',
        text: fullText,
        mode: (autoRoutedModeRef.current as ChatMode) ?? chatMode,
        reasoning: reasoningText.trim() || undefined,
        researchSteps: researchSteps.length > 0 ? [...researchSteps] : undefined,
      }
      // Register the final doc/project (bypassing the stream throttle) so the
      // side-panel preview always matches the finished reply. Salvage: the
      // reply is final — if generation was cut inside the last file fence,
      // keep its partial content instead of silently dropping the file.
      syncPreviewFromText(fullText, true, true)
      setMessages((prev) => [...prev, finalMsg])
      setStreamedText('')
      setThoughtChain('')
      setResearchSteps([])
      setRetryInfo(null)
      autoRoutedModeRef.current = null
      setAutoRoutedMode(null)
      abortRef.current = null

      // ── Browser auto-continue safety net ──────────────────────────────────
      // The server self-continues until the project is whole, but if its SSE
      // still closes on an incomplete coding build (round budget hit / provider
      // dropped), re-send "continue" ourselves so the user never has to type it.
      if (finalMsg.mode === 'coding') {
        const reason = codingReplyIncompleteReason(fullText)
        if (reason && autoContinueCountRef.current < MAX_AUTO_CONTINUE) {
          autoContinueCountRef.current += 1
          setAutoContinuing(true)
          forcedPromptRef.current = 'continue'
          console.debug(`[auto-continue] browser round ${autoContinueCountRef.current}/${MAX_AUTO_CONTINUE} — ${reason}`)
          setTimeout(() => { void handleSend({ preventDefault() {} } as React.FormEvent) }, 400)
        } else {
          setAutoContinuing(false)
        }
      }
    } catch (err: any) {
      // User pressed Stop — keep whatever was already streamed as the message
      // instead of surfacing a scary "aborted" error.
      if (err?.name === 'AbortError' && fullText.trim()) {
        setIsStreaming(false)
        // Register the partial build so the preview keeps the produced files.
        // Salvage: the user stopped the stream, so rescue the file that was
        // mid-write instead of losing it.
        syncPreviewFromText(fullText, true, true)
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: fullText,
            mode: (autoRoutedModeRef.current as ChatMode) ?? chatMode,
            interrupted: true,
            researchSteps: researchSteps.length > 0 ? [...researchSteps] : undefined,
          },
        ])
        setStreamedText('')
        setThoughtChain('')
        setResearchSteps([])
        setRetryInfo(null)
        abortRef.current = null
        return
      }

      // Non-abort error (network drop, JSON fetch failure, etc.) — keep the
      // partial output as an interrupted message so "continue" resumes it.
        const partial = (fullText || '').trim()
        const text = partial
          ? `${fullText}\n\nStream error: ${err.message || err}`
          : `Stream error: ${err.message || err}`
        // Register the partial build so the preview keeps the produced files.
        // Salvage: the stream died, so keep the file it was mid-writing.
        if (partial) syncPreviewFromText(fullText, true, true)
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text,
            mode: chatMode,
            interrupted: partial.length > 0 ? true : undefined,
            researchSteps: researchSteps.length > 0 ? [...researchSteps] : undefined,
          },
        ])
        setIsStreaming(false)
        setStreamedText('')
        setThoughtChain('')
        setResearchSteps([])
        setRetryInfo(null)
        abortRef.current = null
    }
  }

  // Stop generation: abort the in-flight stream. The catch in handleSend
  // finalizes whatever was already streamed as a partial message.
  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
  }, [])

  // Commit a registered preview (single page or multi-file project) to state.
  const commitPreview = useCallback(
    (data: {
      id: string
      url: string
      title: string
      isProject?: boolean
      files?: { path: string; size: number }[]
    }) => {
      if (!data?.url) return
      previewPostedHtmlRef.current = data.url
      setPreview(data)
      if (!previewDismissedRef.current) setPreviewOpen(true)
    },
    [],
  )

  // Register a single extracted HTML doc. Throttled while streaming (`force`
  // bypasses so the final version always lands). The vault token is attached
  // when we have one so the user can later delete this preview from the
  // projects drawer (DELETE /api/preview/:id requires it).
  const registerPreview = useCallback(
    async (html: string, force = false) => {
      const trimmed = html.trim()
      if (!trimmed) return null
      previewLatestHtmlRef.current = trimmed

      const now = Date.now()
      if (!force && now - previewPostAtRef.current < 1500) return null
      previewPostAtRef.current = now

      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        const vaultToken = await mintVaultToken()
        if (vaultToken) headers['x-vault-token'] = vaultToken
        const res = await fetch('/api/preview', {
          method: 'POST',
          headers,
          body: JSON.stringify({ html: trimmed, title: 'ENZO Live Preview' }),
        })
        if (!res.ok) return null
        const data = await res.json()
        if (!data?.url) return null
        commitPreview({ id: data.id, url: data.url, title: data.title || 'ENZO Live Preview' })
        if (!isIncognito) {
          storeCodeTask({
            id: data.id,
            kind: 'html',
            title: data.title || 'ENZO Live Preview',
            files: { 'index.html': trimmed },
            createdAt: now,
            updatedAt: now,
          })
        }
        return { url: data.url, id: data.id }
      } catch {
        return null
      }
    },
    [commitPreview, isIncognito],
  )

  // Register a multi-file project (```file:path blocks) — written to disk on
  // the backend and served as a real project so relative css/js resolve.
  const registerProject = useCallback(
    async (files: Record<string, string>, force = false) => {
      if (!files || Object.keys(files).length === 0) return null
      const now = Date.now()
      if (!force && now - previewPostAtRef.current < 1500) return null
      previewPostAtRef.current = now

      // Chain saves so an in-flight first save pins the container id before the
      // next save reads it (otherwise concurrent saves fork separate folders).
      const run = projectSaveChainRef.current.then(async () => {
      try {
        const res = await fetch('/api/project/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Send the session's pinned id so this upserts the SAME container
          // instead of forking a new folder on every save. Empty on the first
          // save of a session — the backend mints one and we pin it below.
          body: JSON.stringify({ files, title: 'ENZO Project', id: sessionProjectIdRef.current || undefined }),
        })
        if (!res.ok) return null
        const data = await res.json()
        if (!data?.url) return null
        // Pin the container id to this session so every later save + the chat
        // request's projectId target the same on-disk folder (survives reload).
        if (data.id) {
          sessionProjectIdRef.current = data.id
          if (!isIncognito && activeSessionId) {
            setSessions((prev) =>
              prev.map((s) => (s.id === activeSessionId ? { ...s, projectId: data.id } : s)),
            )
          }
        }
        commitPreview({
          id: data.id,
          url: data.url,
          title: data.title || 'ENZO Project',
          isProject: true,
          files: Array.isArray(data.files) ? data.files : [],
        })
        if (!isIncognito) {
          storeCodeTask({
            id: data.id,
            kind: 'project',
            title: data.title || 'ENZO Project',
            files,
            createdAt: now,
            updatedAt: now,
          })
        }
        return data
      } catch {
        return null
      }
      })
      // Keep the chain alive even if this save throws, so later saves still run.
      projectSaveChainRef.current = run.catch(() => undefined)
      return run
    },
    [commitPreview, isIncognito, activeSessionId],
  )

  // Decide whether streaming text is a multi-file project or a single HTML doc
  // and surface the matching preview. `salvage` is true only on FINALIZED text
  // (stream end, user stop, stream error, opening a stored message) — the one
  // moment rescuing an unterminated final fence is correct. Mid-stream it must
  // stay false: while the model writes, the last fence is always open, so
  // salvaging on every tick would register each half-written file as if whole.
  const syncPreviewFromText = useCallback(
    async (text: string, force = false, salvage = false) => {
      if (!text) return
      const project = extractProjectFiles(text, salvage)
      if (project) {
        const names = Object.keys(project)
        const hasIndex = names.some((n) => n === 'index.html' || n.endsWith('/index.html'))
        if (hasIndex || names.length >= 2) {
          await registerProject(project, force)
          return
        }
      }
      const html = extractPreviewHtml(text)
      if (html) await registerPreview(html, force)
    },
    [registerProject, registerPreview],
  )

  // Open a specific message's document in the side panel (per-message button).
  // Stored messages are finalized text — a reply whose last fence never closed
  // (interrupted build) still deserves its rescued partial file in the panel.
  const handlePreviewMessage = useCallback(
    async (text: string) => {
      await syncPreviewFromText(text, true, true)
    },
    [syncPreviewFromText],
  )

  // Live preview: while a coding reply streams, re-register the freshest
  // doc/project so the panel follows the model as it writes.
  useEffect(() => {
    if (!isStreaming) return
    syncPreviewFromText(streamedText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, streamedText])

  const previewAbsoluteUrl = preview ? new URL(preview.url, window.location.origin).href : ''

  // While a right-edge drawer (History / My Projects) is open, the floating
  // live-preview panel (portaled at z-[9998] over the viewport's right edge)
  // physically covers the drawer's buttons, so clicks on Delete/Open/Download
  // silently hit the panel instead. Suspend it (invisible + click-through,
  // still mounted so the iframe keeps its state) whenever a drawer is up.
  const sideDrawerOpen = showHistoryDrawer || showProjectsDrawer

  // ── My Projects drawer helpers ──────────────────────────────────────────
  // The redirect URL that opens a task full-screen: multi-file projects live at
  // /api/project/:id/ (real host + sandboxed backend); single HTML docs at
  // /api/preview/:id. Same URL the side-panel "open new tab" uses.
  const projectUrl = useCallback((task: StoredCodeTask) => {
    return task.kind === 'project' ? `/api/project/${task.id}/` : `/api/preview/${task.id}`
  }, [])

  const openProjectsDrawer = useCallback(() => {
    setProjectList(loadCodeTasks())
    setShowProjectsDrawer(true)
  }, [])

  const openProjectTab = useCallback((task: StoredCodeTask) => {
    window.open(projectUrl(task), '_blank', 'noopener')
  }, [projectUrl])

  const deleteProject = useCallback((task: StoredCodeTask) => {
    removeCodeTask(task.id)
    setProjectList(loadCodeTasks())
    // Best-effort server-side cleanup: projects get their on-disk folder +
    // runtime stopped; html previews get their in-memory entry freed ahead of
    // its 1-hour TTL (the DELETE carries the vault token when we hold one, so
    // the server can enforce ownership). Ignore failures either way.
    if (task.kind === 'project') {
      fetch(`/api/project/${task.id}`, { method: 'DELETE' }).catch(() => {})
    } else {
      mintVaultToken().then((token) => {
        const headers: Record<string, string> = {}
        if (token) headers['x-vault-token'] = token
        return fetch(`/api/preview/${task.id}`, { method: 'DELETE', headers })
      }).catch(() => {})
    }
  }, [])

  // Edit a saved project: pin it as the coding target (its real on-disk files
  // get injected into the next request), rehydrate the preview panel so the
  // old build is visible, switch to coding mode, then hand over to the user to
  // describe the change. Matching also works free-form in chat.
  const startEditingTask = useCallback(
    (task: StoredCodeTask) => {
      sessionProjectIdRef.current = task.id
      commitPreview({
        id: task.id,
        url: task.kind === 'project' ? `/api/project/${task.id}/` : `/api/preview/${task.id}`,
        title: task.title,
        isProject: task.kind === 'project',
        files: Object.keys(task.files).map((path) => ({ path, size: (task.files[path] || '').length })),
      })
      setChatMode('coding')
      setShowProjectsDrawer(false)
      setEditNotice({ title: task.title || 'Untitled project' })
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 100)
    },
    [commitPreview],
  )

  const zipCorrespondingPreview = useCallback(() => {
    if (!preview?.id) return
    const task = getCodeTask(preview.id)
    if (task) downloadTaskZip(task)
  }, [preview?.id])

  const storedCodeTask = preview?.id ? getCodeTask(preview.id) : null
  const storedFileCount = storedCodeTask ? Object.keys(storedCodeTask.files).length : 0

  const copyPreviewUrl = useCallback(() => {
    if (!previewAbsoluteUrl) return
    navigator.clipboard
      .writeText(previewAbsoluteUrl)
      .then(() => {
        setPreviewCopied(true)
        window.setTimeout(() => setPreviewCopied(false), 1600)
      })
      .catch(() => {})
  }, [previewAbsoluteUrl])

  // Called by the ResearchDepthDialog when the user picks a research depth.
  // 'surface' → sends with normal mode + web search on (quick lookup).
  // 'deep'    → switches to research mode then sends the message.
  //
  // We use direct state-setting + programmatic form submission via the form ref
  // to avoid stale-closure issues with calling handleSend from within a useCallback.
  const handleResearchDialogChoice = (
    choice: 'surface' | 'deep',
    pendingMessage: string,
  ) => {
    setResearchPromptDialog(null)
    if (!pendingMessage.trim()) return

    if (choice === 'deep') {
      // Switch to research mode — model stays the same (model lock fix).
      setChatMode('research')
    } else if (choice === 'surface') {
      // Surface search: enable web search for this turn
      setWebSearch(true)
    }

    // Set the message in the input and submit the form.
    // We put it in a microtask queue so state changes above flush first.
    // Set the bypass flag so handleSend skips the research check on this submit.
    skipResearchCheckRef.current = true
    setInputValue(pendingMessage)
    setTimeout(() => {
      // Find the chat form and submit it programmatically
      const form = document.getElementById('enzo-chat-form') as HTMLFormElement | null
      if (form) {
        form.requestSubmit()
      }
    }, 0)
  }

  // Global Escape → Stop generation (works even while the textarea is
  // disabled during streaming), like real AI platforms.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isStreaming) {
        e.preventDefault()
        handleStop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isStreaming, handleStop])

  // Filtered session list for drawer
  const filteredSessions = useMemo(() => {
    return sessions
      .filter((s) => (historyTab === 'image' ? s.isImageSession : !s.isImageSession))
      .filter((s) =>
        historySearch
          ? s.title.toLowerCase().includes(historySearch.toLowerCase()) ||
            s.messages.some((m) => m.text.toLowerCase().includes(historySearch.toLowerCase()))
          : true
      )
  }, [sessions, historyTab, historySearch])

  // Group catalog by category for organized display
  const groupedCatalog = useMemo(() => {
    const groups: Record<string, { label: string; models: CatalogModel[] }> = {
      'text': { label: 'Text & Reasoning Nodes', models: [] },
      'coding': { label: 'Coding & Logic Nodes', models: [] },
      'moe': { label: 'MOE (Mixture of Experts) Nodes', models: [] },
      'image-gen': { label: 'Image Generation Nodes', models: [] },
      'general': { label: 'General & General-Purpose Nodes', models: [] },
    }

    availableCatalog.forEach((m) => {
      const cat = getModelCategory(m)
      groups[cat].models.push(m)
    })

    return groups
  }, [availableCatalog])

    // ─── Shared chrome & body (reused by docked + fullscreen terminal) ───
    const terminalChrome = (<>
        {/* Hidden file input for attachment button & drag-drop */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          multiple
          className="hidden"
        />

        {/* Drag and Drop visual glass overlay */}
        <AnimatePresence>
          {isDragging && (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="absolute inset-0 z-50 bg-black/85 backdrop-blur-md rounded-2xl border-2 border-dashed border-emerald-400/50 flex flex-col items-center justify-center p-6 text-center pointer-events-none shadow-[inset_0_0_50px_rgba(52,211,153,0.15)]"
            >
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-3 text-emerald-400 animate-bounce">
                <Paperclip size={28} />
              </div>
              <p className="text-emerald-300 font-mono text-sm font-bold tracking-wider">DROP FILES TO ATTACH</p>
              <p className="text-white/60 font-sans text-xs mt-1">Code, text, documents, or images</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Dark glass background ── no orb, let site bg show ─── */}
        <div className={`absolute inset-0 bg-black/60 backdrop-blur-sm ${termMaximized ? '' : 'rounded-2xl'}`} />

    </>)

    const terminalHeader = (<>
        {/* ─── Header Chrome ─────────────────────────────────────────── */}
        <div className="relative z-10 flex items-center justify-between px-5 py-3 border-b border-white/[0.06] bg-black/30 backdrop-blur-md">
          <div className="flex gap-1.5 items-center">
            <button
              onClick={() => { setTermMaximized(false); setTermMinimized(false) }}
              title="Restore window"
              className="group w-3 h-3 rounded-full bg-red-500/80 hover:bg-red-400 transition-all cursor-pointer shadow-[0_0_6px_rgba(239,68,68,0.5)] flex items-center justify-center"
            >
              <X size={7} strokeWidth={3.5} className="text-red-950 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
            <button
              onClick={() => {
                if (termMaximized) { setTermMaximized(false); setTermMinimized(true) }
                else setTermMinimized((v) => !v)
              }}
              title={termMinimized ? 'Restore' : 'Minimize'}
              className="group w-3 h-3 rounded-full bg-yellow-500/80 hover:bg-yellow-400 transition-all cursor-pointer shadow-[0_0_6px_rgba(234,179,8,0.5)] flex items-center justify-center"
            >
              <Minus size={7} strokeWidth={3.5} className="text-yellow-950 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
            <button
              onClick={() => { setTermMaximized((v) => !v); setTermMinimized(false) }}
              title={termMaximized ? 'Restore' : 'Maximize'}
              className="group w-3 h-3 rounded-full bg-green-500/80 hover:bg-green-400 transition-all cursor-pointer shadow-[0_0_6px_rgba(34,197,94,0.5)] flex items-center justify-center"
            >
              <Square size={6} strokeWidth={3.5} className="text-green-950 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-white/40">enzo@matrix:~$</span>
            <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 border border-white/[0.10] font-mono">
              {activeModel.name}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <button
              onClick={startNewChat}
              title="Start a new chat with the current model"
              className="text-white/40 hover:text-white/80 flex items-center gap-1 cursor-pointer transition-colors"
            >
              <Plus size={12} />
              <span className="hidden sm:inline">New chat</span>
            </button>
            <button
              onClick={() => setShowHistoryDrawer(!showHistoryDrawer)}
              className="text-white/40 hover:text-white/80 flex items-center gap-1 cursor-pointer transition-colors"
            >
              <History size={12} />
              <span className="hidden sm:inline">Sessions</span>
            </button>
            <button
              onClick={() => (showProjectsDrawer ? setShowProjectsDrawer(false) : openProjectsDrawer())}
              className="text-white/40 hover:text-white/80 flex items-center gap-1 cursor-pointer transition-colors"
            >
              <FolderOpen size={12} />
              <span className="hidden sm:inline">Projects</span>
            </button>
            <div className="flex items-center gap-1">
              <span className="text-white/40">ONLINE</span>
            </div>
          </div>
        </div>
    </>)

    const terminalBody = (<>
        {/* ─── History Drawer ─────────────────────────────────────────── */}
        <AnimatePresence>
          {showHistoryDrawer && (
            <motion.div
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 30 }}
              className="absolute right-0 top-[49px] bottom-0 w-72 bg-black/80 backdrop-blur-2xl border-l border-white/10 shadow-2xl p-3 flex flex-col z-40 rounded-br-2xl"
            >
              <div className="flex items-center justify-between pb-2 border-b border-white/10">
                <span className="text-xs font-bold text-white/60 tracking-wider font-mono">SESSION HISTORY</span>
                <button onClick={() => setShowHistoryDrawer(false)} className="text-white/40 hover:text-white cursor-pointer transition-colors">
                  <X size={14} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-1 my-2 p-1 bg-white/5 rounded-xl border border-white/10 text-[10px]">
                <button
                  onClick={() => setHistoryTab('text')}
                  className={`py-1.5 rounded-lg font-bold capitalize transition-all cursor-pointer ${historyTab === 'text' ? 'bg-white/10 text-white border border-white/20' : 'text-white/40 hover:text-white'}`}
                >
                  Text Chats
                </button>
                <button
                  onClick={() => setHistoryTab('image')}
                  className={`py-1.5 rounded-lg font-bold capitalize transition-all cursor-pointer ${historyTab === 'image' ? 'bg-white/10 text-white border border-white/20' : 'text-white/40 hover:text-white'}`}
                >
                  Image Gens
                </button>
              </div>

              <div className="relative mb-2">
                <Search size={11} className="absolute left-2.5 top-2.5 text-white/30" />
                <input
                  type="text"
                  placeholder="Search sessions…"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-7 pr-3 py-1.5 text-[11px] text-white placeholder:text-white/25 focus:outline-none focus:border-white/25 font-mono transition-colors"
                />
              </div>

              <div className="flex-1 overflow-y-auto space-y-1 scrollbar-thin">
                {filteredSessions.length === 0 ? (
                  <div className="text-center py-6 text-[11px] text-white/30 font-mono">No sessions recorded.</div>
                ) : (
                  filteredSessions.map((s) => (
                    <motion.div
                      key={s.id}
                      whileHover={{ scale: 1.01 }}
                      onClick={() => {
                        setMessages(s.messages)
                        setActiveSessionId(s.id)
                        setChatMode((s.chatMode as ChatMode) || chatMode)
                        setShowHistoryDrawer(false)
                        setDismissedWindows([])
                      }}
                      className={`group p-2.5 rounded-xl border text-left transition-all cursor-pointer flex items-center justify-between ${
                        s.id === activeSessionId
                          ? 'bg-white/10 border-white/20 text-white'
                          : 'bg-white/[0.03] border-white/[0.06] hover:border-white/20 text-white/70'
                      }`}
                    >
                      <div className="truncate pr-2">
                        <div className="text-[11px] font-semibold truncate">{s.title}</div>
                        <div className="text-[9px] text-white/35 font-mono">{s.model}</div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setSessions((prev) => prev.filter((sess) => sess.id !== s.id))
                        }}
                        className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-rose-400 p-1 transition-all"
                      >
                        <Trash2 size={11} />
                      </button>
                    </motion.div>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── My Projects Drawer ─────────────────────────────────────── */}
        <AnimatePresence>
          {showProjectsDrawer && (
            <motion.div
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 30 }}
              className="absolute right-0 top-[49px] bottom-0 w-80 bg-black/80 backdrop-blur-2xl border-l border-white/10 shadow-2xl p-3 flex flex-col z-40 rounded-br-2xl"
            >
              <div className="flex items-center justify-between pb-2 border-b border-white/10">
                <span className="text-xs font-bold text-white/60 tracking-wider font-mono">MY PROJECTS</span>
                <button onClick={() => setShowProjectsDrawer(false)} className="text-white/40 hover:text-white cursor-pointer transition-colors">
                  <X size={14} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto mt-2 space-y-2 pr-1">
                {projectList.length === 0 && (
                  <div className="text-center py-10 text-[11px] text-white/30 font-mono">
                    No projects yet.<br />Build something in coding mode.
                  </div>
                )}
                {projectList.map((task) => (
                  <div key={task.id} className="rounded-xl border border-white/10 bg-white/5 p-2.5 hover:border-white/20 transition-colors">
                    <div className="flex items-start gap-2">
                      <div className={`mt-0.5 shrink-0 rounded-md p-1.5 ${task.kind === 'project' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-sky-400/10 text-sky-300'}`}>
                        {task.kind === 'project' ? <FolderOpen size={12} /> : <Eye size={12} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-semibold text-white/85 truncate">{task.title || 'Untitled'}</div>
                        <div className="text-[9px] font-mono text-white/35 uppercase tracking-wider">
                          {task.kind} · {Object.keys(task.files || {}).length} files · {new Date(task.updatedAt || task.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 mt-2">
                      <button
                        onClick={() => openProjectTab(task)}
                        title={task.kind === 'project' ? 'Open / run in a full browser tab (sandboxed)' : 'Open in a full browser tab'}
                        className="flex-1 flex items-center justify-center gap-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 py-1.5 text-[9px] font-semibold text-white/80 cursor-pointer transition-colors"
                      >
                        {task.kind === 'project' ? <Play size={10} /> : <ExternalLink size={10} />}
                        {task.kind === 'project' ? 'Open / Run' : 'Open'}
                      </button>
                      <button
                        onClick={() => downloadTaskZip(task)}
                        title="Download all files as a .zip"
                        className="flex items-center justify-center gap-1 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 px-2 py-1.5 text-[9px] font-semibold text-white/80 cursor-pointer transition-colors"
                      >
                        <Download size={10} />
                      </button>
                      <button
                        onClick={() => deleteProject(task)}
                        title="Delete this project"
                        className="flex items-center justify-center rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 px-2 py-1.5 text-[9px] text-red-300/90 cursor-pointer transition-colors"
                      >
                        <Trash2 size={10} />
                      </button>
                      <button
                        onClick={() => startEditingTask(task)}
                        title="Edit this project — the next coding request will change its real files"
                        className="flex items-center justify-center rounded-lg bg-emerald-400/10 hover:bg-emerald-400/20 border border-emerald-400/25 px-2 py-1.5 text-[9px] text-emerald-300/90 cursor-pointer transition-colors"
                      >
                        <Pencil size={10} />
                        Edit
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Skills Dropdown (/skills) ────────────────────────────────── */}
        <AnimatePresence>
          {showSkillsPanel && (
            <motion.div
              initial={{ y: -16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -16, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 340, damping: 30 }}
              className="absolute left-3 right-3 top-[49px] z-40 bg-black/85 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl p-3 flex flex-col max-h-[340px]"
            >
              <div className="flex items-center justify-between pb-2 border-b border-white/10 shrink-0">
                <span className="text-xs font-bold text-white/60 tracking-wider font-mono flex items-center gap-2">
                  ACTIVE SKILLS
                  {skillsList.length > 0 && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      {skillsList.length}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={importAwesomeSkills}
                    disabled={skillsImporting}
                    title="Import bundled skills from ComposioHQ/awesome-claude-skills (Claude Code SKILL.md modules)"
                    className="text-white/40 hover:text-violet-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-wait p-1 flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider"
                  >
                    <Download size={11} className={skillsImporting ? 'animate-pulse' : ''} />
                    {skillsImporting ? 'Importing…' : 'Import'}
                  </button>
                  <button
                    onClick={async () => {
                      setSkillsRefresh(true)
                      await loadSkillsPanel()
                      setSkillsRefresh(false)
                    }}
                    disabled={skillsLoading || skillsRefresh}
                    title="Refresh skills"
                    className="text-white/40 hover:text-white/80 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-wait p-1"
                  >
                    <RefreshCw size={12} className={skillsLoading || skillsRefresh ? 'animate-spin' : ''} />
                  </button>
                  <button onClick={() => setShowSkillsPanel(false)} className="text-white/40 hover:text-white cursor-pointer transition-colors p-1">
                    <X size={14} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto space-y-1.5 scrollbar-thin mt-2">
                {skillsLoading ? (
                  <div className="text-center py-6 text-[11px] text-white/30 font-mono animate-pulse">Scanning learned skills…</div>
                ) : skillsError ? (
                  <div className="text-center py-6 text-[11px] text-rose-300/80 font-mono px-4">{skillsError}</div>
                ) : skillsList.length === 0 ? (
                  <div className="text-center py-6 text-[11px] text-white/30 font-mono px-4">
                    No learned skills yet.
                    <br />
                    <span className="text-white/40">Use Import ↑ to grab the bundled Claude Code skills, or try: /learn https://github.com/owner/repo</span>
                  </div>
                ) : (
                  skillsList.map((s) => (
                    <motion.div
                      key={s.id}
                      whileHover={{ scale: 1.01 }}
                      className="group p-2.5 rounded-xl border border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/15 transition-all"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[12px] font-semibold text-white truncate">{s.name}</div>
                          <div className="text-[9px] text-white/35 font-mono truncate">{s.sourceUrl}</div>
                        </div>
                        <button
                          onClick={() => unlearnSkill(s.id)}
                          title="Unlearn skill"
                          className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-rose-400 p-1 transition-all shrink-0 cursor-pointer"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <p className="mt-1 text-[10px] text-white/50 leading-relaxed line-clamp-2">{s.description}</p>
                      {s.keywords.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {s.keywords.slice(0, 6).map((k) => (
                            <span key={k} className="text-[8px] px-1.5 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/40 font-mono uppercase tracking-wider">
                              {k}
                            </span>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Messages Feed ─────────────────────────────────────────── */}
        <div
          ref={messagesContainerRef}
          className="relative z-10 flex-1 overflow-y-auto px-6 py-6 space-y-6 scrollbar-thin"
          style={{ minHeight: 220 }}
        >
          {/* Empty state */}
          {messages.length === 0 && !isStreaming && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="flex flex-col items-center justify-center h-full py-16 text-center select-none"
            >
              <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mb-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                <Zap size={20} className="text-white/30" />
              </div>
              <p className="text-white/30 text-sm font-sans">Ask anything. Enzo is ready.</p>
              <p className="text-white/15 text-xs mt-1 font-sans">Use the quick actions below to get started.</p>
              <button
                onClick={() => setShowHistoryDrawer(true)}
                className="mt-4 font-mono-display text-[9px] uppercase tracking-widest text-white/35 hover:text-white/80 transition-colors underline underline-offset-4 decoration-white/10 hover:decoration-white/30 cursor-pointer"
              >
                View previous sessions
              </button>
            </motion.div>
          )}

          <AnimatePresence initial={false}>
            {messages.map((m, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                className="space-y-1"
              >
                {m.role === 'user' ? (
                  <div className="flex items-end gap-3 justify-end">
                    <div className="max-w-[78%] bg-white/[0.06] backdrop-blur-sm border border-white/[0.09] rounded-2xl rounded-br-md px-4 py-3 text-white/90 text-[14px] leading-[1.65] font-sans tracking-[-0.01em]">
                      {m.text}
                    </div>
                    <div className="w-6 h-6 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-[9px] text-white/50 font-semibold shrink-0 mb-0.5 select-none">
                      Y
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center shrink-0 mt-1">
                      <Zap size={11} className="text-white/50" />
                    </div>
                    <div className="max-w-[86%] text-white/80 text-[14px] leading-[1.7] font-sans tracking-[-0.01em] w-full">
                      {isResearchMessage(m) ? (
                        dismissedWindows.includes(m.id || `m_${i}`) ? (
                          renderMessageContent(m.text)
                        ) : (
                          <ResearchWindow
                            title={`research.exe — ${m.mode === 'research' ? 'REPORT' : 'DEEP_DIVE'}`}
                            steps={m.researchSteps}
                            onDownload={() => handleDownloadPDF(m.text, i)}
                            downloading={downloadingPDF === i}
                            onCopy={() => navigator.clipboard.writeText(m.text)}
                            onClose={() => setDismissedWindows((prev) => [...prev, m.id || `m_${i}`])}
                          >
                            {renderMessageContent(m.text)}
                          </ResearchWindow>
                        )
                      ) : (
                        renderMessageContent(m.text)
                      )}

                      {/* Retained reasoning chain — thinking mode's actual
                          deliverable. Collapsed by default so it never buries
                          the answer, but it stays with the message instead of
                          being wiped when the stream ends. */}
                      {m.role === 'assistant' && m.reasoning && (
                        <div className="mt-3 border border-white/10 rounded-xl bg-white/[0.02] overflow-hidden max-w-xl">
                          <details className="group">
                            <summary className="flex items-center justify-between px-4 py-2.5 font-mono-display text-[9px] uppercase tracking-widest text-white/40 hover:text-white cursor-pointer select-none border-b border-transparent group-open:border-white/10 transition-colors">
                              <span>View Reasoning Chain</span>
                              <ChevronDown size={10} className="transform transition-transform group-open:rotate-180" />
                            </summary>
                            <pre className="p-4 text-xs font-mono whitespace-pre-wrap text-white/35">{m.reasoning}</pre>
                          </details>
                        </div>
                      )}

                      {/* Collapsible Research Steps (non-windowed messages only — the ResearchWindow shows its own sources ledger) */}
                      {m.role === 'assistant' && !isResearchMessage(m) && m.researchSteps && m.researchSteps.length > 0 && (
                        <div className="mt-3 border border-white/10 rounded-xl bg-white/[0.02] overflow-hidden max-w-xl">
                          <details className="group">
                            <summary className="flex items-center justify-between px-4 py-2.5 font-mono-display text-[9px] uppercase tracking-widest text-white/40 hover:text-white cursor-pointer select-none border-b border-transparent group-open:border-white/10 transition-colors">
                              <span>View Research Sources & Process ({m.researchSteps.length})</span>
                              <ChevronDown size={10} className="transform transition-transform group-open:rotate-180" />
                            </summary>
                            <div className="p-4 space-y-1.5 border-l border-white/10 pl-4 py-1 ml-4 my-2">
                              {m.researchSteps.map((step, idx) => {
                                const isSource = step.startsWith('🔍') && step.includes('\n')
                                const [headLine, urlLine] = isSource ? step.split('\n', 2) : [step, '']
                                const isSynthesizing = !isSource && (step.includes('synthesizing') || step.includes('Synthesis') || step.includes('synthesizing'))
                                const isWebResult = step.startsWith('📄') || step.startsWith('🌐') || (headLine.includes('[') && headLine.includes(']('))
                                
                                return (
                                  <div key={idx} className={`text-xs font-mono break-all whitespace-pre-wrap ${isSynthesizing ? 'text-white/60' : isWebResult ? 'text-white/80' : 'text-white/30'}`}>
                                    <span className="mr-2">{isSynthesizing ? '⚙' : isSource ? '🔍' : isWebResult ? '📄' : '✓'}</span>
                                    {isSource && urlLine ? (
                                      <>
                                        <span className="text-white/70 underline hover:text-white hover:underline cursor-pointer" onClick={() => navigator.clipboard.writeText(urlLine)} title="Click to copy URL">
                                          {headLine}
                                        </span>
                                        <a href={urlLine} target="_blank" rel="noopener noreferrer" className="ml-2 text-[10px] text-white/30 hover:text-white/60 no-underline hover:underline" title="Open in new tab">
                                          ↗
                                        </a>
                                      </>
                                    ) : (
                                      headLine
                                    )}
                                    {isSource && urlLine && (
                                      <div className="ml-6 flex items-center gap-2 text-[10px] text-white/20">
                                        <a href={urlLine} target="_blank" rel="noopener noreferrer" className="hover:text-white/60 underline break-all">
                                          {urlLine}
                                        </a>
                                        <button
                                          onClick={() => navigator.clipboard.writeText(urlLine)}
                                          className="text-white/20 hover:text-white/50 cursor-pointer"
                                          title="Copy URL"
                                        >
                                          <Copy size={9} />
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </details>
                        </div>
                      )}

                      {m.role === 'assistant' && !isStreaming && !isResearchMessage(m) && (
                        <div className="mt-2.5 flex items-center gap-2">
                          {shouldShowDownloadPDF(m) && (
                            <button
                              onClick={() => handleDownloadPDF(m.text, i)}
                              disabled={downloadingPDF === i}
                              className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 font-mono-display text-[9px] uppercase tracking-widest text-white/40 hover:text-white hover:border-white/20 transition-all bg-white/[0.01] disabled:opacity-50 cursor-pointer"
                            >
                              <Download size={10} />
                              <span>{downloadingPDF === i ? 'Generating PDF…' : 'Download PDF'}</span>
                            </button>
                          )}
                          <button
                            onClick={() => navigator.clipboard.writeText(m.text).then(() => { /* copied */ })}
                            className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 font-mono-display text-[9px] uppercase tracking-widest text-white/40 hover:text-white hover:border-white/20 transition-all bg-white/[0.01] cursor-pointer"
                          >
                            <Copy size={10} />
                            <span>Copy</span>
                          </button>
                        </div>
                      )}

                      {/* Per-message Live Preview — any reply carrying a full HTML
                          page gets a "Preview" affordance that opens it in the
                          side panel (identical to what auto-opens for coding). */}
                      {m.role === 'assistant' && !isStreaming && extractPreviewHtml(m.text) && (
                        <div className="mt-2.5">
                          <button
                            type="button"
                            onClick={() => handlePreviewMessage(m.text)}
                            className="flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 font-mono-display text-[9px] uppercase tracking-widest text-emerald-300/90 hover:text-white hover:border-emerald-400/50 hover:bg-emerald-400/20 transition-all cursor-pointer"
                          >
                            <Eye size={10} />
                            <span>Preview</span>
                            <ExternalLink size={9} className="opacity-70" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Agent activity — live tool/research steps, shown in ALL modes so
              the user can see the agent working (reading gmail, drafting, searching…).
              Collapsed by default: just the "Working…" text. Clicking the arrow
              expands it to reveal the list of web pages explored during research.
              In research mode the ResearchProgress panel renders its own ledger,
              so this generic panel is hidden during research streaming. */}
          {researchSteps.length > 0 && !(chatMode === 'research' && isStreaming) && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-1.5 border-l-2 border-white/20 pl-4 py-1 ml-10">
              <button
                type="button"
                onClick={() => setLedgerOpen((v) => !v)}
                className="flex items-center gap-1.5 group cursor-pointer select-none"
                aria-expanded={ledgerOpen}
              >
                <motion.span
                  animate={{ rotate: ledgerOpen ? 90 : 0 }}
                  transition={{ duration: 0.15 }}
                  className="text-white/30 group-hover:text-white/60 flex items-center"
                >
                  <ChevronDown size={11} />
                </motion.span>
                {isStreaming ? (
                  <TextShimmer duration={1.3} className="text-[10px] font-mono uppercase tracking-widest [--base-color:#8b8b8b] [--base-gradient-color:#a855f7] dark:[--base-color:#8b8b8b] dark:[--base-gradient-color:#a855f7]">
                    Working…
                  </TextShimmer>
                ) : (
                  <span className="text-[10px] font-mono uppercase tracking-widest text-white/40">
                    Explored {researchSteps.length} item{researchSteps.length === 1 ? '' : 's'}
                  </span>
                )}
              </button>
              {ledgerOpen &&
                researchSteps.map((step, idx) => {
                  // Split "🔍 [n] title — domain\nURL" ledger entries onto two lines
                  const isSource = step.startsWith('🔍') && step.includes('\n')
                  const [headLine, urlLine] = isSource ? step.split('\n', 2) : [step, '']
                  const isSynthesizing = !isSource && (step.includes('synthesizing') || step.includes('Synthesis'))
                  const isLast = idx === researchSteps.length - 1
                  return (
                    <div key={idx} className={`text-xs font-mono break-all whitespace-pre-wrap ${isLast && !isSource ? 'text-white/70 font-semibold' : 'text-white/35'}`}>
                      <span className="mr-2">{isLast && isStreaming ? '▸' : '✓'}</span>
                      {isSynthesizing && isLast && isStreaming ? (
                        <SynthesisTimer />
                      ) : (
                        headLine
                      )}
                      {isSource && urlLine && (
                        <div className="ml-6 text-[10px] text-white/25 truncate">{urlLine}</div>
                      )}
                    </div>
                  )
                })}
            </motion.div>
          )}

          {/* Thought chain */}
          {thoughtChain && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="ml-10 border border-white/[0.06] rounded-xl bg-white/[0.02] p-4 text-xs text-white/35 font-mono space-y-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[9px] uppercase tracking-widest text-white/50 font-bold">Reasoning Chain</span>
                <TextShimmer duration={1.5} className="text-[10px] font-mono [--base-color:#71717a] [--base-gradient-color:#8b5cf6] dark:[--base-color:#71717a] dark:[--base-gradient-color:#8b5cf6]">Processing…</TextShimmer>
              </div>
              <pre className="whitespace-pre-wrap">{thoughtChain}</pre>
            </motion.div>
          )}

          {/* Research progress — shows the search ledger as soon as steps
              arrive, BEFORE any report text streams. The radar-sweep panel
              carries its own live step ledger, so during research streaming
              the generic activity panel above stays hidden. */}
          {isStreaming && (autoRoutedMode ?? chatMode) === 'research' && researchSteps.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="flex items-start gap-3"
            >
              <div className="w-6 h-6 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center shrink-0 mt-1">
                <Zap size={11} className="text-white/50" />
              </div>
              <div className="max-w-[86%] text-white/80 text-[14px] leading-[1.7] font-sans tracking-[-0.01em] w-full">
                <ResearchProgress steps={researchSteps}>
                  {streamedText && (
                    <>
                      {renderMessageContent(streamedText)}
                      <motion.span
                        className="inline-block w-[1.5px] h-[15px] bg-emerald-400/80 ml-[2px] align-middle rounded-full"
                        animate={{ opacity: [1, 0] }}
                        transition={{ duration: 0.55, repeat: Infinity, ease: 'easeInOut' }}
                      />
                    </>
                  )}
                </ResearchProgress>
              </div>
            </motion.div>
          )}

          {/* Auto-retry / thunder-pause status: the backend is parked — either
              waiting out a provider cooldown after a rate-limit, or proactively
              pacing a long build at the provider's sustained-rate ceiling — and
              will resume the stream automatically where it stopped. */}
          {isStreaming && retryInfo && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="flex items-start gap-3"
            >
              <div className="w-6 h-6 rounded-full bg-amber-400/10 border border-amber-400/30 flex items-center justify-center shrink-0 mt-1">
                <Zap size={11} className="text-amber-300/90" />
              </div>
              <div className="flex flex-col gap-0.5 max-w-[86%]">
                <div className="flex items-center gap-2 text-[11px] font-mono text-amber-300/90">
                  <span className="inline-flex items-center gap-1.5">
                    <RefreshCw size={11} className="animate-spin [animation-duration:1.2s]" />
                    {retryInfo.status === 'pacing'
                      ? `${retryInfo.provider} at sustained-rate ceiling — pausing ~${Math.max(0, retryInfo.etaSec)}s`
                      : `${retryInfo.provider} rate-limited — auto-retrying in ~${Math.max(0, retryInfo.etaSec)}s`}
                  </span>
                  {retryInfo.cycle > 1 && (
                    <span className="text-[9px] text-white/30">(attempt {retryInfo.cycle})</span>
                  )}
                </div>
                <div className="text-[10px] text-white/40 font-sans">
                  {retryInfo.status === 'pacing'
                    ? 'Waiting out the provider per-minute limit so the build is not cut off — resumes automatically, keep this tab open.'
                    : 'The build resumes automatically from where it stopped. Keep this tab open.'}
                </div>
              </div>
            </motion.div>
          )}

          {/* Streaming wait dots (non-research, or research before any search steps) */}
          {isStreaming && !streamedText && !((autoRoutedMode ?? chatMode) === 'research' && researchSteps.length > 0) && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="flex items-start gap-3"
            >
              <div className="w-6 h-6 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center shrink-0 mt-1">
                <Zap size={11} className="text-white/50" />
              </div>
              <div className="flex flex-col gap-1.5 pt-2">
                <div className="flex gap-1.5 items-center">
                  {[0, 1, 2].map((i) => (
                    <motion.span
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-white/40"
                      animate={{ scale: [1, 1.5, 1], opacity: [0.3, 0.8, 0.3] }}
                      transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.22, ease: 'easeInOut' }}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-white/25 font-sans">
                    {autoContinuing ? `Auto-continuing build (${autoContinueCountRef.current}/${MAX_AUTO_CONTINUE})…` : isImageActive ? 'Generating image…' : (autoRoutedMode ?? chatMode) === 'research' ? 'Researching…' : (autoRoutedMode ?? chatMode) === 'thinking' ? 'Thinking…' : (autoRoutedMode ?? chatMode) === 'coding' ? 'Writing code…' : 'Thinking…'}
                  </span>
                  {autoRoutedMode && autoRoutedMode !== 'normal' && (
                    <span className="text-[9px] font-mono uppercase tracking-widest text-emerald-300/90 bg-emerald-400/10 border border-emerald-400/25 rounded-full px-2 py-0.5">
                      auto → {autoRoutedMode}
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* Streaming text — typewriter word-by-word (non-research, or research with no steps) */}
          {isStreaming && streamedText && !((autoRoutedMode ?? chatMode) === 'research' && researchSteps.length > 0) && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-start gap-3"
            >
              <div className="w-6 h-6 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center shrink-0 mt-1">
                <Zap size={11} className="text-white/50" />
              </div>
              <div className="max-w-[86%] text-white/80 text-[14px] leading-[1.7] font-sans tracking-[-0.01em] w-full">
                {autoRoutedMode && autoRoutedMode !== 'normal' && (
                  <div className="mb-1.5">
                    <span className="inline-flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest text-emerald-300/90 bg-emerald-400/10 border border-emerald-400/25 rounded-full px-2 py-0.5">
                      <Zap size={9} />
                      auto-routed → {autoRoutedMode}
                    </span>
                  </div>
                )}
                {renderMessageContent(streamedText)}
                <motion.span
                  className="inline-block w-[1.5px] h-[15px] bg-white/50 ml-[2px] align-middle rounded-full"
                  animate={{ opacity: [1, 0] }}
                  transition={{ duration: 0.55, repeat: Infinity, ease: 'easeInOut' }}
                />
              </div>
            </motion.div>
          )}
        </div>

        {/* ─── Composer — Claude/ChatGPT style ────────────────────── */}
        <div className="relative z-10 px-4 pb-4 pt-2">
          <form id="enzo-chat-form" onSubmit={handleSend}>
            {/* Editing banner — shown when the user picks "Edit" on a saved
                project: the next coding message will target that project's real
                files instead of starting a fresh build. */}
            <AnimatePresence>
              {editNotice && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="flex items-center justify-between gap-3 px-4 pt-2 pb-2 border-b border-emerald-400/15 bg-emerald-400/[0.04] rounded-t-2xl"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Pencil size={12} className="text-emerald-300 shrink-0" />
                    <span className="text-[10px] font-mono uppercase tracking-widest text-emerald-200/90 truncate">
                      Editing: {editNotice.title}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditNotice(null)}
                    title="Stop editing this project"
                    className="shrink-0 text-white/35 hover:text-white/80 cursor-pointer transition-colors"
                  >
                    <X size={12} />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
            {/* Outer glass container */}
            <div className="relative bg-black/40 backdrop-blur-2xl border border-white/[0.10] rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.07)] transition-all duration-300 focus-within:border-white/[0.18] focus-within:shadow-[0_8px_40px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.10)]">

              {/* Attached file chips */}
              <AnimatePresence>
                {attachedFiles.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex items-center gap-2 px-4 pt-3 pb-1 overflow-x-auto scrollbar-none border-b border-white/[0.06]"
                  >
                    {attachedFiles.map((file) => (
                      <motion.div
                        key={file.id}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        className="flex items-center gap-2 bg-white/[0.08] border border-white/[0.12] rounded-xl px-2.5 py-1.5 text-xs text-white shrink-0 group relative"
                      >
                        {file.isImage && file.previewUrl ? (
                          <img src={file.previewUrl} alt={file.name} className="w-5 h-5 rounded object-cover" />
                        ) : (
                          <Paperclip size={13} className="text-white/60 shrink-0" />
                        )}
                        <div className="flex flex-col min-w-0 max-w-[140px]">
                          <span className="truncate text-[11px] font-mono font-medium leading-tight">{file.name}</span>
                          <span className="text-[9px] font-mono text-white/40">{formatFileSize(file.size)}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeAttachment(file.id)}
                          className="text-white/40 hover:text-white/90 p-0.5 rounded-full hover:bg-white/10 transition-colors ml-1 cursor-pointer"
                        >
                          <X size={12} />
                        </button>
                      </motion.div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Text input row */}
              <div className="flex items-start gap-3 px-4 pt-3.5 pb-2">
                <textarea
                  rows={1}
                  ref={composerRef}
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value)
                    setHistoryIndex(-1)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSend(e as any)
                      handleKeyDown(e as any)
                    }
                  }}
                  disabled={isStreaming}
                  placeholder={isStreaming ? 'Generating response…' : 'Ask Enzo anything or drag & drop files…'}
                  data-tour-step="terminal-input"
                  className="flex-1 bg-transparent outline-none text-white/90 text-[14px] leading-[1.6] font-sans tracking-[-0.01em] placeholder:text-white/25 caret-white resize-none min-w-0 py-0.5 scrollbar-none"
                  style={{ height: 28, overflow: 'hidden' }}
                  autoFocus
                  spellCheck={false}
                />

                {/* Voice-to-text button (Web Speech API — Google/Apple cloud STT, highest accuracy free tier) */}
                {voice.isSupported && (
                  <motion.button
                    type="button"
                    onClick={voice.isListening ? stopVoice : startVoice}
                    disabled={isStreaming}
                    title={
                      voice.isListening
                        ? `Stop dictation (${voice.lang})${voice.lastConfidence != null ? ` — last word confidence ${(voice.lastConfidence * 100).toFixed(0)}%` : ''}`
                        : `Start dictation (${voice.lang}) — Chrome/Edge use Google's cloud STT for best accuracy`
                    }
                    whileHover={{ scale: isStreaming ? 1 : 1.05 }}
                    whileTap={{ scale: isStreaming ? 1 : 0.92 }}
                    className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-xl mt-0 transition-all ${
                      voice.isListening
                        ? 'bg-red-500/90 text-white shadow-[0_0_16px_rgba(239,68,68,0.5)] animate-pulse'
                        : isStreaming
                        ? 'bg-white/[0.06] text-white/20 cursor-not-allowed'
                        : 'bg-white/[0.06] text-white/60 hover:bg-white/[0.10] hover:text-white cursor-pointer'
                    }`}
                    aria-label={voice.isListening ? 'Stop dictation' : 'Start dictation'}
                    aria-pressed={voice.isListening}
                  >
                    {voice.isListening ? <MicOff size={14} strokeWidth={2.5} /> : <Mic size={14} strokeWidth={2.5} />}
                  </motion.button>
                )}

                {/* Send / Stop button — becomes a Stop (square) control while
                    the AI is generating, like real AI platforms. */}
                <motion.button
                  type={isStreaming ? 'button' : 'submit'}
                  onClick={isStreaming ? handleStop : undefined}
                  disabled={!isStreaming && !inputValue.trim() && attachedFiles.length === 0}
                  whileHover={(inputValue.trim() || attachedFiles.length > 0 || isStreaming) ? { scale: 1.05 } : {}}
                  whileTap={(inputValue.trim() || attachedFiles.length > 0 || isStreaming) ? { scale: 0.92 } : {}}
                  title={isStreaming ? 'Stop generating' : 'Send'}
                  aria-label={isStreaming ? 'Stop generating' : 'Send message'}
                  className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-xl mt-0 transition-all ${
                    isStreaming
                      ? 'bg-red-500/90 text-white hover:bg-red-500 shadow-[0_0_16px_rgba(239,68,68,0.4)] cursor-pointer'
                      : (inputValue.trim() || attachedFiles.length > 0)
                      ? 'bg-white text-black hover:bg-white/90 cursor-pointer shadow-[0_2px_12px_rgba(255,255,255,0.15)]'
                      : 'bg-white/[0.06] text-white/20 cursor-not-allowed'
                  }`}
                >
                  {isStreaming ? (
                    <motion.span
                      key="stop"
                      initial={{ scale: 0.6, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.6, opacity: 0 }}
                      className="flex items-center justify-center"
                    >
                      <Square size={11} strokeWidth={3} fill="currentColor" />
                    </motion.span>
                  ) : (
                    <ArrowUp size={14} strokeWidth={2.5} />
                  )}
                </motion.button>
              </div>

              {/* Divider */}
              <div className="mx-4 border-t border-white/[0.06]" />

              {/* Bottom toolbar */}
              <div className="flex items-center justify-between px-3 py-2.5">
                {/* Left: action icons */}
                <div className="flex items-center gap-0.5">
                  {voice.isSupported && (
                    <motion.button
                      type="button"
                      title={voice.isListening ? 'Stop dictation' : 'Voice typing (Google cloud STT, most accurate)'}
                      onClick={voice.isListening ? stopVoice : startVoice}
                      whileHover={{ scale: 1.12 }}
                      whileTap={{ scale: 0.9 }}
                      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
                        voice.isListening
                          ? 'text-red-400 bg-red-400/10 border border-red-400/20 animate-pulse'
                          : 'text-white/30 hover:text-white/70 hover:bg-white/[0.05]'
                      }`}
                    >
                      <Mic size={15} />
                    </motion.button>
                  )}
                  {[
                    { icon: <Plus size={16} />, title: 'Add attachment', action: () => fileInputRef.current?.click() },
                    { icon: <Paperclip size={15} />, title: 'Attach file', action: () => fileInputRef.current?.click(), active: attachedFiles.length > 0 },
                    { icon: <Globe size={15} />, title: 'Web search', action: () => setWebSearch(prev => !prev), active: webSearch },
                    { icon: <Brain size={15} />, title: 'Deep thinking mode', action: () => handleModeChange(chatMode === 'thinking' ? 'normal' : 'thinking'), active: chatMode === 'thinking' },
                    { icon: <Code2 size={15} />, title: 'Code mode', action: () => handleModeChange(chatMode === 'coding' ? 'normal' : 'coding'), active: chatMode === 'coding' },
                    { icon: <ImageIcon size={15} />, title: 'Image generation', action: () => handleModeChange(chatMode === 'image-gen' ? 'normal' : 'image-gen'), active: chatMode === 'image-gen' || isImageActive },
                    { icon: <Rocket size={15} />, title: 'Research mode', action: () => handleModeChange(chatMode === 'research' ? 'normal' : 'research'), active: chatMode === 'research' },
                    { icon: <PlugZap size={15} />, title: 'MCP connector', action: () => fileInputRef.current?.click() },
                  ].map(({ icon, title, action, active }, idx) => (
                    <motion.button
                      key={idx}
                      type="button"
                      title={title}
                      onClick={action}
                      whileHover={{ scale: 1.12 }}
                      whileTap={{ scale: 0.9 }}
                      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
                        active
                          ? 'text-white bg-white/10 border border-white/15'
                          : 'text-white/30 hover:text-white/70 hover:bg-white/[0.05]'
                      }`}
                    >
                      {icon}
                    </motion.button>
                  ))}
                </div>

                {/* Right: mode badge + voice status + hint */}
                <div className="flex items-center gap-2">
                  {voice.isListening && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="text-[10px] font-sans font-medium text-red-400 bg-red-400/10 border border-red-400/20 px-2 py-0.5 rounded-full flex items-center gap-1"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                      LISTENING
                    </motion.span>
                  )}
                  {voice.error && !voice.isListening && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      title={voice.error}
                      className="text-[10px] font-sans font-medium text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded-full"
                    >
                      mic error
                    </motion.span>
                  )}
                  {chatMode !== 'normal' && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="text-[10px] font-sans font-medium text-white/40 bg-white/[0.05] border border-white/[0.08] px-2 py-0.5 rounded-full capitalize"
                    >
                      {chatMode}
                    </motion.span>
                  )}
                  {autoRoutedMode && autoRoutedMode !== chatMode && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="text-[10px] font-sans font-medium text-emerald-300/90 bg-emerald-400/10 border border-emerald-400/25 px-2 py-0.5 rounded-full"
                    >
                      auto-routed → {autoRoutedMode}
                    </motion.span>
                  )}
                  <span className="text-[10px] text-white/20 font-sans hidden sm:inline">
                    ⏎ send · ⇧⏎ newline
                  </span>
                </div>
              </div>
            </div>
          </form>

          {/* Quick action chips — above composer */}
          <div className="flex items-center gap-1.5 mt-2.5 overflow-x-auto pb-0.5 scrollbar-none">
            {([
              { label: 'Explain code', icon: <Code2 size={12} />, action: () => { setInputValue('Explain this code: ') } },
              { label: 'Summarize', icon: <Layers size={12} />, action: () => { setInputValue('Summarize: ') } },
              { label: 'Write for me', icon: <Rocket size={12} />, action: () => { setInputValue('Write a ') } },
              { label: 'Debug', icon: <Cpu size={12} />, action: () => { setInputValue('Debug this: ') } },
              { label: 'Compare models', icon: <Palette size={12} />, action: () => { setInputValue('models'); handleSend({ preventDefault: () => {} } as any) } },
            ] as { label: string; icon: React.ReactNode; action: () => void }[]).map(({ label, icon, action }) => (
              <motion.button
                key={label}
                type="button"
                onClick={action}
                whileHover={{ scale: 1.03, y: -1 }}
                whileTap={{ scale: 0.97 }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] text-white/40 hover:text-white/70 hover:border-white/[0.15] hover:bg-white/[0.06] text-[11px] font-sans transition-all shrink-0 cursor-pointer"
              >
                {icon}
                <span>{label}</span>
              </motion.button>
            ))}
          </div>
        </div>
    </>)

    const mobileMenuContent = (<>
        {/* Active model card */}
        <div className={`mobile-menu-glass rounded-2xl p-4 border border-white/10 relative transition-all ${showModelPicker ? 'z-50' : 'z-10'}`}>
          <div className="flex items-center justify-between">
            <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50">
              Active Node
            </div>
            {availableCatalog.length > 0 && (
              <button
                onClick={() => { setShowModelPicker(!showModelPicker); setModelSearch('') }}
                className="text-[9px] font-mono-display uppercase tracking-wider text-white/70 hover:text-white hover:underline flex items-center gap-1 cursor-pointer transition-colors"
              >
                <span>Switch</span>
                <ChevronDown size={10} className={showModelPicker ? 'rotate-180 transition-transform' : 'transition-transform'} />
              </button>
            )}
          </div>
          <div className="mt-1 font-garamond text-2xl font-normal text-white truncate">
            {activeModel.name}
          </div>
          <div className="mt-1 font-mono-display text-[9px] uppercase tracking-wider text-white/70">
            {activeModel.provider} · {activeModel.free ? 'FREE' : 'PAID'}
          </div>
          <p className="mt-2 text-xs text-white/50 leading-relaxed line-clamp-3">
            {activeModel.description || 'Unified architecture engine node.'}
          </p>

          {/* Model picker overlay inside Active Node card */}
          {showModelPicker && availableCatalog.length > 0 && (() => {
            const q = modelSearch.trim().toLowerCase()
            const matchesSearch = (m: typeof availableCatalog[0]) =>
              !q ||
              m.name.toLowerCase().includes(q) ||
              (m.provider || '').toLowerCase().includes(q) ||
              (m.description || '').toLowerCase().includes(q)

            const filteredRecommended = recommendedModel && matchesSearch(recommendedModel) ? recommendedModel : null
            const filteredGroups = Object.entries(groupedCatalog).map(([key, group]) => ({
              key,
              label: group.label,
              models: group.models.filter(matchesSearch),
            })).filter(g => g.models.length > 0)
            const hasResults = filteredRecommended || filteredGroups.length > 0

            return (
              <div className="absolute left-0 top-full mt-2 w-72 bg-[#0c0d14] border border-white/20 rounded-xl p-2.5 z-[100] shadow-[0_20px_60px_rgba(0,0,0,0.95)] space-y-3 scrollbar-thin flex flex-col max-h-[420px]">
                {/* Header */}
                <div className="flex items-center justify-between px-2 py-1 border-b border-white/10 select-none shrink-0">
                  <span className="text-[10px] font-bold text-white/50 uppercase tracking-widest">
                    Select Model Node
                  </span>
                  <button
                    onClick={async () => {
                      if (refreshingCatalog || !onRefreshCatalog) return
                      setRefreshingCatalog(true)
                      try {
                        await onRefreshCatalog()
                      } finally {
                        setRefreshingCatalog(false)
                      }
                    }}
                    disabled={refreshingCatalog}
                    title="Clear cache & fetch fresh models"
                    className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-white/40 hover:text-white/80 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                  >
                    <RefreshCw size={11} className={refreshingCatalog ? 'animate-spin' : ''} />
                    {refreshingCatalog ? 'Syncing' : 'Refresh'}
                  </button>
                </div>

                {/* Search input */}
                <div className="relative shrink-0 px-0.5">
                  <Search size={11} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none" />
                  <input
                    ref={modelSearchRef}
                    autoFocus
                    type="text"
                    value={modelSearch}
                    onChange={e => setModelSearch(e.target.value)}
                    placeholder="Search models…"
                    className="w-full bg-white/5 border border-white/10 rounded-lg pl-7 pr-3 py-1.5 text-xs text-white placeholder-white/25 outline-none focus:border-white/25 focus:bg-white/8 transition-all font-mono"
                  />
                  {modelSearch && (
                    <button
                      onClick={() => setModelSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors cursor-pointer"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>

                {/* Scrollable results */}
                <div className="overflow-y-auto space-y-3 scrollbar-thin pr-0.5">
                  {!hasResults && (
                    <div className="px-2 py-6 text-center text-[11px] text-white/30 font-mono">
                      No models match &quot;{modelSearch}&quot;
                    </div>
                  )}

                  {/* Recommended Node Section */}
                  {filteredRecommended && (
                    <div className="space-y-1">
                      <div className="text-[8px] font-bold text-emerald-400 uppercase tracking-widest px-2 py-0.5 select-none flex items-center gap-1">
                        <span>★</span> Recommended Option
                      </div>
                      <button
                        onClick={() => {
                          setActiveModel(filteredRecommended)
                          setShowModelPicker(false)
                          setModelSearch('')
                        }}
                        onMouseEnter={() => setHoveredModel(filteredRecommended)}
                        onMouseLeave={() => setHoveredModel(null)}
                        className={`w-full text-left p-2 rounded-lg text-xs font-mono transition-all flex items-center justify-between cursor-pointer border ${
                          filteredRecommended.id === activeModel.id
                            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold'
                            : 'bg-emerald-500/5 text-emerald-400/90 border-emerald-500/10 hover:bg-emerald-500/10 hover:border-emerald-500/20'
                        }`}
                      >
                        <span className="truncate">{filteredRecommended.name}</span>
                        <span className="flex items-center gap-1.5 shrink-0 ml-2">
                          {(() => {
                            const chip = modelHealthChip(filteredRecommended)
                            return chip ? (
                              <span title={chip.title} className={`text-[9px] font-bold ${chip.cls}`}>{chip.text}</span>
                            ) : null
                          })()}
                          <span className="text-[8px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300">SUGGESTED</span>
                        </span>
                      </button>
                    </div>
                  )}

                  {/* Categorized Catalog Sections */}
                  {filteredGroups.map(({ key, label, models }) => (
                    <div key={key} className="space-y-1">
                      <div className="text-[8px] font-bold text-white/30 uppercase tracking-widest px-2 pt-1 select-none">
                        {label}
                      </div>
                      <div className="space-y-0.5">
                        {models.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => {
                              setActiveModel(m)
                              setShowModelPicker(false)
                              setModelSearch('')
                            }}
                            onMouseEnter={() => setHoveredModel(m)}
                            onMouseLeave={() => setHoveredModel(null)}
                            className={`w-full text-left p-2 rounded-lg text-xs font-mono transition-all flex items-center justify-between cursor-pointer ${
                              m.id === activeModel.id
                                ? 'bg-white/15 text-white border border-white/30 font-bold'
                                : 'text-white/70 hover:bg-white/10 hover:text-white'
                            }`}
                          >
                            <span className="truncate">{m.name}</span>
                            <span className="flex items-center gap-1.5 shrink-0 ml-2">
                              {(() => {
                                const chip = modelHealthChip(m)
                                return chip ? (
                                  <span title={chip.title} className={`text-[9px] font-bold ${chip.cls}`}>{chip.text}</span>
                                ) : null
                              })()}
                              <span className="text-[9px] opacity-60">{m.provider}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Model telemetry tooltip dialog card */}
          {showModelPicker && hoveredModel && (() => {
            const telemetry = getModelTelemetry(hoveredModel)
            const isRecommended = recommendedModel?.id === hoveredModel.id
            return (
              <div className="absolute left-full top-0 ml-3 w-80 max-h-[75vh] overflow-y-auto bg-[#0c0d14] border border-white/20 rounded-xl p-4 shadow-[0_20px_50px_rgba(0,0,0,0.9)] backdrop-blur-2xl text-xs space-y-3 z-[110] select-none text-left animate-in fade-in slide-in-from-left-2 duration-150">
                <div className="sticky top-0 -mt-4 -mx-4 px-4 pt-4 pb-2 bg-[#0c0d14]/95 backdrop-blur-sm">
                  <div className="text-[9px] uppercase tracking-widest text-white/40">Model Telemetry</div>
                  <div className="text-sm font-semibold text-white mt-0.5 truncate">{hoveredModel.name}</div>
                  <div className="text-[10px] text-white/50 mt-0.5">{hoveredModel.provider} · {hoveredModel.free ? 'FREE' : 'PAID'}</div>
                </div>

                {isRecommended && (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 text-emerald-300 text-[11px] leading-relaxed">
                    <span className="font-semibold block mb-0.5 text-[9px] uppercase tracking-wider">★ Dynamic AI Suggestion</span>
                    {recommendationReason}
                  </div>
                )}

                {(() => {
                  const prov = (hoveredModel.provider || '').toLowerCase()
                  const isHf = prov === 'huggingface' || prov === 'hf' || hoveredModel.id.startsWith('hf/')
                  const isNvidia = prov === 'nvidia' || hoveredModel.id.startsWith('nvidia/')
                  const isOr = prov === 'openrouter' || hoveredModel.id.startsWith('openrouter/')
                  const isLlm7 = prov === 'llm7' || hoveredModel.id.startsWith('llm7/')
                  const isGoogle = prov === 'google' || prov === 'gemini' || hoveredModel.id.startsWith('google/')
                  const isPuter = prov === 'puter' || hoveredModel.id.startsWith('puter/')

                  let keyStatus: { hasKey: boolean; name: string; url: string; urlText: string; isOptional?: boolean } | null = null
                  if (isHf) {
                    const hasKey = !!(keyVault.getItem('enzo.keys.huggingface') || keyVault.getItem('enzo-huggingface-key'))
                    keyStatus = { hasKey, name: 'Hugging Face Token', url: 'https://huggingface.co/settings/tokens', urlText: 'Get Token at huggingface.co ↗' }
                  } else if (isNvidia) {
                    const hasKey = !!(keyVault.getItem('enzo.keys.nvidia') || keyVault.getItem('enzo-nvidia-key'))
                    keyStatus = { hasKey, name: 'NVIDIA NIM Key', url: 'https://build.nvidia.com', urlText: 'Get Key at build.nvidia.com ↗' }
                  } else if (isOr) {
                    const hasKey = !!(keyVault.getItem('enzo.keys.openrouter') || keyVault.getItem('enzo-openrouter-key'))
                    keyStatus = { hasKey, name: 'OpenRouter Key', url: 'https://openrouter.ai/keys', urlText: 'Get Key at openrouter.ai ↗' }
                  } else if (isLlm7) {
                    const hasKey = !!keyVault.getItem('enzo.keys.llm7')
                    keyStatus = { hasKey, name: 'LLM7 Token', url: 'https://dash.llm7.io', urlText: 'Get Free Token at dash.llm7.io ↗' }
                  } else if (isGoogle) {
                    const hasKey = !!(keyVault.getItem('enzo.keys.google') || keyVault.getItem('enzo.keys.gemini'))
                    keyStatus = { hasKey, name: 'Google Gemini Key', url: 'https://aistudio.google.com/apikey', urlText: 'Get Free Key at aistudio.google.com ↗' }
                  } else if (isPuter) {
                    const hasKey = !!keyVault.getItem('enzo.keys.puter')
                    keyStatus = { hasKey, name: 'Puter Auth Token', url: 'https://puter.com/dashboard', urlText: 'Create Token at puter.com/dashboard ↗' }
                  }

                  if (!keyStatus) return null

                  return (
                    <div className={`p-2 rounded-lg border text-[11px] font-mono ${
                      keyStatus.hasKey
                        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                        : keyStatus.isOptional
                          ? 'bg-white/[0.03] border-white/10 text-white/50'
                          : 'bg-amber-500/10 border-amber-500/20 text-amber-200'
                    }`}>
                      <div className="flex items-center justify-between font-bold text-[9px] uppercase tracking-wider mb-0.5">
                        <span>{keyStatus.name}</span>
                        <span>{keyStatus.hasKey ? '✓ Active' : keyStatus.isOptional ? '⚡ Optional' : '⚠️ Missing'}</span>
                      </div>
                      {!keyStatus.hasKey && (
                        <a
                          href={keyStatus.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[9px] uppercase font-bold text-cyan-400 hover:text-cyan-300 underline underline-offset-2 block mt-1"
                        >
                          {keyStatus.urlText}
                        </a>
                      )}
                    </div>
                  )
                })()}

                <div className="space-y-2 pt-1 border-t border-white/[0.06]">
                  {(() => {
                    const info = liveInfo?.id === hoveredModel.id ? liveInfo.info : null
                    const specsLine = [
                      info?.context || `${(hoveredModel.context_length / 1000).toFixed(0)}K context`,
                      info?.pricing || (hoveredModel.free ? 'Free' : hoveredModel.pricing_prompt),
                      info?.architecture,
                      `max ${hoveredModel.max_output} out`,
                    ].filter(Boolean).join('  ·  ')

                    // Assemble the fields present, then type them out in sequence.
                    const fields: { label: string; text: string; mono?: boolean }[] = []
                    if (hoveredModel.health) {
                      const h = hoveredModel.health
                      const stateText =
                        h.status === 'online'
                          ? '● online'
                          : h.status === 'degraded'
                            ? '● degraded'
                            : h.status === 'offline'
                              ? `● offline (${h.error || 'unreachable'})`
                              : h.status === 'n/a'
                                ? 'not probed (image generation)'
                                : 'unverified'
                      fields.push({ label: 'Health', text: `${stateText} · checked ${timeAgo(h.checkedAt)}` })
                    }
                    fields.push({
                      label: 'Latency / Speed',
                      text:
                        hoveredModel.health && (hoveredModel.health.status === 'online' || hoveredModel.health.status === 'degraded')
                          ? `Measured ${formatLatency(hoveredModel.health.latencyMs)} (real probe)`
                          : info?.speed || telemetry.speed,
                    })
                    fields.push({
                      label: 'Key Strengths',
                      text: info?.strengths.length ? info.strengths.join(' · ') : telemetry.strengths,
                    })
                    fields.push({
                      label: 'Limitations / Weaknesses',
                      text: info?.weaknesses.length ? info.weaknesses.join(' · ') : telemetry.weaknesses,
                    })
                    if (info?.bestFor.length) fields.push({ label: 'Best For', text: info.bestFor.join(' · ') })
                    fields.push({ label: 'Specs', text: specsLine, mono: true })
                    if (info?.benchmarks) fields.push({ label: 'Benchmarks', text: info.benchmarks, mono: true })
                    if (info?.release) fields.push({ label: 'Release', text: info.release })
                    const overview = info?.summary || hoveredModel.description || ''
                    if (overview) fields.push({ label: 'Overview', text: overview })

                    let acc = 0
                    return (
                      <>
                        {fields.map((f) => {
                          const delay = acc
                          acc += 250 + Math.min(f.text.length * 11, 1400) // stagger by typing time
                          return (
                            <div key={f.label}>
                              <span className="text-[10px] uppercase tracking-wider text-white/30 block flex items-center gap-1">
                                {f.label}
                                {f.label === 'Latency / Speed' && !info && (
                                  <span className="text-white/20 normal-case tracking-normal">· researching…</span>
                                )}
                              </span>
                              <span className={`text-white/75 leading-relaxed block ${f.mono ? 'font-mono text-[10px]' : ''}`}>
                                <Typewriter text={f.text} delay={delay} />
                              </span>
                            </div>
                          )
                        })}
                        {info && (
                          <div className="pt-1 flex items-center gap-1 text-[9px] text-emerald-400/60 uppercase tracking-wider">
                            <span className="w-1 h-1 rounded-full bg-emerald-400/70" /> live · web-sourced · daily
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            )
          })()}
        </div>

        {isImageActive ? (
          <div className="mobile-menu-glass rounded-2xl p-4 border border-white/10 flex flex-col gap-4 text-left">
            <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50 mb-1">
              Image Settings
            </div>

            <div>
              <label className="font-mono-display text-[8px] uppercase tracking-wider text-white/40 block mb-1">
                Model
              </label>
              <select
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value)}
                className="w-full bg-[#0d0d18]/60 border border-white/10 rounded-lg px-2.5 py-1.5 font-mono-display text-[10px] text-white focus:outline-none focus:border-white/20"
              >
                <optgroup label="Free" className="bg-[#0b0b0b]">
                  <option value="flux" className="bg-[#0b0b0b]">FLUX.1 Schnell</option>
                  <option value="zimage" className="bg-[#0b0b0b]">Z-Image Turbo</option>
                  <option value="kontext" className="bg-[#0b0b0b]">FLUX.1 Kontext</option>
                  <option value="gptimage" className="bg-[#0b0b0b]">GPT Image Mini</option>
                  <option value="nova-canvas" className="bg-[#0b0b0b]">Amazon Nova Canvas</option>
                  <option value="dreamshaper" className="bg-[#0b0b0b]">DreamShaper 8</option>
                </optgroup>
                {/* Non-Pollinations path. Both honour explicit width/height (SDXL up to
                    2048), so these are the ones that render an FHD/2K request natively
                    instead of handing back a 1024 square. */}
                <optgroup label="Cloudflare Workers AI — needs Cloudflare key" className="bg-[#0b0b0b]">
                  <option value="cloudflare/@cf/stabilityai/stable-diffusion-xl-base-1.0" className="bg-[#0b0b0b]">SDXL Base 1.0</option>
                  <option value="cloudflare/@cf/black-forest-labs/flux-1-schnell" className="bg-[#0b0b0b]">FLUX.1 Schnell (CF)</option>
                </optgroup>
                <optgroup label="Premium — needs Pollinations key" className="bg-[#0b0b0b]">
                  <option value="nanobanana" className="bg-[#0b0b0b]">Nano Banana (Google)</option>
                  <option value="nanobanana-pro" className="bg-[#0b0b0b]">Nano Banana Pro</option>
                  <option value="seedream" className="bg-[#0b0b0b]">Seedream 4.0 (ByteDance)</option>
                  <option value="seedream-pro" className="bg-[#0b0b0b]">Seedream 4.5 Pro</option>
                  <option value="gpt-image-2" className="bg-[#0b0b0b]">GPT Image 2 (OpenAI)</option>
                </optgroup>
              </select>
              <p className="font-mono-display text-[7px] text-white/30 mt-1 leading-tight">
                Keyless Pollinations caps near 1024px. A Pollinations or Cloudflare key unlocks native HD/FHD/2K.
              </p>
            </div>

            <div>
              <label className="font-mono-display text-[8px] uppercase tracking-wider text-white/40 block mb-1">
                Quality
              </label>
              <select
                value={imageQuality}
                onChange={(e) => setImageQuality(e.target.value)}
                className="w-full bg-[#0d0d18]/60 border border-white/10 rounded-lg px-2.5 py-1.5 font-mono-display text-[10px] text-white focus:outline-none focus:border-white/20"
              >
                <option value="hd" className="bg-[#0b0b0b]">HD (720p-class)</option>
                <option value="fhd" className="bg-[#0b0b0b]">Full HD (1080p)</option>
                <option value="2k" className="bg-[#0b0b0b]">2K / QHD (1440p)</option>
              </select>
            </div>

            <div>
              <label className="font-mono-display text-[8px] uppercase tracking-wider text-white/40 block mb-1">
                Aspect Ratio
              </label>
              <select
                value={imageAspect}
                onChange={(e) => setImageAspect(e.target.value)}
                className="w-full bg-[#0d0d18]/60 border border-white/10 rounded-lg px-2.5 py-1.5 font-mono-display text-[10px] text-white focus:outline-none focus:border-white/20"
              >
                <option value="1:1" className="bg-[#0b0b0b]">
                  1:1 (Square)
                </option>
                <option value="16:9" className="bg-[#0b0b0b]">
                  16:9 (Landscape)
                </option>
                <option value="9:16" className="bg-[#0b0b0b]">
                  9:16 (Portrait)
                </option>
                <option value="21:9" className="bg-[#0b0b0b]">
                  21:9 (Cinematic)
                </option>
              </select>
            </div>

            <div>
              <label className="font-mono-display text-[8px] uppercase tracking-wider text-white/40 block mb-1">
                Negative Prompt
              </label>
              <input
                type="text"
                value={imageNegative}
                onChange={(e) => setImageNegative(e.target.value)}
                placeholder="e.g. lowres, watermark"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 font-mono-display text-[10px] text-white focus:outline-none focus:border-white/20 placeholder:text-white/25"
              />
            </div>

            <div>
              <label className="font-mono-display text-[8px] uppercase tracking-wider text-white/40 block mb-1">
                Seed (blank = random)
              </label>
              <div className="flex gap-1.5">
                <input
                  type="number"
                  value={imageSeed}
                  onChange={(e) => setImageSeed(e.target.value)}
                  placeholder="random"
                  className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 font-mono-display text-[10px] text-white focus:outline-none focus:border-white/20 placeholder:text-white/25"
                />
                <button
                  type="button"
                  onClick={() => setImageSeed(String(Math.floor(Math.random() * 1_000_000)))}
                  className="shrink-0 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/5 font-mono-display text-[9px] uppercase tracking-wider text-white/60 hover:text-white hover:border-white/20 transition-colors cursor-pointer"
                  title="Randomize seed"
                >
                  ⟳
                </button>
              </div>
            </div>

            <ToggleSwitch label="Uncensored Mode" value={imageUncensored} onChange={setImageUncensored} />
          </div>
        ) : (
          <>
            {/* Cognitive Mode options */}
            <div className="mobile-menu-glass rounded-2xl p-4 border border-white/10 flex flex-col gap-2">
              <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50 mb-1">
                Cognitive Mode
              </div>
              {([
                { id: 'normal', icon: '▸' },
                { id: 'thinking', icon: '◆' },
                { id: 'research', icon: '❖' },
                { id: 'coding', icon: '⌘' },
                { id: 'image-gen', icon: '🖼' },
              ] as const).map(({ id, icon }) => (
                <button
                  key={id}
                  onClick={() => handleModeChange(id)}
                  className={`flex items-center gap-2 rounded-lg px-3 py-1.5 font-mono-display text-[10px] uppercase tracking-widest border transition-all text-left cursor-pointer ${
                    chatMode === id
                      ? 'bg-white/10 border-white/30 text-white shadow-inner font-bold'
                      : 'bg-transparent border-transparent text-white/60 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <span>{icon}</span>
                  <span>{id === 'image-gen' ? 'Image Gen' : id}</span>
                </button>
              ))}
            </div>

            {/* Augments options with customized neo-toggle switches */}
            <div className="mobile-menu-glass rounded-2xl p-4 border border-white/10 flex flex-col gap-3">
              <div className="font-mono-display text-[9px] uppercase tracking-widest text-white/50">
                Augments
              </div>
              <ToggleSwitch label="Web Search" value={webSearch} onChange={setWebSearch} />
              <ToggleSwitch label="Auto Fallback" value={autoFallback} onChange={setAutoFallback} />
              <ToggleSwitch label="Incognito" value={isIncognito} onChange={setIsIncognito} />
              <ToggleSwitch label="Roast Mode" value={isRoasting} onChange={setIsRoasting} />

              <div className="flex gap-2 mt-1">
                <button
                  onClick={startNewChat}
                  className="flex-1 rounded-lg border border-white/10 px-2 py-2 font-mono-display text-[9px] uppercase tracking-widest text-white/70 transition-colors hover:border-white/30 hover:text-white flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Plus size={11} />
                  <span>New chat</span>
                </button>
                <button
                  onClick={() => setShowHistoryDrawer(!showHistoryDrawer)}
                  className="flex-1 rounded-lg border border-white/10 px-2 py-2 font-mono-display text-[9px] uppercase tracking-widest text-white/70 transition-colors hover:border-white/30 hover:text-white flex items-center justify-center gap-1 cursor-pointer"
                >
                  <History size={11} />
                  <span>History</span>
                </button>
                <button
                  onClick={clearHistory}
                  className="rounded-lg border border-white/10 px-2 py-2 font-mono-display text-[9px] uppercase tracking-widest text-white/50 transition-colors hover:border-rose-500/40 hover:text-rose-400 cursor-pointer"
                >
                  Clear
                </button>
              </div>
            </div>

            {/* Service Connections */}
            <ServiceConnections />
          </>
        )}
    </>)

    return (
      <div className="grid gap-6 lg:grid-cols-[240px_1fr] font-mono-display">
    {/* Side settings bar */}
    <div className="flex flex-col gap-4">
      {mobileMenuContent}
    </div>

    {/* Terminal window — premium translucent layout with drag-and-drop support */}
    <div
      ref={termDockedRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="w-full flex flex-col relative overflow-hidden rounded-2xl h-[600px]"
    >
      {terminalChrome}
      {terminalHeader}
      {terminalBody}
    </div>

    {/* ─── Maximized terminal — Claude-style true fullscreen (portal, GSAP in/out) ─── */}
    {maxShown && createPortal(
      <div ref={maxRootRef} className="fixed inset-0 z-[600] flex flex-col gap-2 p-2 bg-black/85 backdrop-blur-md">
        {/* Header drawer — Terminal / Marketplace / Vault nav (hidden by default;
            same open/close pattern as the overview panel) */}
        <div
          ref={maxHeaderRef}
          style={{ height: 0 }}
          className="max-header overflow-hidden shrink-0 pointer-events-none"
        >
          <div className="pointer-events-auto w-full">
            <div className="w-full rounded-full border border-white/10 bg-[#06070c]/60 backdrop-blur-2xl px-6 py-2.5 shadow-[0_8px_32px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-white/[0.03] flex items-center justify-between">
              <span className="font-mono-display text-[11px] uppercase tracking-[0.3em] text-white/50">ENZO</span>
              <div className="flex items-center gap-1">
                {(['marketplace', 'terminal', 'vault'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab?.(tab)}
                    className={`relative font-mono-display text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 rounded-full transition-all duration-300 cursor-pointer ${
                      activeTab === tab ? 'text-white' : 'text-white/45 hover:text-white/90'
                    }`}
                  >
                    {activeTab === tab && (
                      <span className="absolute inset-0 rounded-full bg-white/10 border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" />
                    )}
                    <span className="relative z-10">{tab}</span>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5 text-[10px] font-mono text-white/35">
                  ONLINE
                </span>
                <button
                  type="button"
                  onClick={() => setMaxHeaderOpen(false)}
                  title="Hide header bar"
                  className="w-5 h-5 flex items-center justify-center rounded-full text-white/40 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                >
                  <X size={11} strokeWidth={2.5} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Row: overview panel + terminal */}
        <div className="flex gap-2 flex-1 min-h-0">
          {/* Overview panel — hidden by default; summoned by the floating tab */}
          <div
            ref={maxPanelRef}
            style={{ width: 0 }}
            className="max-panel overflow-hidden shrink-0 pointer-events-none"
          >
            <div className="w-[240px] h-full overflow-y-auto scrollbar-thin p-3 flex flex-col gap-4 bg-black/40 backdrop-blur-md border-r border-white/10 pointer-events-auto">
              {mobileMenuContent}
            </div>
          </div>

          {/* Separate floating access tab — not a traffic light */}
          <FloatPanelTab open={maxPanelOpen} onToggle={() => setMaxPanelOpen((v) => !v)} />

          {/* Terminal fills the remaining space */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="flex-1 relative overflow-hidden rounded-xl border border-white/[0.08] flex flex-col"
          >
            {terminalChrome}
            {terminalHeader}
            {!termMinimized && terminalBody}
          </div>
        </div>

        {/* Floating header handle — separate from traffic lights; hidden while
            the header drawer is open (the drawer has its own ✕) */}
        {!maxHeaderOpen && (
          <FloatTopBarTab open={false} onToggle={() => setMaxHeaderOpen(true)} />
        )}
      </div>,
      document.body,
    )}


      {/* Research Depth Dialog — appears in normal mode when research intent is detected */}
      {researchPromptDialog?.show && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)' }}
        >
          <div
            className="relative w-full max-w-sm mx-4 rounded-2xl border overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, rgba(10,10,16,0.98) 0%, rgba(18,18,28,0.98) 100%)',
              borderColor: 'rgba(255,255,255,0.08)',
              boxShadow: '0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)',
            }}
          >
            {/* Accent glow bar */}
            <div
              className="absolute top-0 left-0 right-0 h-0.5"
              style={{ background: 'linear-gradient(90deg, transparent, rgba(99,102,241,0.8), rgba(139,92,246,0.8), transparent)' }}
            />

            <div className="p-6">
              {/* Icon + Title */}
              <div className="flex items-center gap-3 mb-3">
                <div
                  className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.2)' }}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="rgba(139,92,246,1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                </div>
                <div>
                  <div className="font-mono-display text-[11px] uppercase tracking-widest text-white/40 mb-0.5">Research Query Detected</div>
                  <div className="text-white font-semibold text-sm">Choose research depth</div>
                </div>
              </div>

              {/* Query preview */}
              <div
                className="rounded-xl px-3 py-2.5 mb-5 font-mono-display text-[10px] text-white/50 leading-relaxed"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <span className="text-white/30 mr-1.5">"</span>
                {researchPromptDialog.pendingMessage.length > 120
                  ? researchPromptDialog.pendingMessage.slice(0, 120) + '…'
                  : researchPromptDialog.pendingMessage}
                <span className="text-white/30 ml-0.5">"</span>
              </div>

              {/* Choice buttons */}
              <div className="flex flex-col gap-2.5">
                <button
                  onClick={() => handleResearchDialogChoice('surface', researchPromptDialog.pendingMessage)}
                  className="group w-full rounded-xl p-3.5 text-left transition-all duration-200 cursor-pointer"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.07)'
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.2)' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(74,222,128,1)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6"/>
                      </svg>
                    </div>
                    <div>
                      <div className="text-white text-[12px] font-semibold mb-0.5">Surface Search</div>
                      <div className="text-white/40 text-[10px] font-mono-display leading-relaxed">Quick web lookup · stays in normal mode · fast answer</div>
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => handleResearchDialogChoice('deep', researchPromptDialog.pendingMessage)}
                  className="group w-full rounded-xl p-3.5 text-left transition-all duration-200 cursor-pointer"
                  style={{
                    background: 'rgba(99,102,241,0.08)',
                    border: '1px solid rgba(99,102,241,0.2)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(99,102,241,0.14)'
                    e.currentTarget.style.borderColor = 'rgba(99,102,241,0.35)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(99,102,241,0.08)'
                    e.currentTarget.style.borderColor = 'rgba(99,102,241,0.2)'
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(139,92,246,1)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                      </svg>
                    </div>
                    <div>
                      <div className="text-white text-[12px] font-semibold mb-0.5">Deep Research <span className="text-[10px] text-indigo-400 ml-1 font-mono-display uppercase tracking-widest">Mode switch</span></div>
                      <div className="text-white/40 text-[10px] font-mono-display leading-relaxed">Multi-source synthesis · switches to research mode · comprehensive report</div>
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => setResearchPromptDialog(null)}
                  className="w-full text-center text-[10px] text-white/30 hover:text-white/50 font-mono-display uppercase tracking-widest py-1 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Permission Request Dialog */}
      <PermissionRequestDialog
        isOpen={permissionDialog.isOpen}
        onClose={() => setPermissionDialog({ isOpen: false, service: 'google' })}
        service={permissionDialog.service}
        authUrl={permissionDialog.authUrl}
        onConnect={() => {
          setPermissionDialog({ isOpen: false, service: 'google' })
          // Refresh to check connection status
          window.location.reload()
        }}
      />

      {/* Inline Permission Prompt (shown in chat) */}
      {inlinePermission?.show && (
        <div className="fixed bottom-32 left-1/2 -translate-x-1/2 z-[60] w-full max-w-lg px-4">
          <InlinePermissionPrompt
            service={inlinePermission.service}
            authUrl={inlinePermission.authUrl}
            onConnect={() => {
              setInlinePermission(null)
              window.location.reload()
            }}
            onDismiss={() => setInlinePermission(null)}
          />
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmationDialog && (
        <ConfirmationDialog
          isOpen={confirmationDialog.isOpen}
          onClose={() => setConfirmationDialog(null)}
          onConfirm={() => {
            confirmationDialog.onConfirm()
            setConfirmationDialog(null)
          }}
          title={confirmationDialog.title}
          description={confirmationDialog.description}
          actionLabel={confirmationDialog.actionLabel}
          details={confirmationDialog.details}
        />
      )}

      {/* Document Editor */}
      <DocumentEditor
        isOpen={documentEditor.isOpen}
        onClose={() => setDocumentEditor({ isOpen: false, content: '' })}
        initialContent={documentEditor.content}
        instruction={documentEditor.instruction}
        onSave={(content) => {
          // Send the edited content back to chat
          const msg: ChatMessage = {
            role: 'assistant',
            text: `Here's the edited document:\n\n${content}`,
            mode: chatMode,
          }
          setMessages((prev) => [...prev, msg])
        }}
        onAssist={async (instruction, content) => {
          // Call the document_assist tool via the chat API
          const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `Please ${instruction} this text:\n\n${content}`,
              chosenModel: getRealModelId(activeModel),
              chatMode: 'normal',
            }),
          })
          if (!response.ok) throw new Error('Assist failed')
          const reader = response.body?.getReader()
          const decoder = new TextDecoder()
          let result = ''
          if (reader) {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              result += decoder.decode(value, { stream: true })
            }
          }
          // Parse the SSE response to extract the text
          const lines = result.split('\n\n')
          for (const line of lines) {
            if (line.startsWith('data:')) {
              const data = line.slice(5).trim()
              try {
                const parsed = JSON.parse(data)
                if (typeof parsed === 'string') return parsed
              } catch {
                return data
              }
            }
          }
          return result
        }}
      />

      {/* Model Comparison */}
      <ModelComparison
        isOpen={modelComparison.isOpen}
        onClose={() => setModelComparison({ isOpen: false })}
        availableModels={catalog.map((m) => ({ id: m.id, name: m.name, provider: m.provider }))}
        onCompare={async (modelA, modelB, prompt) => {
          const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `Compare models ${modelA} and ${modelB} with this prompt: ${prompt}`,
              chosenModel: getRealModelId(activeModel),
              chatMode: 'normal',
            }),
          })
          if (!response.ok) throw new Error('Comparison failed')
          // The actual comparison would use the compare_models tool
          // For now return mock data
          return {
            modelA,
            modelB,
            answerA: 'This is a sample response from Model A.',
            answerB: 'This is a sample response from Model B.',
            latencyA: 1200,
            latencyB: 1450,
          }
        }}
      />

      {/* ─── Live Code Preview panel ─── */}
      {/* Portaled to <body> so it escapes ancestor transforms/overflow and always
          renders ABOVE the app header + terminal chrome (viewport-level stacking). */}
      {createPortal(
        <>
          {/* Floating reopen tab — shown when a preview exists but the panel is
              closed so the user can summon it back without re-asking the model. */}
          {preview && !previewOpen && (
            <motion.button
              type="button"
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              onClick={() => {
                previewDismissedRef.current = false
                setPreviewOpen(true)
              }}
              className={`fixed top-1/2 -translate-y-1/2 right-0 z-[9997] flex items-center gap-2 rounded-l-xl border border-r-0 border-white/15 bg-[#0c0d14]/95 backdrop-blur-xl px-3 py-2.5 text-white/70 hover:text-white hover:border-emerald-400/40 shadow-[0_8px_30px_rgba(0,0,0,0.6)] cursor-pointer transition-opacity ${sideDrawerOpen ? 'pointer-events-none opacity-0' : ''}`}
            >
              <Monitor size={14} className="text-emerald-300" />
              <span className="text-[9px] font-mono uppercase tracking-widest">Preview</span>
            </motion.button>
          )}

          {/* Side panel */}
          {preview && (
            <AnimatePresence>
              {previewOpen && (
                <motion.div
                  initial={{ opacity: 0, x: 48 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 48 }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  className={`fixed top-2 bottom-2 right-2 z-[9998] w-[min(46vw,640px)] min-w-[360px] rounded-2xl border border-white/15 bg-[#0c0d14]/97 shadow-[0_20px_70px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden backdrop-blur-2xl transition-opacity ${sideDrawerOpen ? 'pointer-events-none opacity-0' : ''}`}
                >
                  {/* Panel header */}
                  <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3.5 py-2.5 bg-white/[0.02]">
                    <div className="flex items-center gap-2 min-w-0">
                      <Monitor size={13} className="text-emerald-300 shrink-0" />
                      <span className="text-[9px] font-mono uppercase tracking-widest text-white/60 truncate">
                        {preview.title || 'Live Preview'}
                      </span>
                      {preview.isProject && (
                        <span className="shrink-0 rounded-full bg-violet-400/10 border border-violet-400/25 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-violet-300/90">
                          {preview.files?.length ?? 0} files
                        </span>
                      )}
                      {storedFileCount > 0 && (
                        <span className="shrink-0 rounded-full bg-amber-400/10 border border-amber-400/25 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-amber-300/90">
                          saved {storedFileCount}
                        </span>
                      )}
                      <span className="shrink-0 rounded-full bg-emerald-400/10 border border-emerald-400/25 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-emerald-300/90">
                        running
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={zipCorrespondingPreview}
                        disabled={!storedCodeTask}
                        title="Download these files as a .zip"
                        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[9px] font-mono uppercase tracking-widest transition-all cursor-pointer ${
                          storedCodeTask
                            ? 'border-amber-400/25 text-amber-300/90 hover:text-white hover:border-amber-400/40 hover:bg-amber-400/10'
                            : 'border-white/10 text-white/25 cursor-not-allowed'
                        }`}
                      >
                        <Download size={10} />
                        ZIP
                      </button>
                      <a
                        href={previewAbsoluteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open in a new tab"
                        className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2 py-1.5 text-[9px] font-mono uppercase tracking-widest text-emerald-300/90 hover:text-white hover:border-emerald-400/40 hover:bg-emerald-400/10 transition-all cursor-pointer"
                      >
                        <ExternalLink size={10} />
                        Open new tab
                      </a>
                      <button
                        type="button"
                        onClick={copyPreviewUrl}
                        title="Copy preview URL"
                        className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1.5 text-[9px] font-mono uppercase tracking-widest text-white/50 hover:text-white hover:border-white/25 transition-all cursor-pointer"
                      >
                        {previewCopied ? <Check size={10} className="text-emerald-300" /> : <Copy size={10} />}
                        {previewCopied ? 'Copied' : 'URL'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewFrameKey((k) => k + 1)}
                        title="Reload preview"
                        className="w-7 h-7 flex items-center justify-center rounded-lg border border-white/10 text-white/50 hover:text-white hover:border-white/25 transition-all cursor-pointer"
                      >
                        <RefreshCw size={11} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          previewDismissedRef.current = true
                          setPreviewOpen(false)
                        }}
                        title="Close preview"
                        className="w-7 h-7 flex items-center justify-center rounded-lg border border-white/10 text-white/50 hover:text-white hover:border-white/25 hover:bg-white/[0.05] transition-all cursor-pointer"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>

                  {/* File tree strip (multi-file projects) */}
                  {preview.isProject && preview.files && preview.files.length > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none border-b border-white/10 px-3 py-1.5 bg-white/[0.015]">
                      {preview.files.map((f) => (
                        <span
                          key={f.path}
                          className="shrink-0 rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[8px] uppercase tracking-wider text-white/50"
                          title={f.path}
                        >
                          {f.path}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Preview body */}
                  <div className="flex-1 min-h-0 bg-white relative">
                    {/* NOTE: do not add allow-same-origin here. The code in this
                        frame is written by an LLM and served from our own origin,
                        so allow-scripts + allow-same-origin together let it reach
                        window.parent.localStorage — every provider key and the
                        auth token — and the two tokens combined are documented as
                        removing protections "in the same way" as no sandbox at all.
                        Without it the frame gets an opaque origin: parent access
                        throws SecurityError, while relative fetch, forms, popups
                        and pointer lock all still work. The backend mirrors this
                        via a `Content-Security-Policy: sandbox` header on
                        /api/preview, so the open-in-new-tab path is isolated too. */}
                    <iframe
                      key={previewFrameKey}
                      title="ENZO live preview"
                      src={preview.url}
                      sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock"
                      className="w-full h-full border-0"
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </>,
        document.body,
      )}
    </div>
  )
}
