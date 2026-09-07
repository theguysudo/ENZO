// SystemPulse — the live "all systems" ECG strip beside the terminal's
// ONLINE badge.
//
// Same heart-rate monitor as the original loader: same 0 0 150 73 trace,
// same 2.5s sweep — a segment of the heartbeat opens at the left edge,
// races across, then collapses at the right, forever. Only the mechanism
// is reworked to blend into the terminal toolbar: the loader hid the
// trace behind solid cover blocks, which forced an opaque chip background
// and looked pasted onto the toolbar's translucent glass. Here the sweep
// is a clip-path window on the trace itself — nothing is painted behind
// the ECG, so the toolbar's own dark glass shows through untouched.
//
// "Online" is not decorative: the strip pings /api/v1/models — the same
// aggregated catalog endpoint the hub rides — with a 5s timeout and
// re-checks every 60s. Reachable + non-empty catalog = heartbeat + ONLINE;
// anything else freezes a flat red line with a FLATLINE label. The first
// check is optimistic (heartbeat shown while probing) so a healthy system
// never flashes red on load.

import { useEffect, useState } from 'react'
import styled from 'styled-components'

const MODELS_ENDPOINT = '/api/v1/models'
const CHECK_INTERVAL = 60 * 1000

const ECG_POINTS =
  '0,45.486 38.514,45.486 44.595,33.324 50.676,45.486 57.771,45.486 62.838,55.622 71.959,9 80.067,63.729 84.122,45.486 97.297,45.486 103.379,40.419 110.473,45.486 150,45.486'
const FLAT_POINTS = '0,45.486 150,45.486'

const Strip = styled.div<{ $flat: boolean }>`
  position: relative;
  width: 49px;
  height: 24px;

  svg {
    position: absolute;
    inset: 0;
    display: block;
    overflow: visible;
  }

  polyline {
    fill: none;
    stroke-width: 3;
    stroke-miterlimit: 10;
  }

  /* Faint full waveform underneath — like the dim paper trace on a real
     monitor, it keeps the strip's footprint legible between sweeps. */
  .base polyline {
    stroke: ${(p) => (p.$flat ? 'rgba(248, 113, 113, 0.18)' : 'rgba(74, 222, 128, 0.16)')};
  }

  /* The live sweep — window opens at the left, closes at the right. */
  .beat {
    animation: sysPulseSweep 2.5s linear infinite;

    polyline {
      stroke: #4ade80;
      filter: drop-shadow(0 0 4px rgba(74, 222, 128, 0.55));
    }
  }

  .flat polyline {
    stroke: #f87171;
    filter: drop-shadow(0 0 3px rgba(248, 113, 113, 0.45));
  }

  @keyframes sysPulseSweep {
    0% {
      clip-path: inset(0 100% 0 0);
    }
    50% {
      clip-path: inset(0 0 0 0);
    }
    100% {
      clip-path: inset(0 0 0 100%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .beat {
      animation: none;
      clip-path: none;
    }
  }
`

export function SystemPulse() {
  const [flat, setFlat] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const check = async () => {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        const res = await fetch(MODELS_ENDPOINT, { signal: controller.signal })
        clearTimeout(timeout)
        const body = await res.json().catch(() => null)
        const data = Array.isArray(body?.data) ? body.data : []
        if (!cancelled) setFlat(!(res.ok && data.length > 0))
      } catch {
        if (!cancelled) setFlat(true)
      }
      if (!cancelled) timer = setTimeout(check, CHECK_INTERVAL)
    }

    check()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return (
    <div
      role="status"
      aria-label={flat ? 'System flatline' : 'All systems online'}
      title={flat ? 'System flatline — backend unreachable or catalog empty' : 'Live system pulse — backend and provider catalog responding'}
      className="flex items-center gap-1.5"
    >
      <Strip $flat={flat} aria-hidden="true">
        <svg className="base" viewBox="0 0 150 73" xmlns="http://www.w3.org/2000/svg">
          <polyline points={flat ? FLAT_POINTS : ECG_POINTS} />
        </svg>
        <svg className={flat ? 'flat' : 'beat'} viewBox="0 0 150 73" xmlns="http://www.w3.org/2000/svg">
          <polyline points={flat ? FLAT_POINTS : ECG_POINTS} />
        </svg>
      </Strip>
      <span className={`font-mono text-[10px] ${flat ? 'text-red-400' : 'text-white/40'}`}>
        {flat ? 'FLATLINE' : 'ONLINE'}
      </span>
    </div>
  )
}

export default SystemPulse
