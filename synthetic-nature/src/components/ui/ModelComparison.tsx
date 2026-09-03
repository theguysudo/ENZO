import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  RefreshCw,
  Cpu,
  Sparkles,
  GitCompare,
  Play,
  Clock,
} from 'lucide-react'

interface ComparisonResult {
  modelA: string
  modelB: string
  answerA: string
  answerB: string
  latencyA?: number
  latencyB?: number
}

interface Model {
  id: string
  name: string
  provider: string
}

interface ModelComparisonProps {
  isOpen: boolean
  onClose: () => void
  availableModels: Model[]
  onCompare: (modelA: string, modelB: string, prompt: string) => Promise<ComparisonResult>
}

export function ModelComparison({
  isOpen,
  onClose,
  availableModels,
  onCompare,
}: ModelComparisonProps) {
  const [modelA, setModelA] = useState('')
  const [modelB, setModelB] = useState('')
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState<ComparisonResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [expandedPanel, setExpandedPanel] = useState<'left' | 'right' | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [showModelSelectA, setShowModelSelectA] = useState(false)
  const [showModelSelectB, setShowModelSelectB] = useState(false)
  const [searchA, setSearchA] = useState('')
  const [searchB, setSearchB] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setModelA('')
      setModelB('')
      setPrompt('')
      setResult(null)
      setExpandedPanel(null)
    }
  }, [isOpen])

  const handleCompare = async () => {
    if (!modelA || !modelB || !prompt || isLoading) return
    setIsLoading(true)
    try {
      const comparison = await onCompare(modelA, modelB, prompt)
      setResult(comparison)
    } catch (err) {
      console.error('Comparison failed:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const filteredModelsA = availableModels.filter(
    (m) =>
      m.name.toLowerCase().includes(searchA.toLowerCase()) ||
      m.id.toLowerCase().includes(searchA.toLowerCase())
  )

  const filteredModelsB = availableModels.filter(
    (m) =>
      m.name.toLowerCase().includes(searchB.toLowerCase()) ||
      m.id.toLowerCase().includes(searchB.toLowerCase())
  )

  const selectedModelA = availableModels.find((m) => m.id === modelA)
  const selectedModelB = availableModels.find((m) => m.id === modelB)

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

          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            ref={containerRef}
            className="fixed inset-4 md:inset-8 z-[201] flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0a0b18]/98 backdrop-blur-xl shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4 shrink-0">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20">
                  <GitCompare className="h-5 w-5 text-emerald-400" />
                </div>
                <div>
                  <h3 className="font-mono-display text-sm font-semibold text-white tracking-wide">
                    Model Arena
                  </h3>
                  <p className="text-[11px] text-white/50 font-mono">
                    Compare outputs side-by-side
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Configuration */}
            {!result && (
              <div className="flex flex-col gap-4 p-5 border-b border-white/10 shrink-0">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Model A Selector */}
                  <div className="relative">
                    <label className="block text-[11px] font-medium text-white/50 mb-1.5 uppercase tracking-wider">
                      Model A
                    </label>
                    <button
                      onClick={() => setShowModelSelectA(!showModelSelectA)}
                      className="w-full flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left hover:border-white/20 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-emerald-400" />
                        <span className="text-sm text-white">
                          {selectedModelA?.name || 'Select a model'}
                        </span>
                      </div>
                      <ChevronDown className="h-4 w-4 text-white/40" />
                    </button>

                    <AnimatePresence>
                      {showModelSelectA && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="absolute left-0 right-0 top-full mt-2 z-50 rounded-xl border border-white/10 bg-[#0f1119] shadow-2xl overflow-hidden"
                        >
                          <div className="p-2 border-b border-white/10">
                            <input
                              type="text"
                              value={searchA}
                              onChange={(e) => setSearchA(e.target.value)}
                              placeholder="Search models..."
                              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-emerald-500/50"
                            />
                          </div>
                          <div className="max-h-48 overflow-auto p-1">
                            {filteredModelsA.map((model) => (
                              <button
                                key={model.id}
                                onClick={() => {
                                  setModelA(model.id)
                                  setShowModelSelectA(false)
                                  setSearchA('')
                                }}
                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                              >
                                <Cpu className="h-4 w-4 text-white/40" />
                                <div>
                                  <div className="text-sm text-white">{model.name}</div>
                                  <div className="text-[10px] text-white/40">{model.provider}</div>
                                </div>
                                {model.id === modelA && (
                                  <Check className="h-4 w-4 text-emerald-400 ml-auto" />
                                )}
                              </button>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Model B Selector */}
                  <div className="relative">
                    <label className="block text-[11px] font-medium text-white/50 mb-1.5 uppercase tracking-wider">
                      Model B
                    </label>
                    <button
                      onClick={() => setShowModelSelectB(!showModelSelectB)}
                      className="w-full flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left hover:border-white/20 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-amber-400" />
                        <span className="text-sm text-white">
                          {selectedModelB?.name || 'Select a model'}
                        </span>
                      </div>
                      <ChevronDown className="h-4 w-4 text-white/40" />
                    </button>

                    <AnimatePresence>
                      {showModelSelectB && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="absolute left-0 right-0 top-full mt-2 z-50 rounded-xl border border-white/10 bg-[#0f1119] shadow-2xl overflow-hidden"
                        >
                          <div className="p-2 border-b border-white/10">
                            <input
                              type="text"
                              value={searchB}
                              onChange={(e) => setSearchB(e.target.value)}
                              placeholder="Search models..."
                              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-amber-500/50"
                            />
                          </div>
                          <div className="max-h-48 overflow-auto p-1">
                            {filteredModelsB.map((model) => (
                              <button
                                key={model.id}
                                onClick={() => {
                                  setModelB(model.id)
                                  setShowModelSelectB(false)
                                  setSearchB('')
                                }}
                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors text-left"
                              >
                                <Cpu className="h-4 w-4 text-white/40" />
                                <div>
                                  <div className="text-sm text-white">{model.name}</div>
                                  <div className="text-[10px] text-white/40">{model.provider}</div>
                                </div>
                                {model.id === modelB && (
                                  <Check className="h-4 w-4 text-amber-400 ml-auto" />
                                )}
                              </button>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* Prompt Input */}
                <div>
                  <label className="block text-[11px] font-medium text-white/50 mb-1.5 uppercase tracking-wider">
                    Test Prompt
                  </label>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Enter a prompt to test both models..."
                    className="w-full h-24 resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/30 outline-none focus:border-emerald-500/50 transition-colors"
                  />
                </div>

                {/* Run Button */}
                <button
                  onClick={handleCompare}
                  disabled={!modelA || !modelB || !prompt || isLoading}
                  className="flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 py-3 text-sm font-semibold text-black hover:bg-emerald-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      <span>Running comparison...</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" />
                      <span>Run Comparison</span>
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Results */}
            {result && (
              <div className="flex-1 flex overflow-hidden">
                {/* Model A Panel */}
                <div
                  className={`flex flex-col border-r border-white/10 transition-all duration-300 ${
                    expandedPanel === 'right' ? 'w-0 overflow-hidden' : expandedPanel === 'left' ? 'flex-[2]' : 'flex-1'
                  }`}
                >
                  {/* Panel Header */}
                  <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-emerald-500/5">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-emerald-400" />
                      <span className="text-sm font-semibold text-white">{result.modelA}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {result.latencyA && (
                        <span className="text-[10px] text-white/40 flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {result.latencyA}ms
                        </span>
                      )}
                      <button
                        onClick={() => setExpandedPanel(expandedPanel === 'left' ? null : 'left')}
                        className="p-1 text-white/40 hover:text-white transition-colors"
                      >
                        {expandedPanel === 'left' ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Panel Content */}
                  <div className="flex-1 overflow-auto p-4">
                    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex items-center justify-between mb-3 pb-3 border-b border-white/10">
                        <span className="text-[10px] uppercase tracking-wider text-white/40">Response</span>
                        <button
                          onClick={() => handleCopy(result.answerA, 'a')}
                          className="text-white/40 hover:text-white transition-colors"
                        >
                          {copiedId === 'a' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                        </button>
                      </div>
                      <div className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap">
                        {result.answerA}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Model B Panel */}
                <div
                  className={`flex flex-col transition-all duration-300 ${
                    expandedPanel === 'left' ? 'w-0 overflow-hidden' : expandedPanel === 'right' ? 'flex-[2]' : 'flex-1'
                  }`}
                >
                  {/* Panel Header */}
                  <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-amber-500/5">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-amber-400" />
                      <span className="text-sm font-semibold text-white">{result.modelB}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {result.latencyB && (
                        <span className="text-[10px] text-white/40 flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {result.latencyB}ms
                        </span>
                      )}
                      <button
                        onClick={() => setExpandedPanel(expandedPanel === 'right' ? null : 'right')}
                        className="p-1 text-white/40 hover:text-white transition-colors"
                      >
                        {expandedPanel === 'right' ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Panel Content */}
                  <div className="flex-1 overflow-auto p-4">
                    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex items-center justify-between mb-3 pb-3 border-b border-white/10">
                        <span className="text-[10px] uppercase tracking-wider text-white/40">Response</span>
                        <button
                          onClick={() => handleCopy(result.answerB, 'b')}
                          className="text-white/40 hover:text-white transition-colors"
                        >
                          {copiedId === 'b' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                        </button>
                      </div>
                      <div className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap">
                        {result.answerB}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-white/10 px-5 py-3 shrink-0 bg-white/[0.02]">
              <div className="flex items-center gap-4 text-[11px] text-white/40">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" />
                  Compare reasoning, speed, and quality
                </span>
              </div>
              {result && (
                <button
                  onClick={() => {
                    setResult(null)
                    setExpandedPanel(null)
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-white/10 text-[11px] font-medium text-white/70 hover:bg-white/5 transition-colors"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  New Comparison
                </button>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
