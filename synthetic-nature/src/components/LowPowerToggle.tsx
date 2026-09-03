/**
 * Floating Lite-mode toggle (bottom-right). Lets anyone force the low-power
 * static background on/off regardless of auto-detection — the escape hatch that
 * lets useLowPowerMode's auto-detection stay conservative. Occupies the slot the
 * old gesture badge used to.
 */
import { useLowPowerMode, setLowPowerOverride } from '../hooks/useLowPowerMode'

export function LowPowerToggle() {
  const low = useLowPowerMode()
  return (
    <button
      type="button"
      onClick={() => setLowPowerOverride(!low)}
      title={low ? 'Lite mode ON — static background (tap for full visuals)' : 'Full visuals — tap for Lite mode (faster on low-end PCs)'}
      aria-pressed={low}
      className="fixed bottom-6 right-6 z-40 rounded-full border border-white/10 bg-black/40 backdrop-blur-xl px-3 py-2 flex items-center gap-2 opacity-60 hover:opacity-100 transition-opacity cursor-pointer select-none"
    >
      <span className={`w-1.5 h-1.5 rounded-full ${low ? 'bg-amber-400' : 'bg-emerald-400'}`} />
      <span className="font-mono text-[8px] uppercase tracking-[0.2em] text-white/70">
        {low ? 'Lite' : 'Full'}
      </span>
    </button>
  )
}
