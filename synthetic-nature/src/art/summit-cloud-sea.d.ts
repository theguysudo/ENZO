export const meta: {
  slug: string
  name: string
  category: string
  note: string
  tags: string[]
  cols: number
  rows: number
  fps: number
  cell: string
  look: string
  dots?: unknown
  palette: Record<string, string>
}
export default function create(): (t: number) => { text: string; color: string }
