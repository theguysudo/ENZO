import { IS_LITE } from '../../lib/variant'

export type HomepageAnimeScene =
  | 'sky'
  | 'cottage'
  | 'observatory'
  | 'forest'
  | 'alien'
  | 'rocket'
  | 'space_probe'
  | 'coding_deck'
  | 'purple_flowers'

export type HomepageTheme = 'nebula' | `anime-${HomepageAnimeScene}`

export interface HomepageThemeMeta {
  id: HomepageTheme
  label: string
  short: string
}

const ALL_HOMEPAGE_THEMES: HomepageThemeMeta[] = [
  { id: 'nebula', label: 'Nebula drift', short: 'N' },
  { id: 'anime-cottage', label: 'Rain cottage', short: 'R' },
  { id: 'anime-observatory', label: 'Moon observatory', short: 'O' },
  { id: 'anime-forest', label: 'Misty forest', short: 'F' },
  { id: 'anime-alien', label: 'Alien contact', short: 'A' },
  { id: 'anime-rocket', label: 'Rocket loop', short: 'K' },
  { id: 'anime-space_probe', label: 'Space probe', short: 'P' },
  { id: 'anime-coding_deck', label: 'Coding deck', short: 'C' },
  { id: 'anime-purple_flowers', label: 'Purple flowers', short: 'U' },
]

// The lite docker image ships zero theme videos, and Nebula drift (the first
// entry) is the only homepage theme that needs none — it's a pure WebGL
// shader. Slicing here (not in consumers) keeps every picker, fallback, and
// localStorage guard consistent: in a lite build the app simply has one
// homepage theme. See src/lib/variant.ts.
export const HOMEPAGE_THEMES: HomepageThemeMeta[] = IS_LITE
  ? ALL_HOMEPAGE_THEMES.slice(0, 1)
  : ALL_HOMEPAGE_THEMES
