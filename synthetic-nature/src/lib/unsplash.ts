// Unsplash wallpaper fetcher, via the local backend proxy.
// The backend (index.ts) proxies api.unsplash.com/photos/random with the
// server-side UNSPLASH_ACCESS_KEY so the key never ships to the browser.

// Same-origin API base: relative in dev (Vite proxies /api → 5001) and prod.
const API_BASE = ''

export interface UnsplashWallpaper {
  url: string
  alt: string
  author: string
  authorUrl: string
  downloadLocation?: string
}

/** Thrown when the backend has no UNSPLASH_ACCESS_KEY configured (503). */
export class UnsplashUnavailableError extends Error {
  constructor(message = 'Unsplash key not configured') {
    super(message)
    this.name = 'UnsplashUnavailableError'
  }
}

export async function fetchUnsplashWallpaper(
  query: string,
  orientation: 'landscape' | 'portrait' | 'squarish' = 'landscape',
): Promise<UnsplashWallpaper> {
  const params = new URLSearchParams({ query, orientation })
  const res = await fetch(`${API_BASE}/api/unsplash/random?${params.toString()}`)

  if (res.status === 503) {
    // Key not configured on the server — the UI swallows this silently.
    throw new UnsplashUnavailableError()
  }
  if (!res.ok) {
    throw new Error(`Unsplash proxy error: ${res.status}`)
  }

  const data = (await res.json()) as Partial<UnsplashWallpaper>
  if (!data || typeof data.url !== 'string' || !data.url) {
    throw new Error('Unsplash proxy returned no image url')
  }

  return {
    url: data.url,
    alt: data.alt ?? query,
    author: data.author ?? 'Unknown',
    authorUrl: data.authorUrl ?? '',
    downloadLocation: data.downloadLocation,
  }
}
