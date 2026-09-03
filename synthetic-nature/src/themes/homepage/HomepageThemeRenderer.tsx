import { InteractiveNebulaShader } from '@/components/ui/liquid-shader'
import { HomepageAnimeSky } from './HomepageAnimeSky'
import type { HomepageTheme, HomepageAnimeScene } from './types'

interface HomepageThemeRendererProps {
  theme: HomepageTheme
}

export function HomepageThemeRenderer({ theme }: HomepageThemeRendererProps) {
  if (theme.startsWith('anime-')) {
    const scene = theme.replace('anime-', '') as HomepageAnimeScene
    return (
      <>
        <HomepageAnimeSky scene={scene} />
        <div className="fixed inset-0 z-0 bg-black/30 pointer-events-none" />
      </>
    )
  }

  // 'nebula' — the shader already dims its own centre for content readability,
  // so it skips the black/30 overlay the video themes need on top of them.
  return <InteractiveNebulaShader />
}
