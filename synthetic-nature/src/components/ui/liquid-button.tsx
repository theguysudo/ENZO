import type { ButtonHTMLAttributes } from "react"

type LiquidButtonProps = ButtonHTMLAttributes<HTMLButtonElement>

/**
 * LiquidButton — hover to watch the liquid fill rise from the bottom.
 *
 * All animation logic lives in index.css (.liquid-btn, .liquid-btn__fill, etc.)
 * using native CSS :hover selectors. No Tailwind group-hover — that's what
 * caused the fill to never trigger.
 */
function LiquidButton({
  children,
  className = "",
  type = "button",
  ...props
}: LiquidButtonProps) {
  return (
    <button
      className={`liquid-btn ${className}`}
      type={type}
      {...props}
    >
      {/* Rising liquid fill + wave discs + bubbles */}
      <span className="liquid-btn__fill" aria-hidden="true">
        <span className="liquid-btn__wave liquid-btn__wave--1" />
        <span className="liquid-btn__wave liquid-btn__wave--2" />
        <span className="liquid-btn__bubble liquid-btn__bubble--1" />
        <span className="liquid-btn__bubble liquid-btn__bubble--2" />
        <span className="liquid-btn__bubble liquid-btn__bubble--3" />
      </span>

      {/* Label — sits above the liquid fill */}
      <span className="liquid-btn__label">
        {children}
      </span>

      {/* Top edge glare */}
      <span className="liquid-btn__glare" aria-hidden="true" />
    </button>
  )
}

export { LiquidButton }
export type { LiquidButtonProps }