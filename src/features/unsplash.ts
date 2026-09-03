// Unsplash auto-wallpaper proxy.
// Keeps the access key server-side (env UNSPLASH_ACCESS_KEY), enforces
// Unsplash API guidelines (hotlinked urls.regular + download ping), and
// exposes a minimal surface to the frontend: GET /api/unsplash/random.
//
// Called by: index.ts (`app.use(unsplashRouter)`). Exports only the router.
// Optional by design: with no UNSPLASH_ACCESS_KEY the route returns a clean
// error and the app falls back to the bundled wallpapers.
import { Router } from 'express';

export const unsplashRouter = Router();

// --- Tiny in-memory rate limiter (self-contained; index.ts has its own) ---
interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();
const RATE_LIMIT = 20; // requests per minute per IP
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 60_000 };
    buckets.set(ip, b);
  }
  b.count += 1;
  return b.count > RATE_LIMIT;
}

const ALLOWED_ORIENTATIONS = new Set(['landscape', 'portrait', 'squarish']);

/**
 * GET /api/unsplash/random?query=nature&orientation=landscape
 * -> { url, alt, author, authorUrl }   (503 when key not configured)
 */
unsplashRouter.get('/api/unsplash/random', async (req, res) => {
  try {
    const ip = (req.ip || 'unknown').toString();
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    // Kill-switch: set UNSPLASH_ENABLED=false to pause the feature without
    // undeploying — the frontend treats 503 as "not configured" and stays silent.
    if ((process.env.UNSPLASH_ENABLED || 'true').trim().toLowerCase() === 'false') {
      return res.status(503).json({ error: 'unsplash_disabled' });
    }

    const accessKey = (process.env.UNSPLASH_ACCESS_KEY || '').trim();
    if (!accessKey) {
      return res.status(503).json({ error: 'unsplash_not_configured' });
    }

    const queryRaw = (req.query.query ?? '').toString();
    const query = queryRaw.slice(0, 100).trim() || 'nature landscape';
    if (!/^[\w\s,.-]+$/i.test(query)) {
      return res.status(400).json({ error: 'invalid_query' });
    }
    const orientation = (req.query.orientation ?? 'landscape').toString();
    if (!ALLOWED_ORIENTATIONS.has(orientation)) {
      return res.status(400).json({ error: 'invalid_orientation' });
    }

    const url =
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}` +
      `&orientation=${encodeURIComponent(orientation)}&client_id=${encodeURIComponent(accessKey)}`;

    const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      const status = upstream.status;
      console.warn(`[unsplash] upstream ${status}`);
      if (status === 401 || status === 403) return res.status(502).json({ error: 'upstream_auth_failed' });
      if (status === 429) return res.status(503).json({ error: 'upstream_rate_limited' });
      return res.status(502).json({ error: 'upstream_error' });
    }

    const photo: any = await upstream.json();
    const result = {
      url: photo?.urls?.regular as string,
      alt: (photo?.alt_description as string) || 'Unsplash wallpaper',
      author: (photo?.user?.name as string) || 'Unknown',
      // Unsplash guidelines: attribution links carry utm params.
      authorUrl: `${photo?.user?.links?.html ?? 'https://unsplash.com'}?utm_source=enzo&utm_medium=referral`,
    };
    if (!result.url) {
      return res.status(502).json({ error: 'upstream_error' });
    }

    // Unsplash guidelines: ping the download endpoint (fire-and-forget).
    if (photo?.links?.download_location) {
      fetch(`${photo.links.download_location}?client_id=${encodeURIComponent(accessKey)}`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }

    res.json(result);
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    console.error('[unsplash] proxy error:', isTimeout ? 'timeout' : err?.message);
    res.status(502).json({ error: isTimeout ? 'upstream_timeout' : 'upstream_error' });
  }
});
