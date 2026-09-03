import { useEffect, useRef, useState, useCallback } from 'react'

/**
 * useVoiceInput — high-accuracy push-to-talk voice typing.
 *
 * Engine: Web Speech API (SpeechRecognition / webkitSpeechRecognition).
 * In Chrome/Edge this hits Google's cloud STT — currently the most
 * accurate free transcription available in a browser (better than any
 * on-device WebAssembly model). Safari uses Apple's equivalent.
 *
 * Accuracy maxims applied:
 *   - continuous = true            → keeps listening through pauses
 *   - interimResults = true        → low-latency partial text shown live
 *   - maxAlternatives = 3          → picks best of N hypotheses
 *   - lang = navigator.language    → matches user's locale, not hard en-US
 *   - automatic punctuation        → enabled by Chrome by default
 *
 * The hook accumulates final transcripts into `finalText` and surfaces
 * the live (in-progress) partial via `interimText`. The consumer joins
 * them into the chat textarea in real time so users see words appear
 * as they speak.
 */

export interface UseVoiceInputReturn {
  isSupported: boolean
  isListening: boolean
  /** Finalized (committed) transcript accumulated across the session. */
  finalText: string
  /** Live, still-being-recognized partial — low confidence, may change. */
  interimText: string
  /** Confidence (0..1) of the most recent final result, if reported. */
  lastConfidence: number | null
  /** Last error from the SpeechRecognition engine. */
  error: string | null
  /** Currently detected BCP-47 language tag. */
  lang: string
  start: () => void
  stop: () => void
  toggle: () => void
  /** Reset accumulated transcript without stopping. */
  reset: () => void
}

export function useVoiceInput(): UseVoiceInputReturn {
  const [isSupported, setIsSupported] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [finalText, setFinalText] = useState('')
  const [interimText, setInterimText] = useState('')
  const [lastConfidence, setLastConfidence] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const recognitionRef = useRef<any>(null)
  const shouldBeListeningRef = useRef(false)

  const lang =
    (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language)) ||
    'en-US'

  // ── Initialize SpeechRecognition once ────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!Ctor) {
      setIsSupported(false)
      return
    }
    setIsSupported(true)

    const rec = new Ctor()

    // Best-accuracy settings
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 3
    rec.lang = lang

    rec.onstart = () => {
      setIsListening(true)
      setError(null)
    }

    rec.onend = () => {
      setIsListening(false)
      // Auto-restart if user still intends to listen (handles Chrome's
      // ~60s auto-timeout on continuous mode).
      if (shouldBeListeningRef.current) {
        try { rec.start() } catch { /* already starting */ }
      }
    }

    rec.onerror = (e: any) => {
      // 'no-speech' and 'aborted' fire on normal pause/stop — not user errors.
      if (e.error === 'no-speech' || e.error === 'aborted') return
      setError(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'Microphone access denied. Allow microphone in the browser prompt.'
          : e.error === 'network'
          ? 'Speech service unreachable (network).'
          : `Speech error: ${e.error}`
      )
      shouldBeListeningRef.current = false
      setIsListening(false)
    }

    rec.onresult = (event: any) => {
      let newFinal = ''
      let newInterim = ''
      let bestConfidence: number | null = null

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        // Pick highest-confidence alternative (maxAlternatives = 3).
        let best = result[0]
        for (let a = 1; a < result.length; a++) {
          if (result[a].confidence > best.confidence) best = result[a]
        }
        const transcript = best.transcript
        if (result.isFinal) {
          newFinal += transcript
          if (best.confidence > 0) bestConfidence = best.confidence
        } else {
          newInterim += transcript
        }
      }

      if (newFinal) {
        setFinalText((prev) => prev + newFinal)
        if (bestConfidence !== null) setLastConfidence(bestConfidence)
      }
      setInterimText(newInterim)
    }

    recognitionRef.current = rec
    return () => {
      shouldBeListeningRef.current = false
      try { rec.stop() } catch { /* not running */ }
      recognitionRef.current = null
    }
  }, [lang])

  const start = useCallback(() => {
    if (!recognitionRef.current || isListening) return
    setError(null)
    setInterimText('')
    shouldBeListeningRef.current = true
    try {
      recognitionRef.current.start()
    } catch (e: any) {
      // "InvalidStateError" if already started — ignore
      if (!/InvalidStateError/i.test(String(e))) {
        setError(`Could not start recognition: ${e?.message ?? e}`)
      }
    }
  }, [isListening])

  const stop = useCallback(() => {
    shouldBeListeningRef.current = false
    if (!recognitionRef.current) return
    try { recognitionRef.current.stop() } catch { /* not running */ }
    setIsListening(false)
  }, [])

  const toggle = useCallback(() => {
    if (isListening) stop()
    else start()
  }, [isListening, start, stop])

  const reset = useCallback(() => {
    setFinalText('')
    setInterimText('')
    setLastConfidence(null)
  }, [])

  return {
    isSupported,
    isListening,
    finalText,
    interimText,
    lastConfidence,
    error,
    lang,
    start,
    stop,
    toggle,
    reset,
  }
}

export default useVoiceInput
