import React, { useState } from 'react'
import { Copy, Check, Download } from 'lucide-react'

interface VSCodeWindowProps {
  code: string
  language: string
}

export const VSCodeWindow: React.FC<VSCodeWindowProps> = ({ code, language }) => {
  // Parse filename from comment on first line
  let filename = ''
  let cleanCode = code
  const lines = code.split('\n')
  const firstLine = lines[0]?.trim()

  if (firstLine) {
    const htmlComment = firstLine.match(/^<!--\s*([a-zA-Z0-9._-]+)\s*-->/)
    const cssComment = firstLine.match(/^\/\*\s*([a-zA-Z0-9._-]+)\s*\*\/$/)
    const jsComment = firstLine.match(/^\/\/\s*([a-zA-Z0-9._-]+)$/)

    if (htmlComment) {
      filename = htmlComment[1]
      cleanCode = lines.slice(1).join('\n')
    } else if (cssComment) {
      filename = cssComment[1]
      cleanCode = lines.slice(1).join('\n')
    } else if (jsComment) {
      filename = jsComment[1]
      cleanCode = lines.slice(1).join('\n')
    }
  }

  if (!filename) {
    const lang = language.toLowerCase()
    if (lang === 'html') filename = 'index.html'
    else if (lang === 'css') filename = 'style.css'
    else if (['js', 'javascript', 'ts', 'typescript'].includes(lang)) filename = 'script.js'
    else filename = `main.${lang}`
  }

  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(cleanCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleDownload = () => {
    const blob = new Blob([cleanCode], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Syntax highlighting logic
  const highlightCode = (text: string, lang: string): React.ReactNode => {
    const lowerLang = lang.toLowerCase()

    if (lowerLang === 'html' || lowerLang === 'xml') {
      return text.split('\n').map((line, idx) => {
        const parts: React.ReactNode[] = []
        let lastIndex = 0

        const regex = /(<!--[\s\S]*?-->)|(<[^>]+>)/g
        let match
        while ((match = regex.exec(line)) !== null) {
          const textBefore = line.substring(lastIndex, match.index)
          if (textBefore) parts.push(textBefore)

          const fullMatch = match[0]
          if (fullMatch.startsWith('<!--')) {
            parts.push(
              <span key={match.index} className="text-[#6a9955] italic">
                {fullMatch}
              </span>
            )
          } else {
            const tagParts: React.ReactNode[] = []
            const tagRegex = /(<\/?)([a-zA-Z0-9:-]+)|([a-zA-Z0-9:-]+)\s*=\s*(['"][^'"]*['"])|(>)/g
            let tagMatch
            let tagLastIndex = 0

            while ((tagMatch = tagRegex.exec(fullMatch)) !== null) {
              const tagBefore = fullMatch.substring(tagLastIndex, tagMatch.index)
              if (tagBefore) tagParts.push(tagBefore)

              if (tagMatch[1]) {
                tagParts.push(
                  <span key={tagMatch.index + '-bracket'} className="text-white/50">
                    {tagMatch[1]}
                  </span>
                )
                tagParts.push(
                  <span key={tagMatch.index + '-name'} className="text-[#569cd6]">
                    {tagMatch[2]}
                  </span>
                )
              } else if (tagMatch[3]) {
                tagParts.push(
                  <span key={tagMatch.index + '-attr'} className="text-[#9cdcfe]">
                    {tagMatch[3]}
                  </span>
                )
                tagParts.push(<span key={tagMatch.index + '-eq'} className="text-white/70">=</span>)
                tagParts.push(
                  <span key={tagMatch.index + '-val'} className="text-[#d69d85]">
                    {tagMatch[4]}
                  </span>
                )
              } else if (tagMatch[5]) {
                tagParts.push(
                  <span key={tagMatch.index + '-close'} className="text-white/50">
                    {tagMatch[5]}
                  </span>
                )
              }
              tagLastIndex = tagRegex.lastIndex
            }
            if (tagLastIndex < fullMatch.length) {
              tagParts.push(fullMatch.substring(tagLastIndex))
            }
            parts.push(<span key={match.index}>{tagParts}</span>)
          }
          lastIndex = regex.lastIndex
        }
        if (lastIndex < line.length) {
          parts.push(line.substring(lastIndex))
        }

        return (
          <div key={idx} className="min-h-[1.5em] whitespace-pre">
            {parts.length > 0 ? parts : ' '}
          </div>
        )
      })
    }

    if (lowerLang === 'css') {
      return text.split('\n').map((line, idx) => {
        const parts: React.ReactNode[] = []
        let lastIndex = 0

        const regex = /(\/\*[\s\S]*?\*\/)|([.#a-zA-Z0-9:-]+)\s*(?=\{)|([a-zA-Z-]+)\s*:\s*([^;]+);/g
        let match
        while ((match = regex.exec(line)) !== null) {
          const textBefore = line.substring(lastIndex, match.index)
          if (textBefore) parts.push(textBefore)

          const fullMatch = match[0]
          if (fullMatch.startsWith('/*')) {
            parts.push(
              <span key={match.index} className="text-[#6a9955] italic">
                {fullMatch}
              </span>
            )
          } else if (match[2]) {
            parts.push(
              <span key={match.index} className="text-[#dcdcaa]">
                {match[2]}
              </span>
            )
          } else if (match[3]) {
            parts.push(
              <span key={match.index + '-prop'} className="text-[#9cdcfe]">
                {match[3]}
              </span>
            )
            parts.push(<span key={match.index + '-colon'} className="text-white/70">: </span>)
            parts.push(
              <span key={match.index + '-val'} className="text-[#ce9178]">
                {match[4]}
              </span>
            )
            parts.push(<span key={match.index + '-semi'} className="text-white/70">;</span>)
          }
          lastIndex = regex.lastIndex
        }
        if (lastIndex < line.length) {
          parts.push(line.substring(lastIndex))
        }

        return (
          <div key={idx} className="min-h-[1.5em] whitespace-pre">
            {parts.length > 0 ? parts : ' '}
          </div>
        )
      })
    }

    if (['js', 'javascript', 'ts', 'typescript', 'json', 'py', 'python'].includes(lowerLang)) {
      return text.split('\n').map((line, idx) => {
        const parts: React.ReactNode[] = []
        let lastIndex = 0

        const keywords = /\b(const|let|var|function|return|if|else|for|while|import|export|from|class|extends|new|async|await|try|catch|finally)\b/g
        const regex = /(\/\/.*|\/\*[\s\S]*?\*\/)|(["'`].*?["'`])|(\b[a-zA-Z0-9_]+\b(?=\())/g
        let match

        while ((match = regex.exec(line)) !== null) {
          const textBefore = line.substring(lastIndex, match.index)
          if (textBefore) {
            let kwLastIndex = 0
            let kwMatch
            const textParts: React.ReactNode[] = []
            while ((kwMatch = keywords.exec(textBefore)) !== null) {
              const kwBefore = textBefore.substring(kwLastIndex, kwMatch.index)
              if (kwBefore) textParts.push(kwBefore)
              textParts.push(
                <span key={kwMatch.index} className="text-[#569cd6] font-semibold">
                  {kwMatch[1]}
                </span>
              )
              kwLastIndex = keywords.lastIndex
            }
            if (kwLastIndex < textBefore.length) {
              textParts.push(textBefore.substring(kwLastIndex))
            }
            parts.push(...textParts)
          }

          const fullMatch = match[0]
          if (fullMatch.startsWith('//') || fullMatch.startsWith('/*')) {
            parts.push(
              <span key={match.index} className="text-[#6a9955] italic">
                {fullMatch}
              </span>
            )
          } else if (fullMatch.startsWith('"') || fullMatch.startsWith("'") || fullMatch.startsWith('`')) {
            parts.push(
              <span key={match.index} className="text-[#d69d85]">
                {fullMatch}
              </span>
            )
          } else if (match[3]) {
            parts.push(
              <span key={match.index} className="text-[#dcdcaa]">
                {match[3]}
              </span>
            )
          }
          lastIndex = regex.lastIndex
        }

        if (lastIndex < line.length) {
          const textBefore = line.substring(lastIndex)
          let kwLastIndex = 0
          let kwMatch
          const textParts: React.ReactNode[] = []
          keywords.lastIndex = 0
          while ((kwMatch = keywords.exec(textBefore)) !== null) {
            const kwBefore = textBefore.substring(kwLastIndex, kwMatch.index)
            if (kwBefore) textParts.push(kwBefore)
            textParts.push(
              <span key={kwMatch.index} className="text-[#569cd6] font-semibold">
                {kwMatch[1]}
              </span>
            )
            kwLastIndex = keywords.lastIndex
          }
          if (kwLastIndex < textBefore.length) {
            textParts.push(textBefore.substring(kwLastIndex))
          }
          parts.push(...textParts)
        }

        return (
          <div key={idx} className="min-h-[1.5em] whitespace-pre">
            {parts.length > 0 ? parts : ' '}
          </div>
        )
      })
    }

    return text.split('\n').map((line, idx) => (
      <div key={idx} className="min-h-[1.5em] whitespace-pre">
        {line || ' '}
      </div>
    ))
  }

  return (
    <div className="w-full bg-[#1e1e2f] rounded-xl border border-white/10 shadow-[0_12px_40px_rgba(0,0,0,0.6)] flex flex-col overflow-hidden font-mono mt-3 text-left">
      {/* Title Bar */}
      <div className="h-8 bg-[#2c2c3e]/80 border-b border-white/[0.06] flex items-center px-4 text-[11px] text-white/50 select-none">
        <span className="font-medium tracking-wide truncate max-w-[70%]">{filename}</span>
        <div className="ml-auto flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f56] transition-transform hover:scale-110 cursor-pointer" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e] transition-transform hover:scale-110 cursor-pointer" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#27c93f] transition-transform hover:scale-110 cursor-pointer" />
        </div>
      </div>

      {/* Tabs Row with Copy & Download Actions */}
      <div className="flex bg-[#252536] border-b border-white/[0.06] justify-between items-center pr-3">
        <div className="px-4 py-2 text-xs bg-[#1e1e2f] text-white border-b-2 border-[#007acc] font-semibold flex items-center gap-1.5 select-none">
          <span className="text-[10px] text-[#007acc]">⬤</span>
          {filename}
        </div>
        <div className="flex items-center gap-2 select-none">
          <button
            onClick={handleCopy}
            title="Copy code"
            className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/5 transition-all cursor-pointer flex items-center gap-1 text-[10px] font-mono-display font-medium uppercase tracking-wider"
          >
            {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <div className="w-[1px] h-3 bg-white/10" />
          <button
            onClick={handleDownload}
            title="Download file"
            className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/5 transition-all cursor-pointer flex items-center gap-1 text-[10px] font-mono-display font-medium uppercase tracking-wider"
          >
            <Download size={11} />
            <span>Download</span>
          </button>
        </div>
      </div>

      {/* Code Editor Panel */}
      <div className="flex-1 bg-[#1e1e2f] text-[#d4d4d4] p-4 font-mono text-[12.5px] overflow-x-auto leading-relaxed border-t border-white/[0.03] select-text">
        {highlightCode(cleanCode, language)}
      </div>
    </div>
  )
}
