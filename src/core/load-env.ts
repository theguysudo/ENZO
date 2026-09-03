/**
 * load-env.ts — copy the repo-root .env into process.env.
 *
 * Nothing else did this. There is no dotenv dependency and no --env-file flag in
 * package.json or ecosystem.config.cjs, so every process.env read fell through to
 * whatever PM2 happened to export. That silently disabled Google OAuth in prod:
 * GOOGLE_CLIENT_ID/SECRET and JWT_SECRET live only in .env, so GOOGLE_AUTH_READY
 * was always false and /api/auth/google returned "not configured on this server".
 *
 * MUST be the first import in index.ts. ESM evaluates imports in order and some
 * modules read process.env at module scope (src/projects/project-runtime.ts:71),
 * so anything imported above this line sees an unpopulated env.
 *
 * ponytail: reuses readEnvFile() rather than a second parser, and the real
 * environment wins over the file — same precedence as `node --env-file`, so
 * ecosystem.config.cjs env_production still overrides .env as its comment claims.
 */
import { readEnvFile } from './env-manager.js';

for (const [key, value] of Object.entries(readEnvFile())) {
  if (process.env[key] === undefined) process.env[key] = value;
}
