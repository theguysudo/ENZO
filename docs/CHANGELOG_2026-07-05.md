# ENZO Backend — Change Log (2026-07-05)

## Summary

Four bug fixes and one optimization across image generation, deep research, and the Nitro chat proxy.

---

## Changes

### 1. `frontend2/src/routes/api/chat.ts` — Research context proxy bug fix

**Problem:** The Nitro proxy that forwards chat requests from the browser to the Express backend was silently dropping `researchContext` and `researchDepth` from the request body. Deep research and medium research produced empty/generic responses because the synthesizer never received the crawled source data.

**Fix:** Added both fields to the forwarded JSON body:
```ts
researchContext: body.researchContext,
researchDepth: body.researchDepth,
```

---

### 2. `index.ts` — Legacy-format branch reads research fields

**Problem:** The Express `/api/chat` handler only read `researchContext` / `researchDepth` in the AI SDK format branch (`body.messages` present). Requests coming through the Nitro proxy use legacy format and previously ignored these fields even after the proxy fix above.

**Fix:** Added the same extraction logic to the legacy format branch so both paths populate `providerKeys.__researchContext` and `providerKeys.__researchDepth`.

---

### 3. `index.ts` — Research synthesis model changed to `llama-3.3-70b-versatile`

**Problem:** Research mode used `compound-beta` (Groq's agentic model with built-in web search) as the synthesis model. Because `compound-beta` runs its own searches, it often ignored or partially replaced the injected `[RESEARCH CONTEXT]` — causing irrelevant or shallow reports.

**Fix:** Changed the research route to `llama-3.3-70b-versatile`, which has no built-in search and faithfully synthesizes from the provided context. Depth-specific prompts and token limits (`quick: 2048`, `deep: 4096`, `extreme: 8192`) are unchanged.

---

### 4. `index.ts` / `model-sync.ts` — Pollinations free anonymous image endpoint

**Problem:** `generateTextToImageWithModel()` called `gen.pollinations.ai/image/{prompt}` which requires a Pollen balance on the server API key. When the key ran out of credits, all image generation failed.

**Fix:**
- Added constant `POLLINATIONS_IMG_FREE = 'https://image.pollinations.ai'` (the free anonymous endpoint — no Pollen required, rate-limited to 1 req/15 s).
- `generateTextToImageWithModel()` now tries `image.pollinations.ai/prompt/{prompt}` first with no auth header, then falls back to the gen API with the server Pollen key only if the free endpoint fails.
- Added `turbo` to `IMAGE_MODELS` array (`['turbo', 'flux', 'zimage', 'kontext']`).
- Added `turbo` metadata to `model-sync.ts` curated Pollinations model list.
- Updated the `/api/recommend` model list string to include `turbo` and `kontext`.

---

### 5. `index.ts` — Exa search uses highlights only (free tier protection)

**Problem:** `exaSearchDeep()` requested both `highlights` and `text: { maxCharacters }` in each Exa search call. The `text` (full page content) endpoint consumes paid content credits separate from the 20,000 free search requests/month — burning through the free allocation quickly.

**Fix:** Removed `text: { maxCharacters: contentChars }` from the Exa search body. Responses now use only `highlights` (3–5 sentences per result, included free in every search call). The `desc` field already preferred highlights over text (`r.highlights?.join(' ') || r.text`), so output quality is unchanged.

---

## Files Changed

| File | Change |
|------|--------|
| `frontend2/src/routes/api/chat.ts` | Forward `researchContext` + `researchDepth` to Express |
| `index.ts` | Legacy branch reads research fields; synthesis model → `llama-3.3-70b-versatile`; free Pollinations image endpoint; `turbo` added to IMAGE_MODELS; Exa highlights-only |
| `model-sync.ts` | Added `turbo` to Pollinations curated model metadata |
