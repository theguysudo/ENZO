/**
 * Build-time variant switches for the two distributions of this frontend.
 *
 * ENZO ships in two editions from this one codebase:
 *
 *   hosted  — enzo-hub.duckdns.org (and local dev). Everything on: Google
 *             identity login, all 13 homepage + 10 marketplace themes.
 *   docker  — the self-hosted image. Google identity OAuth is removed
 *             (login is provider-key onboarding instead — the app has never
 *             verified identity server-side, only the provider keys), and
 *             the `lite` image trims the theme registries: Nebula drift
 *             (pure WebGL, zero videos) on the homepage, and Default
 *             Particles (pure three.js) + the NYC subway ride + the
 *             Bioluminescent Ocean clip in the workspace — the two mp4s
 *             `enzo:lite` ships, instead of the ~292MB set.
 *
 * Both flags are set by the Dockerfile (VITE_GOOGLE_AUTH=0,
 * VITE_THEME_VARIANT=lite) and are absent on the hosted server, so the
 * hosted build is byte-for-byte today's behavior. Vite statically replaces
 * import.meta.env.VITE_* at build time, which dead-code-eliminates the
 * disabled branch — the docker bundle contains no Google login code at all.
 */

export const GOOGLE_AUTH: boolean = import.meta.env.VITE_GOOGLE_AUTH !== '0'

export const IS_LITE: boolean = import.meta.env.VITE_THEME_VARIANT === 'lite'
