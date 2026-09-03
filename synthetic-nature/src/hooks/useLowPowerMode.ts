/**
 * Low-power mode detection for weak devices.
 *
 * The signature background themes run a full-screen WebGL loop blending video
 * textures at 60fps — gorgeous on a real GPU, brutal on a low-end laptop or
 * integrated graphics. This hook decides when to swap that for a cheap static
 * gradient, from three signals (any one trips it):
 *   1. Manual override — user toggled Lite mode (persisted in localStorage).
 *   2. OS accessibility — `prefers-reduced-motion: reduce`.
 *   3. Weak hardware — few CPU cores or little device memory (best-effort;
 *      these APIs are absent on some browsers, so they only ever ADD signal).
 *
 * `setLowPowerOverride(true|false|null)` sets/clears the manual override
 * (null = fall back to auto-detection). Emits a window event so every consumer
 * re-reads without prop-drilling.
 */
import { useEffect, useState } from 'react'

const LS_KEY = 'enzo.lowPower'
const EVT = 'enzo-lowpower-changed'

function readOverride(): boolean | null {
  try {
    const v = localStorage.getItem(LS_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/** Auto-detect: reduced-motion preference OR genuinely weak hardware. Kept
 *  CONSERVATIVE on purpose — the video themes are the product's showcase, so we
 *  only auto-disable on clearly low-end machines; everyone else can opt in via
 *  the manual Lite-mode toggle. */
function detectWeak(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true
  } catch { /* ignore */ }
  const cores = navigator.hardwareConcurrency
  if (typeof cores === 'number' && cores > 0 && cores <= 2) return true
  // deviceMemory is Chromium-only + coarse (0.25–8 GiB); absent elsewhere.
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory
  if (typeof mem === 'number' && mem > 0 && mem <= 2) return true
  return false
}

export function setLowPowerOverride(value: boolean | null): void {
  try {
    if (value === null) localStorage.removeItem(LS_KEY)
    else localStorage.setItem(LS_KEY, value ? '1' : '0')
  } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVT))
}

/** Current manual override (true/false) or null when unset (auto). */
export function getLowPowerOverride(): boolean | null {
  return readOverride()
}

export function useLowPowerMode(): boolean {
  const compute = () => {
    const override = readOverride()
    return override === null ? detectWeak() : override
  }
  const [low, setLow] = useState<boolean>(compute)
  useEffect(() => {
    const update = () => setLow(compute())
    window.addEventListener(EVT, update)
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    mq?.addEventListener?.('change', update)
    return () => {
      window.removeEventListener(EVT, update)
      mq?.removeEventListener?.('change', update)
    }
  }, [])
  return low
}
