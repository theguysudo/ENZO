import React, { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X,
  Save,
  Download,
  Type,
  AlignLeft,
  Bold,
  Italic,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  Check,
  AlertCircle,
  Sparkles,
  Wand2,
  RefreshCw,
  FileText,
} from 'lucide-react'

interface DocumentEditorProps {
  isOpen: boolean
  onClose: () => void
  initialContent?: string
  instruction?: string
  onSave?: (content: string) => void
  onAssist?: (instruction: string, content: string) => Promise<string>
}

interface EditorSuggestion {
  id: string
  type: 'grammar' | 'style' | 'clarity' | 'improvement'
  message: string
  original?: string
  replacement?: string
  line: number
}

export function DocumentEditor({
  isOpen,
  onClose,
  initialContent = '',
  instruction = '',
  onSave,
  onAssist,
}: DocumentEditorProps) {
  const [content, setContent] = useState(initialContent)
  const [title, setTitle] = useState('Untitled Document')
  const [isDirty, setIsDirty] = useState(false)
  const [activeTab, setActiveTab] = useState<'edit' | 'preview' | 'suggestions'>('edit')
  const [suggestions, setSuggestions] = useState<EditorSuggestion[]>([])
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [selectedInstruction, setSelectedInstruction] = useState(instruction || 'rewrite')
  const [showInstructionDropdown, setShowInstructionDropdown] = useState(false)
  const [aiThinking, setAiThinking] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const instructions = [
    { id: 'rewrite', label: 'Rewrite', icon: <RefreshCw className="w-4 h-4" />, description: 'Rewrite for clarity and impact' },
    { id: 'summarize', label: 'Summarize', icon: <AlignLeft className="w-4 h-4" />, description: 'Create a concise summary' },
    { id: 'continue', label: 'Continue', icon: <Type className="w-4 h-4" />, description: 'Add more content in the same style' },
    { id: 'proofread', label: 'Proofread', icon: <Check className="w-4 h-4" />, description: 'Fix grammar and spelling' },
    { id: 'expand', label: 'Expand', icon: <Sparkles className="w-4 h-4" />, description: 'Add more detail and depth' },
    { id: 'simplify', label: 'Simplify', icon: <Wand2 className="w-4 h-4" />, description: 'Make it easier to understand' },
  ]

  useEffect(() => {
    if (isOpen && initialContent) {
      setContent(initialContent)
      setIsDirty(false)
    }
  }, [isOpen, initialContent])

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty])

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value)
    setIsDirty(true)
  }

  const handleSave = () => {
    onSave?.(content)
    setIsDirty(false)
  }

  const handleDownload = () => {
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleAiAssist = async () => {
    if (!onAssist || !content) return
    setAiThinking(true)
    try {
      const result = await onAssist(selectedInstruction, content)
      setContent(result)
      setIsDirty(true)
    } catch (err) {
      console.error('AI assist failed:', err)
    } finally {
      setAiThinking(false)
    }
  }

  const analyzeDocument = async () => {
    setIsAnalyzing(true)
    // Simulate analysis - in real implementation, this would call the backend
    await new Promise((r) => setTimeout(r, 1500))
    const mockSuggestions: EditorSuggestion[] = [
      {
        id: '1',
        type: 'grammar',
        message: 'Consider rephrasing for better flow',
        original: 'The quick brown fox',
        replacement: 'The swift brown fox',
        line: 1,
      },
      {
        id: '2',
        type: 'clarity',
        message: 'This sentence could be more concise',
        line: 2,
      },
    ]
    setSuggestions(mockSuggestions)
    setIsAnalyzing(false)
    setActiveTab('suggestions')
  }

  const applySuggestion = (suggestion: EditorSuggestion) => {
    if (suggestion.original && suggestion.replacement) {
      setContent((prev) => prev.replace(suggestion.original!, suggestion.replacement!))
      setIsDirty(true)
    }
    setSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id))
  }

  const insertFormatting = (format: string) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selectedText = content.slice(start, end)

    let formattedText = selectedText
    switch (format) {
      case 'bold':
        formattedText = `**${selectedText || 'bold text'}**`
        break
      case 'italic':
        formattedText = `*${selectedText || 'italic text'}*`
        break
      case 'heading1':
        formattedText = `\n# ${selectedText || 'Heading'}\n`
        break
      case 'heading2':
        formattedText = `\n## ${selectedText || 'Subheading'}\n`
        break
      case 'bullet':
        formattedText = `\n- ${selectedText || 'Item'}\n`
        break
      case 'numbered':
        formattedText = `\n1. ${selectedText || 'Item'}\n`
        break
    }

    const newContent = content.slice(0, start) + formattedText + content.slice(end)
    setContent(newContent)
    setIsDirty(true)

    setTimeout(() => {
      textarea.focus()
      const newCursor = start + formattedText.length
      textarea.setSelectionRange(newCursor, newCursor)
    }, 0)
  }

  const renderPreview = () => {
    // Simple markdown-like preview
    const lines = content.split('\n')
    return (
      <div className="prose prose-invert max-w-none p-6">
        {lines.map((line, idx) => {
          if (line.startsWith('# ')) {
            return <h1 key={idx} className="text-2xl font-bold text-white mb-4">{line.slice(2)}</h1>
          }
          if (line.startsWith('## ')) {
            return <h2 key={idx} className="text-xl font-semibold text-white/90 mb-3">{line.slice(3)}</h2>
          }
          if (line.startsWith('- ')) {
            return (
              <li key={idx} className="text-white/70 ml-4 mb-1">{line.slice(2)}</li>
            )
          }
          if (line.match(/^\d+\.\s/)) {
            return (
              <li key={idx} className="text-white/70 ml-4 mb-1 list-decimal">{line.replace(/^\d+\.\s/, '')}</li>
            )
          }
          if (line.startsWith('**') && line.endsWith('**')) {
            return (
              <p key={idx} className="text-white/80 mb-2">
                <strong>{line.slice(2, -2)}</strong>
              </p>
            )
          }
          if (line.trim()) {
            return <p key={idx} className="text-white/70 mb-2">{line}</p>
          }
          return <div key={idx} className="h-2" />
        })}
      </div>
    )
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm"
          />

          {/* Editor */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed inset-4 md:inset-8 lg:inset-16 z-[201] flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0a0b18]/98 backdrop-blur-xl shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 shrink-0">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
                  <FileText className="h-5 w-5" />
                </div>
                <div>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value)
                      setIsDirty(true)
                    }}
                    className="bg-transparent text-sm font-semibold text-white placeholder-white/30 outline-none border-none p-0 focus:ring-0"
                    placeholder="Document title..."
                  />
                  {isDirty && (
                    <span className="text-[10px] text-amber-400/80 ml-2">● unsaved changes</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* AI Assist Dropdown */}
                <div className="relative">
                  <button
                    onClick={() => setShowInstructionDropdown(!showInstructionDropdown)}
                    disabled={aiThinking}
                    className="flex items-center gap-2 rounded-lg bg-amber-500/20 border border-amber-500/30 px-3 py-1.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>{instructions.find((i) => i.id === selectedInstruction)?.label}</span>
                    <span className="text-amber-400/50">▼</span>
                  </button>

                  <AnimatePresence>
                    {showInstructionDropdown && (
                      <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-white/10 bg-[#0f1119] shadow-xl z-10"
                      >
                        {instructions.map((instr) => (
                          <button
                            key={instr.id}
                            onClick={() => {
                              setSelectedInstruction(instr.id)
                              setShowInstructionDropdown(false)
                            }}
                            className="flex items-start gap-3 w-full px-3 py-2.5 hover:bg-white/5 transition-colors text-left"
                          >
                            <span className="text-white/60 mt-0.5">{instr.icon}</span>
                            <div>
                              <div className="text-[11px] font-medium text-white">{instr.label}</div>
                              <div className="text-[10px] text-white/40">{instr.description}</div>
                            </div>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <button
                  onClick={handleAiAssist}
                  disabled={aiThinking || !content}
                  className="flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-semibold text-black hover:bg-emerald-400 transition-colors disabled:opacity-50"
                >
                  {aiThinking ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Thinking...</span>
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-3.5 w-3.5" />
                      <span>Assist</span>
                    </>
                  )}
                </button>

                <button
                  onClick={analyzeDocument}
                  disabled={isAnalyzing || !content}
                  className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-medium text-white/70 hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                  {isAnalyzing ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5" />
                  )}
                  <span>Analyze</span>
                </button>

                <div className="w-px h-5 bg-white/10 mx-1" />

                <button
                  onClick={handleSave}
                  disabled={!isDirty}
                  className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-medium text-white/70 hover:bg-white/5 transition-colors disabled:opacity-30"
                >
                  <Save className="h-3.5 w-3.5" />
                </button>

                <button
                  onClick={handleDownload}
                  className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-medium text-white/70 hover:bg-white/5 transition-colors"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>

                <button
                  onClick={onClose}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-1 border-b border-white/10 px-3 py-2 shrink-0 bg-white/[0.02]">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => insertFormatting('heading1')}
                  className="flex h-7 w-7 items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                  title="Heading 1"
                >
                  <Heading1 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => insertFormatting('heading2')}
                  className="flex h-7 w-7 items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                  title="Heading 2"
                >
                  <Heading2 className="h-4 w-4" />
                </button>
              </div>

              <div className="w-px h-5 bg-white/10 mx-2" />

              <div className="flex items-center gap-1">
                <button
                  onClick={() => insertFormatting('bold')}
                  className="flex h-7 w-7 items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                  title="Bold"
                >
                  <Bold className="h-4 w-4" />
                </button>
                <button
                  onClick={() => insertFormatting('italic')}
                  className="flex h-7 w-7 items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                  title="Italic"
                >
                  <Italic className="h-4 w-4" />
                </button>
              </div>

              <div className="w-px h-5 bg-white/10 mx-2" />

              <div className="flex items-center gap-1">
                <button
                  onClick={() => insertFormatting('bullet')}
                  className="flex h-7 w-7 items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                  title="Bullet List"
                >
                  <List className="h-4 w-4" />
                </button>
                <button
                  onClick={() => insertFormatting('numbered')}
                  className="flex h-7 w-7 items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                  title="Numbered List"
                >
                  <ListOrdered className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1" />

              {/* Tabs */}
              <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1">
                {['edit', 'preview', 'suggestions'].map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab as any)}
                    className={`px-3 py-1 rounded-md text-[11px] font-medium transition-all ${
                      activeTab === tab
                        ? 'bg-white/10 text-white'
                        : 'text-white/50 hover:text-white/80'
                    }`}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    {tab === 'suggestions' && suggestions.length > 0 && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[9px]">
                        {suggestions.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-hidden relative">
              {activeTab === 'edit' && (
                <textarea
                  ref={textareaRef}
                  value={content}
                  onChange={handleContentChange}
                  className="w-full h-full resize-none bg-transparent p-6 text-[14px] text-white/80 placeholder-white/20 outline-none font-mono leading-relaxed"
                  placeholder="Start typing your document here...\n\nUse the toolbar above for formatting, or ask the AI assistant to help you write."
                  spellCheck={false}
                />
              )}

              {activeTab === 'preview' && (
                <div className="w-full h-full overflow-auto bg-[#0c0d14]">
                  {renderPreview()}
                </div>
              )}

              {activeTab === 'suggestions' && (
                <div className="w-full h-full overflow-auto p-6">
                  {suggestions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-white/30">
                      <AlertCircle className="h-12 w-12 mb-3" />
                      <p className="text-sm">No suggestions yet</p>
                      <p className="text-xs mt-1">Click "Analyze" to check your document</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {suggestions.map((suggestion) => (
                        <div
                          key={suggestion.id}
                          className="flex items-start gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4"
                        >
                          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                            suggestion.type === 'grammar'
                              ? 'bg-red-500/10 text-red-400'
                              : suggestion.type === 'clarity'
                              ? 'bg-amber-500/10 text-amber-400'
                              : 'bg-emerald-500/10 text-emerald-400'
                          }`}>
                            <AlertCircle className="h-4 w-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[12px] text-white/80">{suggestion.message}</p>
                            {suggestion.original && suggestion.replacement && (
                              <div className="mt-2 flex items-center gap-2 text-[11px]">
                                <span className="text-white/40 line-through">{suggestion.original}</span>
                                <span className="text-emerald-400">→</span>
                                <span className="text-emerald-400">{suggestion.replacement}</span>
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => applySuggestion(suggestion)}
                            className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
                            title="Apply suggestion"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-white/10 px-4 py-2 shrink-0 bg-white/[0.02]">
              <div className="flex items-center gap-4 text-[11px] text-white/40">
                <span>{content.length} characters</span>
                <span>{content.split(/\s+/).filter(Boolean).length} words</span>
                <span>{content.split('\n').filter(Boolean).length} lines</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-white/40">
                  Use **bold**, *italic*, # headings
                </span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
