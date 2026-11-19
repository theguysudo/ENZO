import { IS_LITE } from '../../lib/variant'

export type MarketplaceCyberpunkScene =
  | 'nyc_subway'
  | 'bioluminescent_ocean'
  | 'rooftop'
  | 'boulevard'
  | 'ink_rain'
  | 'space_station'
  | 'purple_flowers'
  | 'milky_way'
  | 'alien'
  | 'rocket'
  | 'space_probe'
  | 'coding_deck'

export interface WorkspaceThemeMeta {
  id: string
  label: string
  scene: MarketplaceCyberpunkScene | null
}

const ALL_WORKSPACE_THEMES: WorkspaceThemeMeta[] = [
  { id: 'spring_day', label: 'Default Particles', scene: null },
  { id: 'nyc_subway', label: 'NYC Subway Ride', scene: 'nyc_subway' },
  { id: 'bioluminescent_ocean', label: 'Bioluminescent Ocean', scene: 'bioluminescent_ocean' },
  { id: 'alien_contact', label: 'Alien Contact', scene: 'alien' },
  { id: 'rocket', label: 'Rocket Loop', scene: 'rocket' },
  { id: 'space_probe', label: 'Space Probe', scene: 'space_probe' },
  { id: 'coding_deck', label: 'Coding Deck', scene: 'coding_deck' },
  { id: 'neon_boulevard', label: 'Neon Boulevard', scene: 'boulevard' },
  { id: 'ink_rain', label: 'Ink Rain', scene: 'ink_rain' },
  { id: 'space_station', label: 'Space Station', scene: 'space_station' },
  { id: 'purple_flowers', label: 'Purple Flowers', scene: 'purple_flowers' },
  { id: 'milky_way', label: 'Milky Way', scene: 'milky_way' },
]

// The lite docker image ships exactly two theme videos: the 3.3MB AI-animated
// NYC subway loop and the Bioluminescent Ocean clip (both kept by the
// Dockerfile's lite branch). Default Particles (first entry) needs none, so
// slicing to the first THREE entries gives the lite build one pure-WebGL
// theme plus two real-video themes — small enough that `enzo:lite` still
// feels tiny while self-hosters get more than one moving backdrop. Slicing
// here (not in consumers) keeps pickers, the terminal backdrop inheritance,
// and localStorage guards consistent.
// See src/lib/variant.ts and deploy/docker-variant/Dockerfile.
export const WORKSPACE_THEMES: WorkspaceThemeMeta[] = IS_LITE
  ? ALL_WORKSPACE_THEMES.slice(0, 3)
  : ALL_WORKSPACE_THEMES

export function getAnimeSceneFromId(id: string): MarketplaceCyberpunkScene | null {
  const sceneMap: Record<string, MarketplaceCyberpunkScene> = {
    nyc_subway: 'nyc_subway',
    bioluminescent_ocean: 'bioluminescent_ocean',
    alien_contact: 'alien',
    rocket: 'rocket',
    space_probe: 'space_probe',
    coding_deck: 'coding_deck',
    rooftop_dojo: 'rooftop',
    neon_boulevard: 'boulevard',
    ink_rain: 'ink_rain',
    space_station: 'space_station',
    purple_flowers: 'purple_flowers',
    milky_way: 'milky_way',
  }
  return sceneMap[id] || null
}
