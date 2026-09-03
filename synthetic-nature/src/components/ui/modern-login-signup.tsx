// ─── ModernLoginSignup — Vercel-style auth surface with a WebGL dot grid ─────
//
// Two exports:
//   • DotGridBackground — the standalone canvas layer (shader dots + center
//     vignette). Reused by OnboardingView so the look carries from the Google
//     signup step through every API-setup step.
//   • ModernLoginSignup (default) — the signup/sign-in card itself.
//
// Adapted from the original paste for this codebase:
//   • three.js is a first-class dependency here (see ui/liquid-shader.tsx), so
//     the CDN <script> loader is gone — a direct import cannot fail at runtime
//     and ships no r128 global.
//   • The render loop follows the app's graphics budget: pixel ratio capped at
//     1.5, ~30fps frame gate, suspended in hidden tabs, low-power GPU hint,
//     full dispose on unmount.
//   • Only the Google button is wired — the console's backend supports a
//     single OAuth entry point (/api/auth/google), and dead GitHub/Apple/email
//     controls would be UI that lies. The sign-in/sign-up toggle only swaps
//     copy; both paths go through the same Google flow.

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { motion } from 'framer-motion'

// ─── DotGridBackground ────────────────────────────────────────────────────────

export function DotGridBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false, // full-screen quad — MSAA buys nothing here
      powerPreference: 'low-power', // never wake the discrete GPU for dots
    })
    // Same budget rule as the rest of the app's backgrounds: retina DPR is
    // 4× the fragment work and the dots don't get sharper for it.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(window.innerWidth, window.innerHeight)

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    const uniforms = {
      u_time: { value: 0 },
      u_resolution: { value: new THREE.Vector2(window.innerWidth * 2, window.innerHeight * 2) },
      u_opacities: { value: [0.3, 0.3, 0.3, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 1.0] },
      u_colors: {
        value: [
          new THREE.Vector3(1, 1, 1),
          new THREE.Vector3(1, 1, 1),
          new THREE.Vector3(1, 1, 1),
          new THREE.Vector3(1, 1, 1),
          new THREE.Vector3(1, 1, 1),
          new THREE.Vector3(1, 1, 1),
        ],
      },
      u_total_size: { value: 20.0 },
      u_dot_size: { value: 6.0 },
      u_reverse: { value: 0 },
    }

    const material = new THREE.ShaderMaterial({
      vertexShader: `
        precision mediump float;
        uniform vec2 u_resolution;
        out vec2 fragCoord;
        void main() {
          gl_Position = vec4(position, 1.0);
          fragCoord = (position.xy + 1.0) * 0.5 * u_resolution;
          fragCoord.y = u_resolution.y - fragCoord.y;
        }
      `,
      fragmentShader: `
        precision mediump float;
        in vec2 fragCoord;

        uniform float u_time;
        uniform float u_opacities[10];
        uniform vec3 u_colors[6];
        uniform float u_total_size;
        uniform float u_dot_size;
        uniform vec2 u_resolution;
        uniform int u_reverse;

        out vec4 fragColor;

        float PHI = 1.61803398874989484820459;
        float random(vec2 xy) {
            return fract(tan(distance(xy * PHI, xy) * 0.5) * xy.x);
        }

        void main() {
            vec2 st = fragCoord.xy;
            st.x -= abs(floor((mod(u_resolution.x, u_total_size) - u_dot_size) * 0.5));
            st.y -= abs(floor((mod(u_resolution.y, u_total_size) - u_dot_size) * 0.5));

            float opacity = step(0.0, st.x) * step(0.0, st.y);

            vec2 st2 = vec2(int(st.x / u_total_size), int(st.y / u_total_size));

            float frequency = 5.0;
            float show_offset = random(st2);
            float rand = random(st2 * floor((u_time / frequency) + show_offset + frequency));
            opacity *= u_opacities[int(rand * 10.0)];
            opacity *= 1.0 - step(u_dot_size / u_total_size, fract(st.x / u_total_size));
            opacity *= 1.0 - step(u_dot_size / u_total_size, fract(st.y / u_total_size));

            vec3 color = u_colors[int(show_offset * 6.0)];

            float animation_speed_factor = 3.0;
            vec2 center_grid = u_resolution / 2.0 / u_total_size;
            float dist_from_center = distance(center_grid, st2);

            float timing_offset_intro = dist_from_center * 0.01 + (random(st2) * 0.15);

            float current_timing_offset = timing_offset_intro;
            opacity *= step(current_timing_offset, u_time * animation_speed_factor);
            opacity *= clamp((1.0 - step(current_timing_offset + 0.1, u_time * animation_speed_factor)) * 1.25, 1.0, 1.25);

            fragColor = vec4(color, opacity);
            fragColor.rgb *= fragColor.a;
        }
      `,
      uniforms,
      glslVersion: THREE.GLSL3,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneFactor,
      transparent: true,
    })

    const geometry = new THREE.PlaneGeometry(2, 2)
    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)

    // ~30fps frame gate + hidden-tab suspension — same graphics budget as
    // every other background in the app. The reveal reads the same at 30fps
    // because the dots twinkle on 5-second periods.
    let paused = document.hidden
    let rafId = 0
    let lastDraw = 0
    const startTime = performance.now()

    const render = () => {
      if (paused) { rafId = 0; return }
      rafId = requestAnimationFrame(render)
      const now = performance.now()
      if (now - lastDraw < 33) return
      lastDraw = now
      uniforms.u_time.value = (now - startTime) / 1000
      renderer.render(scene, camera)
    }
    rafId = requestAnimationFrame(render)

    const onVisibility = () => {
      const wasPaused = paused
      paused = document.hidden
      if (wasPaused && !paused && !rafId) rafId = requestAnimationFrame(render)
    }
    document.addEventListener('visibilitychange', onVisibility)

    const handleResize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight)
      uniforms.u_resolution.value.set(window.innerWidth * 2, window.innerHeight * 2)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', handleResize)
      cancelAnimationFrame(rafId)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      mesh.remove()
    }
  }, [])

  return (
    <div className="absolute inset-0 overflow-hidden bg-black" aria-hidden="true">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* Center vignette — dims the dots toward the middle so the card owns the focus. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(circle at center, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 100%)',
        }}
      />
    </div>
  )
}

// ─── Google mark ──────────────────────────────────────────────────────────────

const GoogleIcon = (
  <svg viewBox="0 0 24 24" style={{ width: 16, height: 16, flexShrink: 0 }}>
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
)

// ─── ModernLoginSignup ────────────────────────────────────────────────────────

export default function ModernLoginSignup({
  onGoogle,
  onBack,
}: {
  onGoogle: () => void
  onBack?: () => void
}) {
  const [isLogin, setIsLogin] = useState(false)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black text-white"
    >
      <DotGridBackground />

      {/* Modal card */}
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 12, opacity: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 flex w-full max-w-[400px] flex-col items-center rounded-xl border border-[#222] bg-[#121212] p-8 shadow-[0_10px_40px_rgba(0,0,0,0.8)]"
      >
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Close"
            className="absolute right-4 top-3.5 text-sm text-white/35 transition-colors hover:text-white"
          >
            ✕
          </button>
        )}

        <div
          className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-[#333] bg-[#111] font-bold"
          style={{ fontSize: '1.05rem' }}
        >
          E
        </div>

        {isLogin ? (
          <>
            <h1 className="mb-1 text-[1.35rem] font-semibold tracking-[-0.025em]">Welcome back</h1>
            <p className="mb-5 text-[0.85rem] leading-relaxed text-[#888]">
              Sign in to your Enzo console.
            </p>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-[1.35rem] font-semibold tracking-[-0.025em]">Create your account</h1>
            <p className="mb-5 text-[0.85rem] leading-relaxed text-[#888]">
              One sign-in unlocks every model in the hub.
            </p>
          </>
        )}

        <button
          onClick={onGoogle}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-[#ededed] px-4 py-2.5 text-[0.875rem] font-medium text-black transition-transform hover:scale-[1.01] active:scale-[0.99]"
        >
          {GoogleIcon}
          {isLogin ? 'Continue with Google' : 'Sign up with Google'}
        </button>

        <div className="mt-5 text-[0.875rem] text-[#888]">
          {isLogin ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={() => setIsLogin((v) => !v)}
            className="cursor-pointer bg-none p-0 font-medium text-white"
            style={{ border: 'none', fontSize: 'inherit' }}
          >
            {isLogin ? 'Sign Up' : 'Sign In'}
          </button>
        </div>

        <div className="mt-3.5 text-center text-[0.75rem] leading-relaxed text-[#666]">
          By proceeding, you agree to the Enzo console{' '}
          <span className="text-[#888]">Terms of Service</span> and{' '}
          <span className="text-[#888]">Privacy Policy</span>. Your provider keys
          never leave this browser.
        </div>
      </motion.div>
    </motion.div>
  )
}
