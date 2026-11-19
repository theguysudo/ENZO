# ─────────────────────────────────────────────────────────────────────────────
# ENZO — self-hosted docker image
#
# Two variants of the same image, chosen at build time:
#   --build-arg THEME_VARIANT=lite  (default) → one theme video: the 3.3MB
#       AI-animated NYC subway ride loop (see marketplace/CREDITS.md) — the
#       one Marketplace workspace theme the lite registry carries beyond the
#       WebGL default. Homepage = Nebula drift (pure WebGL). Image stays
#       ~150MB compressed.
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

# The vite build reads the release version from the repo-root package.json
# (vite.config's __ENZO_VERSION__ define feeds the update banner).
COPY package.json /build/package.json

COPY synthetic-nature/ ./
# The lite image keeps exactly one theme video — the 3.3MB AI-animated NYC
# subway loop — by name (a size cutoff keeps every small file, and the
# homepage/ carries a 1MB _reversed orphan whose forward partner is deleted,
# so a pull would ship a second, unreachable video). Everything else is
# deleted BEFORE the build so vite's copy of public/ → dist/ stays small too.
RUN if [ "$THEME_VARIANT" = "lite" ]; then \
      find public/background_elements -name '*.mp4' \
        ! -name 'Subway_doors_and_tunnel_view_202609111948_gwr_loop.mp4' \
        ! -name 'Bioluminescent_ocean.mp4' -delete; \
    fi
# VITE_* flags are statically replaced at build time (see src/lib/variant.ts):
# GOOGLE_AUTH=false dead-code-eliminates the Google login branch entirely.
RUN VITE_GOOGLE_AUTH=0 VITE_THEME_VARIANT=$THEME_VARIANT npm run build


# ── Stage 2: runtime — backend + built frontend ──────────────────────────────
FROM node:22-slim AS runtime
# /app is created node-owned; every file that lands in it arrives via
# --chown, so the runtime can write its caches without a fat chown layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app \
 && chown node:node /app
WORKDIR /app
USER node

ENV NODE_ENV=production \
    ENZO_GOOGLE_AUTH=0 \
    ENZO_SELF_HOSTED=1 \
    ENZO_DATA_DIR=/app/data \
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
# vault-boot.ts also writes here: the instance master key (vault-boot.json,
# 0o600) and sealed claimed provider keys (vault-keys.json) — generated on
# first boot, persisted in the enzo-memory volume, never baked into the image.
# src/intelligence/data + src/neural-engine/data are pre-created node-owned so
# a named volume mounted there inherits that ownership — if Docker creates the
# mountpoint itself, it comes up root-owned and every write EACCESses.
RUN mkdir -p data generated-projects src/skills/skills src/intelligence/data src/neural-engine/data \
 && echo '{ "entries": [] }' > data/memory-store.json \
 && ln -s /app/data/memory-store.json src/core/memory-store.json

# Entrypoint — auto dependencies install mode. On every start it verifies the
# baked node_modules and installs whatever is missing before the server boots
# (first boot, partial bake, empty mounted volume all heal). chmod in a layer,
# not the source mode: a Windows checkout of a public clone loses the exec
# bit, and a non-executable entrypoint would kill the container before boot.
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 5001

# node:22-slim has no curl/wget — probe with what the image already has.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["./node_modules/.bin/tsx", "index.ts"]
