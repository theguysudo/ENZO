/**
 * IntelligenceMarkdown.tsx — the hand-rolled markdown-ish renderer shared by
 * the report tab, the analyst transcript and the node explainer.
 *
 * It is deliberately NOT a markdown library: the only inline syntax that
 * matters here is **bold**, [E#] evidence citations and bare URLs — and the
 * [E#] chips must be clickable buttons that jump to the evidence ledger.
 *
 * Lives in its own module so the node-explainer overlay can render model
 * prose without importing the whole workspace component (which would be a
 * circular import).
 */

import { useMemo } from 'react'

/** Split a line into text / bold / [E#] citation / URL parts.
 *
 *  The models cite with whatever bracket style they like — "[E12]", "[ E12 ]",
 *  "【E12】", "(E12)" — so the citation pattern accepts all of them and the
 *  chip is normalised to the bare id. A citation that is not matched renders
 *  as dead text, which is why this is deliberately loose. */
export function renderInline(text: string, onCite: (id: string) => void, onJumpUrl: (url: string) => void): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|[\[【（(]\s*E\s*\d+\s*[\]】）)]|https?:\/\/[^\s)]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) {
      parts.push(<strong key={k++} className="text-white">{tok.slice(2, -2)}</strong>)
    } else if (/^[\[【（(]/.test(tok)) {
      const id = (tok.match(/E\s*(\d+)/) || [])[1] || ''
      parts.push(
        <button
          key={k++}
          type="button"
          onClick={() => onCite(id)}
          className="mx-0.5 inline-flex h-[18px] min-w-[24px] cursor-pointer items-center justify-center rounded border border-white/20 bg-white/[0.07] px-1 align-middle font-mono text-[10px] text-white/80 transition-colors hover:border-white/40 hover:bg-white/[0.14] hover:text-white"
          title={`Inspect E${id} in the evidence ledger`}
        >
          E{id}
        </button>,
      )
    } else {
      parts.push(
        <button
          key={k++}
          type="button"
          onClick={() => onJumpUrl(tok)}
          className="break-all text-white/70 underline decoration-white/25 underline-offset-2 transition-colors hover:text-white"
          title={tok}
        >
          {tok.length > 64 ? `${tok.slice(0, 62)}…` : tok}
        </button>,
      )
    }
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** Render a block of model prose: headings, bullets, numbered lists, paragraphs. */
export function ReportBody({ text, onCite, onJumpUrl }: { text: string; onCite: (id: string) => void; onJumpUrl: (url: string) => void }) {
  const blocks = useMemo(() => {
    const out: React.ReactNode[] = []
    let list: React.ReactNode[] = []
    const flush = (key: number) => {
      if (list.length) {
        out.push(<ul key={`ul-${key}`} className="my-2 space-y-1.5 pl-4">{list}</ul>)
        list = []
      }
    }
    text.split('\n').forEach((line, i) => {
      const t = line.trim()
      if (/^#{1,4}\s/.test(t)) {
        flush(i)
        const level = t.match(/^#+/)![0].length
        const content = t.replace(/^#+\s*/, '')
        out.push(
          level <= 2
            ? <h3 key={i} className="mt-6 mb-2 font-mono-display text-[11px] uppercase tracking-[0.25em] text-white/60 first:mt-0">{renderInline(content, onCite, onJumpUrl)}</h3>
            : <h4 key={i} className="mt-4 mb-1.5 text-[13px] font-medium text-white/85">{renderInline(content, onCite, onJumpUrl)}</h4>,
        )
      } else if (/^[-*]\s+/.test(t)) {
        list.push(
          <li key={i} className="relative pl-3 text-[13px] leading-relaxed text-white/70 before:absolute before:left-0 before:top-[0.55em] before:h-1 before:w-1 before:rounded-full before:bg-white/30">
            {renderInline(t.replace(/^[-*]\s+/, ''), onCite, onJumpUrl)}
          </li>,
        )
      } else if (/^\d+\.\s+/.test(t)) {
        list.push(
          <li key={i} className="pl-1 text-[13px] leading-relaxed text-white/70">
            <span className="mr-1.5 font-mono text-[11px] text-white/60">{t.match(/^\d+/)![0]}.</span>
            {renderInline(t.replace(/^\d+\.\s+/, ''), onCite, onJumpUrl)}
          </li>,
        )
      } else if (!t) {
        flush(i)
      } else {
        flush(i)
        out.push(<p key={i} className="my-2 text-[13px] leading-relaxed text-white/75">{renderInline(t, onCite, onJumpUrl)}</p>)
      }
    })
    flush(9999)
    return out
  }, [text, onCite, onJumpUrl])
  return <div>{blocks}</div>
}
