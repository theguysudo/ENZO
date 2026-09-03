/**
 * Locked placeholder for the gesture-control feature.
 * The real overlay (GestureControlOverlay + GestureManager + ActionController)
 * lives on branch `feature/gesture-beta`; this badge reserves its slot.
 */
export function GestureBetaBadge() {
  return (
    <div
      className="fixed bottom-6 right-6 z-40 group cursor-not-allowed select-none"
      aria-disabled="true"
      title="In private beta on branch feature/gesture-beta"
    >
      <div className="rounded-full border border-white/10 bg-black/40 backdrop-blur-xl px-3.5 py-2 flex items-center gap-2.5 opacity-70 group-hover:opacity-100 transition-opacity">
        {/* Lock icon (inline SVG — no new deps) */}
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-white/50 shrink-0"
        >
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <div className="text-left leading-tight">
          <div className="font-mono-display text-[8px] uppercase tracking-[0.2em] text-white/70">
            Gesture Control
          </div>
          <div className="font-mono-display text-[7px] uppercase tracking-[0.2em] text-amber-400/70">
            Beta · Coming Soon
          </div>
        </div>
      </div>

      {/* Subtle hover tooltip */}
      <div className="pointer-events-none absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-lg border border-white/10 bg-black/90 px-2.5 py-1.5 font-mono-display text-[8px] uppercase tracking-wider text-white/60 opacity-0 group-hover:opacity-100 transition-opacity">
        In private beta on branch feature/gesture-beta
      </div>
    </div>
  )
}

export default GestureBetaBadge
