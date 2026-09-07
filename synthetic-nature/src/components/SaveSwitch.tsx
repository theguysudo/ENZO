// SaveSwitch — the onboarding save button, replacing the old text button +
// LiquidTick pair. Same interaction design as the source Switch: a pill
// whose label slides aside on hover while the bookmark launches up-left,
// balloons to 750% and floods the pill with its solid fill — the balloon
// becomes the button's background, with the label punched on top. The
// bookmark also carries a solid fill once the key is saved.
//
// Structure follows the reference exactly — a transparent <button> that
// acts only as the click target/group wrapper, with the visible pill as an
// inner <div> carrying overflow-hidden. That is not cosmetic: WebKit does
// not apply overflow clipping to children of <button> elements, so a
// pill-on-button would let the ballooning bookmark escape its frame in
// Safari and the in-app browser. A div clips correctly everywhere.

import type { ButtonHTMLAttributes, ReactNode } from 'react'

type SaveSwitchProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  saved: boolean
  children: ReactNode
}

export function SaveSwitch({
  saved,
  disabled = false,
  className = '',
  children,
  ...buttonProps
}: SaveSwitchProps) {
  return (
    <button
      type="button"
      aria-pressed={saved}
      {...buttonProps}
      disabled={disabled}
      className={`group flex w-fit shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0 disabled:pointer-events-none disabled:opacity-30 ${className}`}
    >
      <div
        className={`flex w-fit items-center gap-2 overflow-hidden rounded-full border p-2 px-3 font-mono-display text-[9px] font-bold uppercase tracking-widest transition-all group-active:scale-90 ${
          saved
            ? 'border-green-500/40 bg-green-500/10 fill-green-500/80 text-green-400'
            : 'border-white/20 bg-white/5 fill-none text-white/80'
        }`}
      >
        <div className="z-10 transition group-hover:translate-x-4 group-hover:text-black">{children}</div>
        <svg
          className={`size-4 shrink-0 transition duration-500 group-hover:-translate-x-6 group-hover:-translate-y-3 group-hover:scale-[750%] ${
            saved ? 'group-hover:fill-green-400' : 'group-hover:fill-white'
          }`}
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z"
          />
        </svg>
      </div>
    </button>
  )
}

export default SaveSwitch
