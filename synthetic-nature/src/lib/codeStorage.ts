/**
 * Temporary coding-file storage (browser-local).
 *
 * Every coding task that gets a live preview (single HTML doc OR multi-file
 * project) is mirrored here so the generated backend/frontend files survive
 * reload and can be zipped/downloaded without hitting the server again.
 *
 * Container key: `enzo.chat.v3.code-files` → `StoredCodeTask[]` (newest first).
 * Guardrailed for the ~5MB localStorage ceiling: capped entry count, size
 * checks per task, and every write wrapped so a quota error never breaks chat.
 */

export interface StoredCodeTask {
  id: string
  kind: 'html' | 'project'
  title: string
  files: Record<string, string>
  createdAt: number
  updatedAt: number
}

const STORAGE_KEY = 'enzo.chat.v3.code-files'
const MAX_TASKS = 20
const MAX_BYTES = 4 * 1024 * 1024 // stay under the ~5MB localStorage ceiling

export function loadCodeTasks(): StoredCodeTask[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0) return parsed
    return []
  } catch {
    return []
  }
}

export function getCodeTask(id: string): StoredCodeTask | null {
  if (!id) return null
  return loadCodeTasks().find((t) => t.id === id) ?? null
}

/** Upsert a task; de-dupe by id, newest first, capped at MAX_TASKS. */
export function storeCodeTask(task: StoredCodeTask): boolean {
  if (typeof window === 'undefined') return false
  if (!task || !task.id) return false

  const fileBytes = Object.values(task.files || {}).reduce(
    (acc, content) => acc + (content ? content.length : 0),
    0,
  )
  if (fileBytes > MAX_BYTES) return false

  const tasks = loadCodeTasks().filter((t) => t.id !== task.id)
  tasks.unshift(task)
  const trimmed = tasks.slice(0, MAX_TASKS)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
    return true
  } catch {
    // Quota exceeded (or serialization quirk) — drop the oldest task and retry
    // once so the newest coding output still gets persisted.
    try {
      const retry = trimmed.slice(0, -1)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(retry))
      return retry.length > 0
    } catch {
      return false
    }
  }
}

export function removeCodeTask(id: string): void {
  if (typeof window === 'undefined' || !id) return
  const tasks = loadCodeTasks().filter((t) => t.id !== id)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
  } catch {
    /* ignore */
  }
}

export function clearCodeTasks(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/* ─── Dependency-free ZIP writer (STORE method + CRC32) ──────────────── */

let crcTable: Int32Array | null = null

function crc32(buf: Uint8Array): number {
  let table = crcTable
  if (!table) {
    table = crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f)
  const dateval =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f)
  return { time, date: dateval }
}

/** Build a valid `.zip` blob (no compression — STORE) for the given files. */
export function createZipBlob(files: Record<string, string>): Blob {
  const names = Object.keys(files)
  const enc = new TextEncoder()
  const chunks: BlobPart[] = []

  const push = (u8: Uint8Array) => chunks.push(u8 as BlobPart)
  const u16 = (v: number) => { push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff])) }
  const u32 = (v: number) => { push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff])) }
  const bytesOf = (name: string, content: string): { name: Uint8Array; data: Uint8Array } => ({
    name: enc.encode(name),
    data: enc.encode(content),
  })

  const localOffsets: number[] = []
  // Two-pass: first compute local offsets, then emit headers + data.
  let cursor = 0
  const parsed = names.map((name) => {
    const { name: nameB, data } = bytesOf(name, files[name])
    localOffsets.push(cursor)
    cursor += 30 + nameB.length + data.length
    return { name, nameB, data, crc: crc32(data) }
  })

  // Local file headers
  for (const { nameB, data, crc } of parsed) {
    const { time, date } = dosDateTime()
    u32(0x04034b50)
    u16(20) // version needed
    u16(0) // flags
    u16(0) // method: stored
    u16(time)
    u16(date)
    u32(crc)
    u32(data.length)
    u32(data.length)
    u16(nameB.length)
    u16(0) // extra len
    if (nameB.length) push(nameB)
    if (data.length) push(data)
  }

  // Central directory
  const cdStart = cursor
  let cdCursor = cdStart
  parsed.forEach(({ nameB, data, crc }, i) => {
    const { time, date } = dosDateTime()
    u32(0x02014b50)
    u16(20)
    u16(20)
    u16(0)
    u16(0)
    u16(time)
    u16(date)
    u32(crc)
    u32(data.length)
    u32(data.length)
    u16(nameB.length)
    u16(0) // extra
    u16(0) // comment
    u16(0) // disk start
    u16(0) // internal attrs
    u32(0) // external attrs
    u32(localOffsets[i])
    if (nameB.length) push(nameB)
    cdCursor += 46 + nameB.length
  })
  const cdSize = cdCursor - cdStart

  // End of central directory
  u32(0x06054b50)
  u16(0)
  u16(0)
  u16(parsed.length)
  u16(parsed.length)
  u32(cdSize)
  u32(cdStart)
  u16(0)

  return new Blob(chunks, { type: 'application/zip' })
}

/** Trigger a browser download of the task's files as `.zip`. */
export function downloadTaskZip(task: StoredCodeTask): void {
  if (!task || typeof window === 'undefined') return
  const blob = createZipBlob(task.files)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date(task.createdAt).toISOString().slice(0, 10)
  a.href = url
  a.download = `${task.title.replace(/[^\w-]+/g, '-').toLowerCase() || 'enzo-task'}-${stamp}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}