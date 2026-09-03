import { IS_LITE } from '../../lib/variant'

export type MarketplaceCyberpunkScene =
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

// The lite docker image ships zero theme videos, and Default Particles (the
// first entry) is the only workspace theme that needs none — it's a pure
// three.js particle field (scene: null). Slicing here (not in consumers)
// keeps pickers, the terminal backdrop inheritance, and localStorage guards
// consistent: in a lite build the app simply has one workspace theme.
// See src/lib/variant.ts.
export const WORKSPACE_THEMES: WorkspaceThemeMeta[] = IS_LITE
  ? ALL_WORKSPACE_THEMES.slice(0, 1)
  : ALL_WORKSPACE_THEMES

export function getAnimeSceneFromId(id: string): MarketplaceCyberpunkScene | null {
  const sceneMap: Record<string, MarketplaceCyberpunkScene> = {
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
