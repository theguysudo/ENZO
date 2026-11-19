/**
 * neuralTypeVisuals.ts — the Neural Map's visual language for node types.
 *
 * Eight node types, each with its own dark-mode accent (similar lightness so
 * no type shouts over another) and a badge sprite: a glassy dark disc with a
 * colored ring + glyph, generated as an inline SVG data-URI. The sprite is
 * what reagraph renders INSTEAD of a plain sphere (node.icon replaces the
 * mesh in 4.22) — so the disc, ring and glyph all live in the SVG.
 *
 * Rejected nodes override to coral regardless of type. The DOM side (legend,
 * inspector, fallback SVG graph) reads the same colors, so a type looks
 * identical in the 3D canvas, the low-power graph and the inspector.
 */

export const NODE_TYPE_COLORS: Record<string, string> = {
  topic: '#a78bfa',       // violet
  concept: '#22d3ee',     // cyan
  source: '#fbbf24',      // amber
  claim: '#34d399',       // emerald
  method: '#60a5fa',      // blue
  preference: '#f472b6',  // pink
  question: '#fb923c',    // orange
  finding: '#2dd4bf',     // teal
}

export const REJECTED_COLOR = '#f0968a'

/** Stroke-glyph paths in a 128×128 space (drawn around the disc center 64,64). */
const GLYPHS: Record<string, string> = {
  // hash — topic
  topic: 'M52 44 L48 84 M80 44 L76 84 M40 56 L88 56 M40 72 L88 72',
  // lightbulb — concept
  concept: 'M64 38 a17 17 0 0 1 10 30 q-4 4 -4 10 h-12 q0 -6 -4 -10 a17 17 0 0 1 10 -30 M56 88 h16',
  // globe — source
  source: 'M64 38 a26 26 0 1 0 0 52 a26 26 0 0 0 0 -52 M38 64 h52 M64 38 a34 22 0 0 1 0 52 a34 22 0 0 1 0 -52',
  // badge-check — claim
  claim: 'M64 36 a26 26 0 1 0 0.1 0 M52 64 l9 9 l17 -18',
  // gear — method
  method: 'M64 46 a18 18 0 1 0 0.1 0 M64 30 v8 M64 90 v8 M30 64 h8 M90 64 h8 M40 40 l6 6 M82 82 l6 6 M88 40 l-6 6 M46 82 l-6 6',
  // sliders — preference
  preference: 'M38 48 h52 M38 64 h52 M38 80 h52 M54 48 a4 4 0 1 0 0.1 0 M76 64 a4 4 0 1 0 0.1 0 M48 80 a4 4 0 1 0 0.1 0',
  // question — question
  question: 'M50 52 a14 14 0 1 1 22 12 q-8 5 -8 14 M64 92 a3 3 0 1 0 0.1 0',
  // sparkle — finding
  finding: 'M64 32 L71 57 L96 64 L71 71 L64 96 L57 71 L32 64 L57 57 Z',
}

export function nodeTypeColor(type: string, rejected?: boolean): string {
  return rejected ? REJECTED_COLOR : (NODE_TYPE_COLORS[type] ?? '#94a3b8')
}

/** 128×128 badge sprite: dark glass disc, colored ring + glyph. */
export function nodeBadgeUri(type: string, rejected?: boolean): string {
  const color = nodeTypeColor(type, rejected)
  const glyph = rejected
    ? // X for rejected
      'M50 50 L78 78 M78 50 L50 78'
    : (GLYPHS[type] ?? GLYPHS.concept)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <radialGradient id="g" cx="50%" cy="38%" r="75%">
      <stop offset="0%" stop-color="rgba(58,58,70,0.98)"/>
      <stop offset="100%" stop-color="rgba(14,14,19,0.98)"/>
    </radialGradient>
  </defs>
  <circle cx="64" cy="64" r="56" fill="url(#g)"/>
  <circle cx="64" cy="64" r="55" fill="none" stroke="${color}" stroke-opacity="0.9" stroke-width="5"/>
  <circle cx="64" cy="64" r="48" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="2"/>
  <g fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="${glyph}"/></g>
</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.replace(/\n\s*/g, ''))}`
}

export const NODE_TYPE_LEGEND = Object.keys(NODE_TYPE_COLORS)
