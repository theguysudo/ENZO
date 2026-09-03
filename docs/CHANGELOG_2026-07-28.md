# ENZO Backend — Change Log (2026-07-28)

## Summary

Major session: Hugging Face Serverless Inference API integration, model catalog filtering overhaul, WebGL performance optimisation, and UI glass-morphism polish.

---

## Changes

### 1. `index.ts` — HuggingFace Serverless Inference API (`streamHuggingFaceChat`)

**Problem:** `streamHuggingFaceChat` was calling `router.huggingface.co/v1/chat/completions` with a paid HF Router (inference providers) URL, burning commercial credits and causing 401/400 errors for most models.

**Fix:** Rewrote the function to hit `router.huggingface.co/hf-inference/v1/chat/completions` — the OpenAI-compatible endpoint for the **free shared hf-inference serverless cluster**. The payload now uses the standard `messages[]` format instead of a raw `inputs` prompt string. Parses both OpenAI delta tokens (`choices[0].delta.content`) and TGI streaming tokens (`token.text`).

---

### 2. `tunnel.ts` — HF Tunnel endpoint updated

**Problem:** The `PROVIDER_ENDPOINTS.hf` entry and `handleHuggingFaceServerlessRequest` function in the AI Tunnel middleware were using an outdated Serverless Inference URL that doesn't resolve correctly from the machine.

**Fix:**
- Updated `PROVIDER_ENDPOINTS.hf` to `https://api-inference.huggingface.co/models` (kept as reference base; per-model endpoint is constructed dynamically).
- `handleHuggingFaceServerlessRequest` now calls `router.huggingface.co/hf-inference/v1/chat/completions` with the proper OpenAI-compat `model` + `messages` JSON body.
- Dispatch logic in `tunnelRouter` now routes all `hf/` provider requests to `handleHuggingFaceServerlessRequest` instead of the generic streaming handler.

---

### 3. `model-sync.ts` — HF Model Catalog Source Replaced

**Problem:** The previous catalog sync used `router.huggingface.co/v1/models` (the paid Router API), returning 134 models, many of which were commercial/paid or not actually hosted on the free shared cluster — causing `400 Model not supported by provider hf-inference` errors at runtime.

**Fix:** Replaced the HF model discovery source with two filtered Hub API queries:

| Query | Filter | Purpose |
|-------|--------|---------|
| `huggingface.co/api/models?pipeline_tag=text-generation&filter=conversational&inference=warm&sort=downloads&direction=-1&limit=120` | `conversational` tag + `inference=warm` | Instruct/chat-tuned models warm on free cluster |
| `huggingface.co/api/models?pipeline_tag=image-text-to-text&inference=warm&sort=downloads&direction=-1&limit=30` | `inference=warm` | Multimodal vision-language models |

Key points:
- `inference=warm` → only models **actively warm on hf-inference** (not paid endpoints or cold models)
- `filter=conversational` → only instruct-tuned chat models that accept the chat completions format (eliminates base models that caused 400 errors)
- All HF models set `free: true` and `pricing_prompt: '$0.00'` — they require a free HF token but no paid credits
- Catalog count: **HF 157 models** (up from 134), all verified chat-compatible

---

### 4. `model-sync.ts` — All HuggingFace models marked free

**Problem:** Some HF models in the previous catalog were marked `free: false` with `pricing_prompt: 'Requires HF Pro or Dedicated Endpoint'`, even though the serverless cluster is free with a token.

**Fix:** All HF catalog entries now have `free: true` and `pricing_prompt: '$0.00'`. The only cost is a free HuggingFace account token (no billing).

---

### 5. WebGL / Canvas — DPR Performance Cap

**Problem:** Several WebGL backgrounds and the orb component were rendering at the full device pixel ratio (up to 2.0× on Retina displays), causing GPU lag on large screens.

**Fix:** Capped `dpr` to `Math.min(window.devicePixelRatio, 1.25)` in:
- `MarketplaceCyberpunkSky.tsx`
- `HomepageAnimeSky.tsx`
- `webgl-orb.tsx`

---

### 6. `index.css` — Liquid Glass UI panels

**Problem:** AI advisor conversation panel and input dock (`MorphPanel`) had opaque dark backgrounds that blocked the animated WebGL background.

**Fix:** Updated `.liquid-glass-panel` and `.mobile-menu-glass` to use `backdrop-blur-sm` with `saturate(180%)` boost, creating glossy translucent glass cards consistent with the overall theme aesthetic.

---

## Files Changed

| File | Change |
|------|--------|
| `index.ts` | `streamHuggingFaceChat` → OpenAI-compat chat completions endpoint; model ping URL updated |
| `tunnel.ts` | `PROVIDER_ENDPOINTS.hf`; `handleHuggingFaceServerlessRequest` rewrote payload + endpoint; tunnelRouter dispatches hf provider separately |
| `model-sync.ts` | Replaced HF Router source with Hub API `inference=warm&filter=conversational` queries; all HF models marked free |
| `synthetic-nature/src/themes/marketplace/MarketplaceCyberpunkSky.tsx` | DPR capped to 1.25 |
| `synthetic-nature/src/themes/homepage/HomepageAnimeSky.tsx` | DPR capped to 1.25 |
| `synthetic-nature/src/components/ui/webgl-orb.tsx` | DPR capped to 1.25 |
| `synthetic-nature/src/index.css` | Liquid glass panel CSS with saturate boost |

## Commits

| Hash | Message |
|------|---------|
| `67affaa` | fix: add `filter=conversational` to HF Hub API query |
| `ec7e717` | fix: use HF Hub `inference=warm` filter; switch to OpenAI-compat chat completions endpoint |
| `6138d92` | feat: mark all HF models free ($0.00) |
| `527a1b8` | feat: implement HF Serverless Inference API integration and theme optimizations |
