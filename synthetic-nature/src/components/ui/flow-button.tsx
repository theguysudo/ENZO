import type { ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * FlowButton — pill outline that fills from a growing centre circle on hover,
 * with the arrow sliding through from left to right.
 *
 * Adapted from the light-on-white original to the homepage's dark surface:
 * white hairline and label, filling to a white disc with dark text.
 */
export function FlowButton({
  text = 'Modern Button',
  onClick,
  className,
  children,
}: {
  text?: string
  onClick?: () => void
  className?: string
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex cursor-pointer items-center gap-1 overflow-hidden rounded-[100px] border-[1.5px] border-white/25 bg-transparent px-8 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-white/85 transition-all duration-[600ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:rounded-[12px] hover:border-transparent hover:text-slate-950 active:scale-[0.96]',
        className,
      )}
    >
      {/* Arrow that flies in from the left on hover */}
      <ArrowRight
        aria-hidden="true"
        className="absolute left-[-25%] z-[9] h-4 w-4 fill-none stroke-white/85 transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:left-4 group-hover:stroke-slate-950"
      />

      <span className="relative z-[1] -translate-x-3 transition-all duration-[800ms] ease-out group-hover:translate-x-3">
        {children ?? text}
      </span>

      {/* Growing disc that becomes the fill */}
      <span
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 transition-all duration-[800ms] ease-[cubic-bezier(0.19,1,0.22,1)] group-hover:h-[220px] group-hover:w-[220px] group-hover:opacity-100"
      />

      {/* Resting arrow that exits right on hover */}
      <ArrowRight
        aria-hidden="true"
        className="absolute right-4 z-[9] h-4 w-4 fill-none stroke-white/85 transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:right-[-25%] group-hover:stroke-slate-950"
      />
    </button>
  )
}

export default FlowButton
