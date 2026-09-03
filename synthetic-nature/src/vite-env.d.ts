/// <reference types="vite/client" />

// Build-time config injected by Vite. Only variables prefixed VITE_ are exposed
// to the browser bundle, which is why every name here is a *public* value —
// never put a secret in one.
interface ImportMetaEnv {
  /**
   * Public client id of a HuggingFace OAuth app. Optional: when it is absent the
   * HuggingFace step falls back to pasting a token, which is the path that needs
   * no app at all. Its matching secret is server-side only (HF_CLIENT_SECRET).
   */
  readonly VITE_HF_CLIENT_ID?: string

  /**
   * '0' disables Google identity login in the docker variant's build. Absent
   * (or any other value) on the hosted server. See src/lib/variant.ts.
   */
  readonly VITE_GOOGLE_AUTH?: string

  /**
   * 'lite' trims the theme registries to their zero-video first entries for
   * the small docker image; absent on the hosted server. See src/lib/variant.ts.
   */
  readonly VITE_THEME_VARIANT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
