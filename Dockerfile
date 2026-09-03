# ─────────────────────────────────────────────────────────────────────────────
# ENZO — self-hosted docker image
#
# Two variants of the same image, chosen at build time:
#   --build-arg THEME_VARIANT=lite  (default) → no theme videos (image
#       downloads ~150MB compressed). Homepage: Nebula drift (pure WebGL).
#       Workspace/terminal: Default Particles (pure three.js). Both need
#       zero video files.
#   --build-arg THEME_VARIANT=full  → all 23 theme videos (~470MB compressed),
#       every homepage + workspace theme, exactly like the hosted deployment.
#
# Google identity login is removed in this variant in ALL builds
# (ENZO_GOOGLE_AUTH=0 / VITE_GOOGLE_AUTH=0): login is provider-key onboarding
# (OpenRouter / NVIDIA / Google AI Studio / HuggingFace / Cloudflare — BYOK).
#
# node:22-slim, not alpine: better-sqlite3 ships glibc prebuilds and would
# otherwise compile from source against musl on every build.
#
# The container runs as the unprivileged `node` user. Every path the backend
# writes at runtime lives under /app (model caches in src/models/, agent
# memory in src/core/memory-store.json, generated projects, learned skills),
# and /app is node-owned from the first layer — no root anywhere.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build the frontend with the variant flags ───────────────────────
FROM node:22-slim AS frontend-build
WORKDIR /build/synthetic-nature

ARG THEME_VARIANT=lite

# Copy only the manifests first so `npm ci` layer-caches independently of source edits.
COPY synthetic-nature/package.json synthetic-nature/package-lock.json ./
RUN npm ci

COPY synthetic-nature/ ./
# The lite image ships no video files at all — delete them BEFORE the build so
# vite's copy of public/ → dist/ stays small too.
RUN if [ "$THEME_VARIANT" = "lite" ]; then find public/background_elements -name '*.mp4' -delete; fi
# VITE_* flags are statically replaced at build time (see src/lib/variant.ts):
# GOOGLE_AUTH=false dead-code-eliminates the Google login branch entirely.
RUN VITE_GOOGLE_AUTH=0 VITE_THEME_VARIANT=$THEME_VARIANT npm run build


# ── Stage 2: runtime — backend + built frontend ──────────────────────────────
FROM node:22-slim AS runtime
# /app is created node-owned; every file that lands in it arrives via
# --chown, so the runtime can write its caches without a fat chown layer.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

ENV NODE_ENV=production \
    ENZO_GOOGLE_AUTH=0 \
    PORT=5001

# Backend deps first (layer-cache). --include=dev: tsx (the runtime) and
# typescript live in devDependencies.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

# Runtime sources. tsx resolves the `src/*` imports through tsconfig.json paths.
COPY --chown=node:node index.ts tsconfig.json ./
COPY --chown=node:node src/ ./src/
# Boot-required skill library (loaded from ../../skills-bundled at startup).
COPY --chown=node:node skills-bundled/ ./skills-bundled/

# Built frontend from stage 1 — one origin serves UI + /api, no CORS needed.
COPY --from=frontend-build --chown=node:node /build/synthetic-nature/dist ./synthetic-nature/dist

# Empty seeds for the writable state. Agent memory lives in /app/data (the
# only compose-mounted dir for it — named volumes can't mount a single file),
# with the path the backend expects left as a symlink; `src/models/` ships its
# tracked seed JSONs via COPY above and is rewritten in place at runtime.
RUN mkdir -p data generated-projects src/skills/skills \
 && echo '{ "entries": [] }' > data/memory-store.json \
 && ln -s /app/data/memory-store.json src/core/memory-store.json

EXPOSE 5001

# node:22-slim has no curl/wget — probe with what the image already has.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/tsx", "index.ts"]
