declare module 'ascii-magic-art/runtime/player.js' {
  export function play(pre: HTMLElement | null, mod: unknown, opts?: { look?: unknown; maxFps?: number }): () => void
}
