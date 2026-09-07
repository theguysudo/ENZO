// LiquidTick — the "key is valid" indicator used in onboarding save buttons.
//
// Geometry and animation are the animated-checkbox tick unchanged: the inner
// lens collapses to zero on check, two bars slide in to draw the checkmark,
// hover shrinks the lens, press scales the circle. Only the skin differs from
// the original green-gradient demo: frosted glass with the same rim/highlight
// language as .liquid-glass-panel, picking up an emerald wash when checked so
// it reads as "valid" next to the green-500 save state.
//
// This is an indicator, not a control — `checked` comes from key-save state,
// so it renders as a span and cannot be toggled by clicking.

import styled from 'styled-components'

const StyledTick = styled.span<{ $size: number }>`
  --size: ${(p) => `${p.$size}px`};
  --shadow: calc(var(--size) * 0.07) calc(var(--size) * 0.1);

  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  width: var(--size);
  height: var(--size);
  border-radius: 50%;
  background-color: rgba(255, 255, 255, 0.05);
  background-image: linear-gradient(
    160deg,
    rgba(255, 255, 255, 0.12) 0%,
    rgba(255, 255, 255, 0.02) 40%,
    rgba(255, 255, 255, 0.06) 100%
  );
  backdrop-filter: blur(10px) saturate(160%);
  -webkit-backdrop-filter: blur(10px) saturate(160%);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.28),
    inset 0 0 calc(var(--size) * 0.25) rgba(255, 255, 255, 0.03),
    0 var(--shadow) calc(var(--size) * 0.3) rgba(0, 0, 0, 0.35);
  cursor: default;
  overflow: hidden;
  vertical-align: middle;
  z-index: 1;
  transition:
    0.2s ease transform,
    0.2s ease background-color,
    0.2s ease box-shadow;

  /* Liquid-glass rim — the same masked gradient ring as .liquid-glass-panel::before */
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    padding: 1px;
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.45) 0%,
      rgba(255, 255, 255, 0.14) 22%,
      rgba(255, 255, 255, 0.03) 50%,
      rgba(255, 255, 255, 0.14) 78%,
      rgba(255, 255, 255, 0.45) 100%
    );
    -webkit-mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
  }

  /* Inner glass lens — collapses to zero when checked, shrinks on hover */
  &::before {
    content: '';
    position: absolute;
    top: 50%;
    right: 0;
    left: 0;
    width: calc(var(--size) * 0.7);
    height: calc(var(--size) * 0.7);
    margin: 0 auto;
    background-color: rgba(255, 255, 255, 0.12);
    background-image: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.22) 0%,
      rgba(255, 255, 255, 0.01) 100%
    );
    transform: translateY(-50%);
    border-radius: 50%;
    box-shadow: inset 0 var(--shadow) rgba(255, 255, 255, 0.22);
    transition:
      0.2s ease width,
      0.2s ease height,
      0.2s ease background-color;
  }

  &:hover::before {
    width: calc(var(--size) * 0.55);
    height: calc(var(--size) * 0.55);
    box-shadow: inset 0 var(--shadow) rgba(255, 255, 255, 0.12);
  }

  &:active {
    transform: scale(0.9);
  }

  /* Checked state is keyed off a data attribute, not a generated class, so
     flipping it never swaps the class name — the 0.2s transitions always fire. */
  &[data-checked='true'] {
    background-color: rgba(74, 222, 128, 0.12);
    box-shadow:
      inset 0 1px 1px rgba(255, 255, 255, 0.5),
      inset 0 0 calc(var(--size) * 0.3) rgba(74, 222, 128, 0.15),
      0 var(--shadow) calc(var(--size) * 0.45) rgba(74, 222, 128, 0.4);

    &::before {
      width: 0;
      height: 0;
    }

    .tick_mark::before,
    .tick_mark::after {
      transform: translate(0);
      opacity: 1;
    }
  }

  /* The checkmark itself — two bars on a rotated arm */
  .tick_mark {
    position: absolute;
    top: -1px;
    right: 0;
    left: calc(var(--size) * -0.05);
    width: calc(var(--size) * 0.6);
    height: calc(var(--size) * 0.6);
    margin: 0 auto;
    margin-left: calc(var(--size) * 0.14);
    transform: rotateZ(-40deg);
  }

  .tick_mark::before,
  .tick_mark::after {
    content: '';
    position: absolute;
    background-color: #fff;
    border-radius: calc(var(--size) * 0.04);
    opacity: 0;
    transition:
      0.2s ease transform,
      0.2s ease opacity;
  }

  .tick_mark::before {
    left: 0;
    bottom: 0;
    width: calc(var(--size) * 0.1);
    height: calc(var(--size) * 0.3);
    box-shadow: -2px 0 5px rgba(0, 0, 0, 0.23);
    transform: translateY(calc(var(--size) * -0.68));
  }

  .tick_mark::after {
    left: 0;
    bottom: 0;
    width: 100%;
    height: calc(var(--size) * 0.1);
    box-shadow: 0 3px 5px rgba(0, 0, 0, 0.23);
    transform: translateX(calc(var(--size) * 0.78));
  }
`

function LiquidTick({ checked, size = 50 }: { checked: boolean; size?: number }) {
  return (
    <StyledTick
      $size={size}
      data-checked={checked ? 'true' : 'false'}
      role="img"
      aria-label={checked ? 'Key saved' : undefined}
    >
      <span className="tick_mark" />
    </StyledTick>
  )
}

export { LiquidTick }
