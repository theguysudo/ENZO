/**
 * modelPeer.ts — pick a model in the same power class as the one the user is on.
 *
 * The terminal's switch button used to recommend `llama-3.3-70b` no matter what,
 * because both the frontend default and the backend's prompt hardcoded it. That
 * offered a 70B jump to someone on an 8B model and a downgrade to someone on a
 * 120B one. This is the local half of the fix (the backend half routes through
 * the same LLM that decides auto-fallback).
 *
 * Structurally typed rather than importing CatalogModel from App.tsx: App.tsx
 * pulls in React and the whole component tree, and this module has to stay
 * loadable by plain node so modelPeer.test.ts can run on the backend's tsx.
 */

export interface PeerModel {
  id: string
  name: string
  type?: string
  free?: boolean
  context_length?: number
  health?: { status?: string } | null
}

/**
 * Rough power proxy: parameter count lifted out of the id/name ("…-70b" → 70).
 * When the name doesn't carry a size, the context window stands in as a class
 * hint. Only ever compared against another model's score, so the absolute
 * number means nothing — the ordering does.
 */
export function modelPower(m: PeerModel): number {
  const b = /(\d+(?:\.\d+)?)\s*b\b/i.exec(`${m.id} ${m.name}`)
  if (b) return Number(b[1])
  // ponytail: ctx/4096 is a crude stand-in, clamped to the range real params
  // land in. Swap for a published param-count field if the catalog ever gains one.
  return Math.min(120, Math.max(4, Math.round(Number(m.context_length || 8192) / 4096)))
}

/**
 * The candidate closest in power to the model the user is already running.
 * Image models are never peers of a chat model. Ties break on health, then free.
 */
export function closestPeer<T extends PeerModel>(pool: T[], current: PeerModel | null): T | undefined {
  const target = current ? modelPower(current) : 32
  return pool
    .filter((m) => m.id !== current?.id && m.type !== 'image' && m.type !== 'image-gen')
    .sort((a, b) => {
      const d = Math.abs(modelPower(a) - target) - Math.abs(modelPower(b) - target)
      if (d !== 0) return d
      const ha = a.health?.status === 'online' ? 0 : 1
      const hb = b.health?.status === 'online' ? 0 : 1
      if (ha !== hb) return ha - hb
      return (b.free ? 1 : 0) - (a.free ? 1 : 0)
    })[0]
}
