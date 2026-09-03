# ENZO Backend - Change Log (2026-06-29)

## Summary of Changes

### Issues Fixed
1. **HuggingFace Image Models** - Previously marked as free but require Pro subscription or dedicated endpoints
2. **Onboarding Simplification** - HF key now optional; Pollinations provides free image generation
3. **Model-Based Tab Switching** - Auto-switches to text/image tab based on model selection
4. **NVIDIA Integration** - Added NVIDIA Builder API support with free credits tier
5. **Model Count Auto-Refresh** - Live count in Hero3D and 10-minute auto-refresh in ModelGrid
6. **Terminal Text Models** - Fixed auth to allow free model access without user key setup

---

## Detailed Changes

### 1. model-sync.ts
- Added `NVIDIA` to `CatalogModel` provider union type
- Added `fetchNvidiaModels()` function returning curated Nemotron models
- Updated Pollinations models to only include verified working models:
  - `flux` - photorealistic (free)
  - `zimage` - good prompt adherence (free)
  - `kontext` - context-aware (free)
  - `klein` - img2img editing (free)
- Changed all HF image models to `free: false` with pricing "Requires HF Pro or Dedicated Endpoint"
- Updated sync to include NVIDIA models in merged catalog

### 2. tunnel.ts
- Added `nvidia` to `PROVIDER_KEYS` object
- Added NVIDIA endpoint to `PROVIDER_ENDPOINTS` (`https://integrate.api.nvidia.com/v1/chat/completions`)
- Added `nvidia/` prefix routing in `parseModelRoute()`
- Added `x-nvidia-key` header extraction for user-provided keys

### 3. index.ts
- Added NVIDIA endpoint support
- Created `verifyMasterKeyOptional` middleware for free model access
- Added `IMAGE_MODELS = ['flux', 'zimage', 'kontext']`
- Added `IMAGE_EDIT_MODELS = ['klein']`
- System master key serves as fallback for free models

### 4. chat.tsx (frontend2)
- Added `nvidiaKey` state and sync on window focus
- Added NVIDIA key to transport headers
- Auto-switch tabs: HF/Pollinations models → image tab, text models → text tab
- Added uncensored mode banner: "Requires HF Pro token"
- Updated fallback models for image studio

### 5. onboarding.tsx
- Changed validation to only require OpenRouter key
- Added NVIDIA API key state and localStorage handling
- Updated UI text to clarify optional services

### 6. models.ts
- Added `NVIDIA` to Provider type
- Updated model recommendations to current working models (flux instead of flux-1.1-pro)

### 7. ModelGrid.tsx
- Added "NVIDIA" to providers list
- Added 10-minute auto-refresh (`MODEL_REFRESH_INTERVAL = 10 * 60 * 1000`)

### 8. Hero3D.tsx
- Added live model count fetching from `/api/v1/models`
- Added NVIDIA to satellite provider labels (now 4 providers)

### 9. NVIDIA NIM UI Integration
- Created `/settings-nvidia` page for entering NVIDIA API key
- Direct link button to `https://build.nvidia.com` for key signup
- Added NVIDIA key to onboarding as optional third connector
- Added chat history page at `/chat-history`
- Added "History" button in terminal header for saved conversations

### 10. Python Worker Scripts (docs/HF_MODEL_SYNC_README.md)
- `hf-model-sync.py` - Continuous daemon with daily scheduler
- `hf-model-sync-onetime.py` - One-shot script for cron integration

### 11. Sign-Out 404 Fix (2026-06-30)
- **Root cause:** `TopBar.tsx` `signOut()` used TanStack `navigate({ to: "/" })`,
  a client-side SPA navigation. But `/` is owned by the Express backend (cinematic
  homepage), not the frontend2 SPA — so the router rendered the 404 page.
- **Fix in `components/enzo/TopBar.tsx`:**
  - Changed sign-out to `window.location.href = "/"` (full browser redirect → Express
    serves the cinematic homepage)
  - Removed now-unused `useNavigate` import and `navigate` variable
- **Created `routes/index.tsx`:** fallback SPA index route so any stray client-side
  `<Link to="/">` resolves to a valid page instead of 404
- **Verified:** `/`, `/marketplace`, `/chat` all return HTTP 200; homepage serves
  "ENZO — The Intelligence Hub" cinematic page

### 12. Text Models in Terminal Fix (2026-06-29)
- **Root cause:** `/api/chat` required a master key via `verifyMasterKey`, but users
  without a saved key got "Unauthorized: Missing Authorization header"
- **Fix in `index.ts`:** added `verifyMasterKeyOptional` middleware — allows anonymous
  requests to use server-side keys for free models
- **Fix in `chat.tsx`:** system master key (`enzo-master-key-local-dev-2026`) used as
  fallback when no user key is set

### 13. Hero3D Homepage Stats (2026-06-30)
- Fixed broken JSX structure (duplicated component body from prior edit)
- Live model count fetched from `/api/v1/models` (replaces hardcoded "12+")
- Added NVIDIA as 5th satellite provider label; updated provider count to "4"

---

## Model Catalog Status

| Provider | Count | Free Models | Notes |
|----------|-------|-------------|-------|
| OpenRouter | ~700 | Many | Free tier available with credit card |
| Groq | ~20 | All | Free via server key |
| Pollinations | 5 | 5 | Fully free anonymous access |
| HuggingFace | 7 text | Some | Free tier limited; image models require Pro |
| NVIDIA | 2 | 2 | Free credits via Builder Program (up to 5000) |

**Total Models: 710**
**Uncensored Models: 265**

---

## API Endpoints

### Working Free Models (No Key Required)
- `POST /api/image/generate` - Pollinations (flux, zimage, kontext)
- `POST /api/v1/chat/completions` with Groq models via master key fallback
- `GET /api/v1/models` - Live catalog

### User-Provided Key Endpoints
- `x-openrouter-key` - OpenRouter API key
- `x-huggingface-key` - HuggingFace token  
- `x-nvidia-key` - NVIDIA API key (for Nemotron models)

---

## Next Steps
1. ✅ Build frontend2 to apply changes (done — builds clean, servers running on 5001/5002)
2. Test NVIDIA model integration end-to-end with a real user API key
3. Fetch full NVIDIA NIM free-model catalog dynamically (currently 2 curated Nemotron entries)
4. Verify `/settings-nvidia` key entry → chat routing works in browser
5. Consider NVIDIA OAuth for builder-program credit redemption (currently manual key paste)

---

## How to Run / Restart

```bash
# Kill any stale processes, then start both servers (Express 5001 + Nitro 5002)
pkill -f "tsx.*index.ts"; pkill -f "frontend2/.output"; sleep 2
cd /Users/aditya/backend && npm start

# Rebuild frontend2 after editing files under frontend2/src/
cd /Users/aditya/backend/frontend2 && npm run build
# then restart the backend so the new .output build is served

# Manually refresh the model catalog
curl -X POST http://localhost:5001/api/v1/sync \
  -H 'Authorization: Bearer enzo-master-key-local-dev-2026'
```

**Important:** Frontend2 is a *built* Nitro SSR app. Editing files in `frontend2/src/`
has NO effect until you run `npm run build` in `frontend2/` AND restart the backend.