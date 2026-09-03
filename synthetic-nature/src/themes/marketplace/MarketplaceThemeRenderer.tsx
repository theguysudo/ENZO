import { lazy, Suspense } from 'react'
import { MarketplaceCyberpunkSky } from './MarketplaceCyberpunkSky'
import { getAnimeSceneFromId } from './types'
import type { WeatherType } from './InteractiveForestBackground'

// three.js (~600KB) lives ONLY in the forest background and only renders in the
// non-cyberpunk fallback branch — lazy-load it so it's a separate chunk fetched
// on demand instead of bloating the initial bundle (big win on low-end PCs).
const InteractiveForestBackground = lazy(() =>
  import('./InteractiveForestBackground').then((m) => ({ default: m.InteractiveForestBackground })),
)

interface MarketplaceThemeRendererProps {
  backgroundVideoId: string
  weather?: WeatherType
  onPreloadRequest?: (src: string) => void
}

export function MarketplaceThemeRenderer({
  backgroundVideoId,
  weather,
  onPreloadRequest,
}: MarketplaceThemeRendererProps) {
  const cyberpunkScene = getAnimeSceneFromId(backgroundVideoId)

  if (cyberpunkScene) {
    return (
      <>
        <MarketplaceCyberpunkSky scene={cyberpunkScene} />
        {/* Dark overlay to reduce brightness */}
        <div className="fixed inset-0 z-0 bg-black/40 pointer-events-none" />
      </>
    )
  }

  return (
    <>
      <Suspense fallback={<div className="fixed inset-0 z-0 bg-[#06070c]" aria-hidden="true" />}>
        <InteractiveForestBackground
          activeVideoId={backgroundVideoId}
          weather={weather}
          onPreloadRequest={onPreloadRequest}
        />
      </Suspense>
      {/* Dark overlay to reduce brightness */}
      <div className="fixed inset-0 z-0 bg-black/40 pointer-events-none" />
    </>
  )
}
