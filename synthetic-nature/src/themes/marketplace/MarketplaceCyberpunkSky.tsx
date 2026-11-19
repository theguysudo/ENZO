/**
 * MarketplaceCyberpunkSky — Cyberpunk video & WebGL background for Marketplace themes
 * Includes micro-microsecond pre-warmed dual-texture WebGL blend for 100% infinite seamless video looping.
 */

import { useEffect, useRef, useState } from 'react'

import type { MarketplaceCyberpunkScene } from './types'

interface SceneSources {
  forward: string
  reversed: string
  isSeamlessLoop?: boolean
  // Real-footage scenes play at native speed; the anime loops are slowed
  // (PLAYBACK_RATE) to stretch their loop. Per-scene override, default 0.6.
  playbackRate?: number
  // Adds a continuous handheld camera tremble (position + micro-rotation
  // noise) to the shader — for real-footage scenes that should feel like a
  // phone recording rather than a floating synthetic camera.
  tremble?: boolean
  // Unsplash-style grade (see subway scene): contrast curve + glass-lift +
  // bottom vignette, pushing real footage toward the moody photo look.
  graded?: boolean
  // Overlays a faint ambient dot-field wave (sparse monochrome dot grid +
  // slow diagonal brightness wave, time-driven, decoupled from audio).
  // Subway only — the anime loops are already stylised.
  pixelWave?: boolean
}

const MARKETPLACE_CYBERPUNK_VIDEOS: Record<MarketplaceCyberpunkScene, SceneSources> = {
  // Seated interior POV of an NYC subway ride — the door, seats and tunnel
  // view in frame, 1080p. AI-animated from Juan Giraudo's Unsplash photo
  // "train door" (J7zytkieZBs) in his exact composition; cut to an 8.7s
  // crossfade-seamless loop. See background_elements/marketplace/CREDITS.md.
  nyc_subway: {
    forward: '/background_elements/marketplace/Subway_doors_and_tunnel_view_202609111948_gwr_loop.mp4',
    reversed: '/background_elements/marketplace/Subway_doors_and_tunnel_view_202609111948_gwr_loop.mp4',
    isSeamlessLoop: true,
    playbackRate: 1.0,
    tremble: true,
    graded: true,
    pixelWave: true,
  },
  // Bioluminescent ocean — real footage of glowing water flowing. The clip
  // starts and ends on the same frame, so it plays as a native loop (no
  // reversed companion, no ping-pong). NO `graded` here: that grade is the
  // subway's monochrome Unsplash look, and this one keeps its colours.
  // The clip carries a baked 1.5s fade-in / 1.5s fade-out, so the loop point
  // is black → black and the cut is invisible. `?v=3` busts the 30-day
  // immutable cache that /background_elements is served with, so browsers
  // that already fetched an earlier build of this clip pick this one up.
  bioluminescent_ocean: {
    forward: '/background_elements/marketplace/Bioluminescent_ocean.mp4?v=3',
    reversed: '/background_elements/marketplace/Bioluminescent_ocean.mp4?v=3',
    isSeamlessLoop: true,
    playbackRate: 1.0,
  },
  rooftop: {
    forward: '/background_elements/marketplace/Anime_cyberpunk_rooftop_dojo_20260719.mp4',
    reversed: '/background_elements/marketplace/Anime_cyberpunk_rooftop_dojo_20260719.mp4',
    isSeamlessLoop: true,
  },
  boulevard: {
    forward: '/background_elements/marketplace/Anime_cyberpunk_boulevard_20260719.mp4',
    reversed: '/background_elements/marketplace/Anime_cyberpunk_boulevard_20260719.mp4',
    isSeamlessLoop: true,
  },
  ink_rain: {
    forward: '/background_elements/marketplace/Anime_cyberpunk_ink_rain_20260719.mp4',
    reversed: '/background_elements/marketplace/Anime_cyberpunk_ink_rain_20260719.mp4',
    isSeamlessLoop: true,
  },
  space_station: {
    forward: '/background_elements/marketplace/Anime_cyberpunk_space_station_20260719.mp4',
    reversed: '/background_elements/marketplace/Anime_cyberpunk_space_station_20260719.mp4',
    isSeamlessLoop: true,
  },
  purple_flowers: {
    forward: '/background_elements/marketplace/Robotic_figure_in_purple_flowers_202608021811.mp4',
    reversed: '/background_elements/marketplace/Robotic_figure_in_purple_flowers_202608021811.mp4',
    isSeamlessLoop: true,
  },
  milky_way: {
    forward: '/background_elements/marketplace/Cabin_under_Milky_Way_timelapse_202608012158.mp4',
    reversed: '/background_elements/marketplace/Cabin_under_Milky_Way_timelapse_202608012158.mp4',
    isSeamlessLoop: true,
  },
  alien: {
    forward: '/background_elements/marketplace/Human_viewing_alien_communicatio…_1080p_202608170106_gwr_video_mvp.mp4',
    reversed: '/background_elements/marketplace/Human_viewing_alien_communicatio…_1080p_202608170106_gwr_video_mvp.mp4',
    isSeamlessLoop: true,
  },
  rocket: {
    forward: '/background_elements/marketplace/Rocket_video_seamless_loop_requi…_202608170105_gwr_video_mvp.mp4',
    reversed: '/background_elements/marketplace/Rocket_video_seamless_loop_requi…_202608170105_gwr_video_mvp.mp4',
    isSeamlessLoop: true,
  },
  space_probe: {
    forward: '/background_elements/marketplace/Space_probe_drifting_above_planet_202608170018_gwr_video_mvp.mp4',
    reversed: '/background_elements/marketplace/Space_probe_drifting_above_planet_202608170018_gwr_video_mvp.mp4',
    isSeamlessLoop: true,
  },
  coding_deck: {
    forward: '/background_elements/marketplace/coding-deck-moewalls-com.mp4',
    reversed: '/background_elements/marketplace/coding-deck-moewalls-com.mp4',
    isSeamlessLoop: true,
  },
}

const MAX_RIPPLES = 12
const PLAYBACK_RATE = 0.6
const PREWARM_LEAD_TIME = 0.6 // Start incoming video decoder 600ms early so frames are hot
const CROSSFADE_WINDOW  = 0.08 // Micro-microsecond blend window (80ms)

const VERT = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

const FRAG = `
precision highp float;

uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uCrossfade; // 0.0 = 100% TexA, 1.0 = 100% TexB
uniform vec2  uResolution;
uniform vec2  uMouse;
uniform float uMouseActive;
uniform float uTime;
uniform float uVideoAspect;
uniform float uTremble; // 0 = static camera, 1 = handheld phone-recording tremble
uniform float uGrade;   // 0 = raw footage, 1 = Unsplash-style monochrome grade
uniform float uWave;    // 0 = off, 1 = ambient dot-field wave overlay
uniform vec3  uRipples[${MAX_RIPPLES}];
uniform float uRippleCount;

// Two-octave value noise for the handheld drift — smooth, never repeats.
float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(float t) {
  float i = floor(t);
  float f = fract(t);
  float a = hash(vec2(i, 1.7));
  float b = hash(vec2(i + 1.0, 1.7));
  float u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 disp = vec2(0.0);

  // Handheld camera tremble: slow drift (body sway) + fast jitter (train
  // rattle) on both axes, plus a micro-rotation. Amplitudes are tiny —
  // this is a steady hand on a rattling train, not an earthquake.
  if (uTremble > 0.5) {
    float t = uTime;
    float swayX = (vnoise(t * 0.35) - 0.5) * 0.007;
    float swayY = (vnoise(t * 0.41 + 50.0) - 0.5) * 0.006;
    float jitterX = (vnoise(t * 7.3 + 20.0) - 0.5) * 0.0035;
    float jitterY = (vnoise(t * 6.7 + 80.0) - 0.5) * 0.0035;
    float rot = (vnoise(t * 0.5 + 130.0) - 0.5) * 0.006;
    vec2 c = uv - 0.5;
    mat2 R = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
    vec2 shook = R * c + 0.5 + vec2(swayX + jitterX, swayY + jitterY);
    uv = mix(uv, shook, uTremble);
  }

  if (uMouseActive > 0.5) {
    float dm = distance(uv, uMouse);
    float wave = sin(dm * 38.0 - uTime * 4.5) * exp(-dm * 9.0);
    vec2 dir = normalize(uv - uMouse + 1e-5);
    disp += dir * wave * 0.006;
  }

  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    if (float(i) >= uRippleCount) break;
    vec3 r = uRipples[i];
    float age = r.z;
    float d = distance(uv, r.xy);
    float radius = age * 0.55;
    float ring = d - radius;
    float wave = sin(ring * 46.0) * exp(-abs(ring) * 16.0) * exp(-age * 2.6);
    vec2 rd = normalize(uv - r.xy + 1e-5);
    disp += rd * wave * 0.035;
  }

  float ca = uResolution.x / uResolution.y;
  vec2 s = vec2(1.0);
  if (ca > uVideoAspect) {
    s.y = uVideoAspect / ca;
  } else {
    s.x = ca / uVideoAspect;
  }

  vec2 texUv = (uv - 0.5) * s + 0.5 + disp;

  vec4 colA = texture2D(uTexA, texUv);
  vec4 colB = texture2D(uTexB, texUv);

  // Micro-microsecond Hermite smoothstep blend for invisible infinite video loop
  float blend = smoothstep(0.0, 1.0, clamp(uCrossfade, 0.0, 1.0));
  vec3 col = mix(colA.rgb, colB.rgb, blend);

  // Unsplash-style grade for real footage: neutral, two-tone, moody.
  // Contrast pivot at 0.36 pushes the dark interior toward deep shadow while
  // the glass-lift term keeps bright panes from clipping; bottom vignette
  // deepens the seated-camera look; animated grain adds recording texture.
  if (uGrade > 0.5) {
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    l = clamp((l - 0.36) * 1.16 + 0.36, 0.0, 1.0);
    l += smoothstep(0.75, 1.0, l) * 0.05; // glass-lift
    vec2 suv = gl_FragCoord.xy / uResolution;
    l *= mix(0.72, 1.0, smoothstep(0.0, 0.42, suv.y)); // bottom vignette
    float g = fract(sin(dot(gl_FragCoord.xy + vec2(uTime * 71.0, uTime * 53.0), vec2(12.9898, 78.233))) * 43758.5453);
    l += (g - 0.5) * 0.045; // recording grain
    col = vec3(clamp(l, 0.0, 1.0));
  }

  // Ambient dot-field wave — sparse device-px dot grid, slow diagonal
  // brightness wave, decoupled from audio. Subway only. (GLSL builtin dot()
  // is a function, so the per-dot mask is named dv.)
  if (uWave > 0.5) {
    float sp = 26.0;                               // dot spacing, device px
    vec2 g = fract(gl_FragCoord.xy / sp) - 0.5;
    float dv = 1.0 - smoothstep(0.14, 0.26, length(g));
    vec2 gp = gl_FragCoord.xy / uResolution;
    float w = 0.5 + 0.5 * sin((gp.x + gp.y) * 9.0 - uTime * 0.6);
    col += dv * w * 0.05;                          // faint, additive white
  }

  gl_FragColor = vec4(col, 1.0);
}
`

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('shader error:', gl.getShaderInfoLog(shader))
  }
  return shader
}

export function MarketplaceCyberpunkSky({ scene }: { scene: MarketplaceCyberpunkScene }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [activeBuffer, setActiveBuffer] = useState<'A' | 'B'>('A')
  const activeBufferRef = useRef<'A' | 'B'>('A')
  activeBufferRef.current = activeBuffer

  const crossfadeRef = useRef<number>(0) // 0 = Buffer A, 1 = Buffer B

  // The render loop below is the only rAF loop left in this component; it
  // reads the scene through a ref so it survives theme switches without
  // re-subscribing (and without holding a stale closure over `scene`).
  const sceneRef = useRef(scene)
  sceneRef.current = scene

  const videoRefA = useRef<HTMLVideoElement>(null)
  const videoRefB = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const vidA = videoRefA.current
    const vidB = videoRefB.current
    const config = MARKETPLACE_CYBERPUNK_VIDEOS[scene]
    // Real footage (nyc_subway) runs at 1.0; the synthetic anime loops are
    // slowed to stretch their 10–20s sources. Per-scene, 0.6 by default.
    const rate = config.playbackRate ?? PLAYBACK_RATE
    if (vidA && vidB) {
      vidA.src = config.forward
      vidA.load()
      vidA.currentTime = 0.01
      vidA.playbackRate = rate
      if (config.isSeamlessLoop) {
        vidA.loop = true
        // Native loops never crossfade, so the second decoder is never read.
        // Drop its source rather than keeping a paused <video> with a full
        // decode pipeline (and one texture upload) alive for nothing.
        vidB.removeAttribute('src')
        vidB.load()
      } else {
        vidB.src = config.reversed
        vidB.load()
        vidB.currentTime = 0.01
        vidB.playbackRate = rate
        vidA.loop = false
        vidB.loop = false
      }
      vidA.play().catch(() => {})
      vidB.pause()
      setActiveBuffer('A')
      crossfadeRef.current = 0
    }
  }, [scene])

  // NOTE: the old dedicated rAF watcher loop is gone — pre-warm/crossfade
  // management now lives inside the render loop below (a few comparisons per
  // frame), and native seamless loops skip it entirely.

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // ponytail: RM sampled once at mount; a runtime toggle needs a reload.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const gl = canvas.getContext('webgl', {
      premultipliedAlpha: false,
      // A background quad showing a video texture is trivial for an
      // integrated GPU; 'low-power' keeps dual-GPU laptops from waking the
      // discrete card (the single biggest battery win available here).
      powerPreference: 'low-power',
    })
    if (!gl) return

    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(program)
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const aPosition = gl.getAttribLocation(program, 'aPosition')
    gl.enableVertexAttribArray(aPosition)
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0)

    // Dual texture setup (Texture A on unit 0, Texture B on unit 1)
    const textureA = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, textureA)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    const textureB = gl.createTexture()
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, textureB)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    const uTexA = gl.getUniformLocation(program, 'uTexA')
    const uTexB = gl.getUniformLocation(program, 'uTexB')
    const uCrossfade = gl.getUniformLocation(program, 'uCrossfade')
    const uResolution = gl.getUniformLocation(program, 'uResolution')
    const uMouse = gl.getUniformLocation(program, 'uMouse')
    const uMouseActive = gl.getUniformLocation(program, 'uMouseActive')
    const uTime = gl.getUniformLocation(program, 'uTime')
    const uVideoAspect = gl.getUniformLocation(program, 'uVideoAspect')
    const uTremble = gl.getUniformLocation(program, 'uTremble')
    const uGrade = gl.getUniformLocation(program, 'uGrade')
    const uWave = gl.getUniformLocation(program, 'uWave')
    const uRipples = gl.getUniformLocation(program, 'uRipples')
    const uRippleCount = gl.getUniformLocation(program, 'uRippleCount')

    const mouse = { x: 0.5, y: 0.5, active: 0 }
    const ripples: Array<{ x: number; y: number; t0: number }> = []
    const start = performance.now()

    // Frame gating — the shader pass runs only when the pixels would change.
    let needsRedraw = true
    let lastDraw = 0
    let lastMouseActive = -1
    const rippleData = new Float32Array(MAX_RIPPLES * 3)

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, 1.25)
      canvas.width = Math.floor(window.innerWidth * dpr)
      canvas.height = Math.floor(window.innerHeight * dpr)
      gl.viewport(0, 0, canvas.width, canvas.height)
      needsRedraw = true
    }
    resize()
    window.addEventListener('resize', resize)

    const onMove = (e: PointerEvent) => {
      mouse.x = e.clientX / window.innerWidth
      mouse.y = 1 - e.clientY / window.innerHeight
      mouse.active = 1
    }
    const onLeave = () => { mouse.active = 0 }
    const onDown = (e: PointerEvent) => {
      ripples.push({
        x: e.clientX / window.innerWidth,
        y: 1 - e.clientY / window.innerHeight,
        t0: performance.now(),
      })
      if (ripples.length > MAX_RIPPLES) ripples.shift()
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', onDown, { passive: true })
    window.addEventListener('pointerleave', onLeave, { passive: true })

    let paused = document.hidden
    const onVisibility = () => {
      const wasPaused = paused
      paused = document.hidden
      // The videos keep decoding while the tab is hidden even though their
      // frames are never sampled — pause them so the decoder rests too.
      const activeVideo = activeBufferRef.current === 'A' ? videoRefA.current : videoRefB.current
      if (paused) {
        activeVideo?.pause()
      } else {
        activeVideo?.play().catch(() => {})
        needsRedraw = true
      }
      if (wasPaused && !paused) render()
    }
    document.addEventListener('visibilitychange', onVisibility)

    let lastFrameTimeA = -1
    let lastFrameTimeB = -1
    // ponytail: the loop reschedules itself forever, so the id has to be held
    // to cancel it on unmount — otherwise leaving the workspace leaves an
    // immortal rAF loop pinning this canvas + GL context alive.
    let rafId = 0

    const render = () => {
      if (paused) return

      const config = MARKETPLACE_CYBERPUNK_VIDEOS[sceneRef.current]
      const vidA = videoRefA.current
      const vidB = videoRefB.current

      // Pre-warm + micro-crossfade for forward↔reversed pairs, folded in
      // from the old dedicated rAF watcher — a few comparisons per frame
      // instead of a second full-rate loop. Native seamless loops skip.
      let crossfadeChanged = false
      if (!config.isSeamlessLoop && vidA && vidB) {
        const active = activeBufferRef.current === 'A' ? vidA : vidB
        const standby = activeBufferRef.current === 'A' ? vidB : vidA
        if (active.duration) {
          const remaining = active.duration - active.currentTime
          if (remaining <= PREWARM_LEAD_TIME && standby.paused) {
            standby.currentTime = 0.01
            standby.playbackRate = config.playbackRate ?? PLAYBACK_RATE
            standby.play().catch(() => {})
          }
          const isA = activeBufferRef.current === 'A'
          const next =
            remaining <= CROSSFADE_WINDOW
              ? isA
                ? Math.max(0, Math.min(1, 1 - remaining / CROSSFADE_WINDOW))
                : Math.max(0, Math.min(1, remaining / CROSSFADE_WINDOW))
              : isA ? 0 : 1
          crossfadeChanged = next !== crossfadeRef.current
          crossfadeRef.current = next
          if (remaining <= 0.015) {
            active.pause()
            active.currentTime = 0.01
            crossfadeRef.current = isA ? 1 : 0
            setActiveBuffer(isA ? 'B' : 'A')
          }
        }
      }

      // Gate 1 — the videos only decode ~24–30 frames a second; on a 60–120Hz
      // display most rAF ticks would re-upload and re-draw the identical
      // texture. Only ticks where a video's currentTime actually moved count
      // as new frames.
      let newFrame = false
      if (vidA && vidA.readyState >= 2 && vidA.videoWidth > 0) {
        if (vidA.currentTime !== lastFrameTimeA) {
          lastFrameTimeA = vidA.currentTime
          newFrame = true
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, textureA)
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vidA)
          } catch (_) { /* ignore */ }
        }
      }
      if (vidB && vidB.readyState >= 2 && vidB.videoWidth > 0) {
        if (vidB.currentTime !== lastFrameTimeB) {
          lastFrameTimeB = vidB.currentTime
          newFrame = true
          gl.activeTexture(gl.TEXTURE1)
          gl.bindTexture(gl.TEXTURE_2D, textureB)
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vidB)
          } catch (_) { /* ignore */ }
        }
      }

      const activeVideo = activeBufferRef.current === 'A' ? vidA : vidB

      // Gate 2 — ripples, the cursor wave field and crossfade progress are the
      // only other sources of change. Nothing live + no new frame → sleep.
      const now = performance.now()
      for (let i = ripples.length - 1; i >= 0; i--) {
        if ((now - ripples[i].t0) / 1000 > 2.6) ripples.splice(i, 1)
      }
      const mouseMoved = mouse.active !== lastMouseActive
      lastMouseActive = mouse.active
      const live = newFrame || needsRedraw || mouseMoved || crossfadeChanged || ripples.length > 0
      if (!live) {
        rafId = requestAnimationFrame(render)
        return
      }

      // Gate 3 — 30fps is plenty for a rippling background: cap the draw
      // rate so 120Hz displays do 120 → 30 draws. Never draw before the
      // active video has decoded its first frame.
      if (activeVideo && activeVideo.videoWidth > 0 && now - lastDraw >= 31) {
        lastDraw = now
        needsRedraw = false

        for (let i = 0; i < ripples.length; i++) {
          rippleData[i * 3] = ripples[i].x
          rippleData[i * 3 + 1] = ripples[i].y
          rippleData[i * 3 + 2] = (now - ripples[i].t0) / 1000
        }

        gl.useProgram(program)
        gl.uniform1i(uTexA, 0)
        gl.uniform1i(uTexB, 1)
        gl.uniform1f(uCrossfade, crossfadeRef.current)
        gl.uniform2f(uResolution, canvas.width, canvas.height)
        gl.uniform2f(uMouse, mouse.x, mouse.y)
        gl.uniform1f(uMouseActive, mouse.active)
        gl.uniform1f(uTime, (now - start) / 1000)
        gl.uniform1f(uVideoAspect, activeVideo.videoWidth / activeVideo.videoHeight)
        gl.uniform1f(uTremble, MARKETPLACE_CYBERPUNK_VIDEOS[sceneRef.current].tremble ? 1 : 0)
        gl.uniform1f(uGrade, MARKETPLACE_CYBERPUNK_VIDEOS[sceneRef.current].graded ? 1 : 0)
        gl.uniform1f(uWave, (!reduceMotion && MARKETPLACE_CYBERPUNK_VIDEOS[sceneRef.current].pixelWave) ? 1 : 0)
        gl.uniform3fv(uRipples, rippleData)
        gl.uniform1f(uRippleCount, ripples.length)

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }

      rafId = requestAnimationFrame(render)
    }
    render()

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      gl.deleteProgram(program)
      gl.deleteBuffer(buffer)
      gl.deleteTexture(textureA)
      gl.deleteTexture(textureB)
      // ponytail: deliberately NOT calling WEBGL_lose_context here — see the
      // matching note in HomepageAnimeSky. React reuses this <canvas> across
      // remounts and getContext() on a force-lost canvas keeps returning the
      // dead context, which black-screens the background. The rAF cancel
      // above is the fix; GC reclaims the context once nothing holds it.
    }
  }, [])

  useEffect(() => {
    const inner = innerRef.current
    if (!inner) return

    let targetX = 0, targetY = 0
    let currentX = 0, currentY = 0
    let frameId: number
    let running = false

    const onMove = (e: PointerEvent) => {
      targetX = (e.clientX / window.innerWidth - 0.5) * 32
      targetY = (e.clientY / window.innerHeight - 0.5) * 24
      if (!running) {
        running = true
        loop()
      }
    }
    window.addEventListener('pointermove', onMove, { passive: true })

    const loop = () => {
      // The scene settles once the pointer stops — the loop then stops too,
      // instead of rewriting an identical transform 60–120 times a second.
      const dx = targetX - currentX
      const dy = targetY - currentY
      if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02) {
        currentX = targetX
        currentY = targetY
        running = false
        return
      }
      currentX += dx * 0.08
      currentY += dy * 0.08
      inner.style.transform = `translate(${-currentX * 0.4}px, ${-currentY * 0.4}px) scale(1.08)`
      frameId = requestAnimationFrame(loop)
    }

    return () => {
      window.removeEventListener('pointermove', onMove)
      if (running) cancelAnimationFrame(frameId)
    }
  }, [])

  return (
    <div ref={rootRef} className="anime-scene">
      <div ref={innerRef} className="w-full h-full relative overflow-hidden" style={{ willChange: 'transform', backfaceVisibility: 'hidden' }}>
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ transform: 'translateZ(0)', backfaceVisibility: 'hidden' }} />
        <video ref={videoRefA} className="absolute inset-0 w-full h-full object-cover opacity-0 pointer-events-none" playsInline muted />
        <video ref={videoRefB} className="absolute inset-0 w-full h-full object-cover opacity-0 pointer-events-none" playsInline muted />
      </div>
    </div>
  )
}
