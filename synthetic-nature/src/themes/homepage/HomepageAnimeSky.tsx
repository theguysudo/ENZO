/**
 * HomepageAnimeSky — Anime video & canvas background for Homepage themes
 */

import { useEffect, useRef, useState } from 'react'
import type { HomepageAnimeScene } from './types'

interface SceneSources {
  forward: string
  reversed: string
  isSeamlessLoop?: boolean
}

/** Scene registry — also the source of truth for the first-visit warm-up
 * (ThemeVideoWarmup.tsx), so the warm list can never drift from what the
 * renderer actually plays. */
export const HOMEPAGE_ANIME_VIDEOS: Record<HomepageAnimeScene, SceneSources> = {
  sky: {
    forward: '/background_elements/homepage/Anime_style_summer_sky_video_l_gwr_video_mvp.mp4',
    reversed: '/background_elements/homepage/Anime_style_summer_sky_video_l_gwr_video_mvp_reversed.mp4',
  },
  cottage: {
    forward: '/background_elements/homepage/Anime_rainy_cottage_video_loop_202607160442_gwr_video_mvp.mp4',
    reversed: '/background_elements/homepage/Anime_rainy_cottage_video_loop_202607160442_gwr_video_mvp_reversed.mp4',
  },
  observatory: {
    forward: '/background_elements/homepage/Anime_observatory_night_sky_loop_202607160450_gwr_video_mvp.mp4',
    reversed: '/background_elements/homepage/Anime_observatory_night_sky_loop_202607160450_gwr_video_mvp_reversed.mp4',
  },
  forest: {
    forward: '/background_elements/homepage/Anime_misty_forest_video_loop_202607160454_gwr_video_mvp.mp4',
    reversed: '/background_elements/homepage/Anime_misty_forest_video_loop_202607160454_gwr_video_mvp_reversed.mp4',
  },
  alien: {
    forward: '/background_elements/homepage/Human_viewing_alien_communicatio…_1080p_202608170106_gwr_video_mvp.mp4',
    reversed: '/background_elements/homepage/Human_viewing_alien_communicatio…_1080p_202608170106_gwr_video_mvp.mp4',
    isSeamlessLoop: true,
  },
  rocket: {
    forward: '/background_elements/homepage/Rocket_video_seamless_loop_requi…_202608170105_gwr_video_mvp.mp4',
    reversed: '/background_elements/homepage/Rocket_video_seamless_loop_requi…_202608170105_gwr_video_mvp.mp4',
    isSeamlessLoop: true,
  },
  space_probe: {
    forward: '/background_elements/homepage/Space_probe_drifting_above_planet_202608170018_gwr_video_mvp.mp4',
    reversed: '/background_elements/homepage/Space_probe_drifting_above_planet_202608170018_gwr_video_mvp.mp4',
    isSeamlessLoop: true,
  },
  coding_deck: {
    forward: '/background_elements/homepage/coding-deck-moewalls-com.mp4',
    reversed: '/background_elements/homepage/coding-deck-moewalls-com.mp4',
    isSeamlessLoop: true,
  },
  purple_flowers: {
    forward: '/background_elements/homepage/Robotic_figure_in_purple_flowers_202608021811.mp4',
    reversed: '/background_elements/homepage/Robotic_figure_in_purple_flowers_202608021811.mp4',
    isSeamlessLoop: true,
  },
}

const MAX_RIPPLES = 12
const PLAYBACK_RATE = 0.6

const VERT = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

const FRAG = `
precision highp float;

uniform sampler2D uTex;
uniform vec2  uResolution;
uniform vec2  uMouse;
uniform float uMouseActive;
uniform float uTime;
uniform float uVideoAspect;
uniform vec3  uRipples[${MAX_RIPPLES}];
uniform float uRippleCount;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 disp = vec2(0.0);

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
  gl_FragColor = texture2D(uTex, texUv);
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

export function HomepageAnimeSky({ scene }: { scene: HomepageAnimeScene }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [activeBuffer, setActiveBuffer] = useState<'A' | 'B'>('A')
  const activeBufferRef = useRef<'A' | 'B'>('A')
  activeBufferRef.current = activeBuffer

  // The render loop below is the only rAF loop left in this component. It
  // reads the scene through a ref so it survives theme switches without
  // re-subscribing (and without holding a stale closure over `scene`).
  const sceneRef = useRef(scene)
  sceneRef.current = scene

  const videoRefA = useRef<HTMLVideoElement>(null)
  const videoRefB = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const vidA = videoRefA.current
    const vidB = videoRefB.current
    const config = HOMEPAGE_ANIME_VIDEOS[scene]
    if (!vidA || !vidB) return
    vidA.src = config.forward
    vidA.load()
    vidA.currentTime = 0.01
    vidA.playbackRate = PLAYBACK_RATE
    vidB.pause()
      vidA.play().catch(() => {})
      setActiveBuffer('A')
    if (config.isSeamlessLoop) {
      vidA.loop = true
      // Native loops never crossfade, so the second decoder is never read.
      // Drop its source rather than keeping a paused <video> with a full
      // decode pipeline (and one texture upload) alive for nothing.
      vidB.removeAttribute('src')
      vidB.load()
    } else {
      vidA.loop = false
      vidB.loop = false
      // The reversed clip isn't read until the crossfade at the forward
      // clip's end (~40s of wall time at 0.6×) — cold-loading both files
      // on every theme switch doubled the switch cost for nothing. Arm B
      // once the forward video is actually playing; if autoplay is
      // blocked the swap handlers' duration guards keep the crossfade
      // from firing against an unloaded buffer.
      vidB.removeAttribute('src')
      const armB = () => {
        vidB.src = config.reversed
        vidB.load()
        vidB.currentTime = 0.01
        vidB.playbackRate = PLAYBACK_RATE
      }
      vidA.addEventListener('playing', armB, { once: true })
      return () => vidA.removeEventListener('playing', armB)
    }
  }, [scene])

  // Seamless-loop scenes never crossfade, so the A/B swap watcher has nothing
  // to watch — a plain `timeupdate` handler replaces the rAF loop entirely
  // (fires a few times per second, zero idle cost).
  useEffect(() => {
    const config = HOMEPAGE_ANIME_VIDEOS[scene]
    if (config.isSeamlessLoop) return

    const onTimeA = () => {
      const vidA = videoRefA.current
      const vidB = videoRefB.current
      if (!vidA || !vidA.duration) return
      if (vidA.currentTime < vidA.duration - 0.08) return
      if (vidB) {
        vidB.currentTime = 0.01
        vidB.playbackRate = PLAYBACK_RATE
        vidB.play().catch(() => {})
      }
      setActiveBuffer('B')
    }
    const onTimeB = () => {
      const vidA = videoRefA.current
      const vidB = videoRefB.current
      if (!vidB || !vidB.duration) return
      if (vidB.currentTime < vidB.duration - 0.08) return
      if (vidA) {
        vidA.currentTime = 0.01
        vidA.playbackRate = PLAYBACK_RATE
        vidA.play().catch(() => {})
      }
      setActiveBuffer('A')
    }

    const vidA = videoRefA.current
    const vidB = videoRefB.current
    vidA?.addEventListener('timeupdate', onTimeA)
    vidB?.addEventListener('timeupdate', onTimeB)
    // timeupdate fires ~4Hz, so the 80ms swap window can slip between events;
    // 'ended' guarantees the flip even when no timeupdate lands near the end.
    vidA?.addEventListener('ended', onTimeA)
    vidB?.addEventListener('ended', onTimeB)
    return () => {
      vidA?.removeEventListener('timeupdate', onTimeA)
      vidB?.removeEventListener('timeupdate', onTimeB)
      vidA?.removeEventListener('ended', onTimeA)
      vidB?.removeEventListener('ended', onTimeB)
    }
  }, [scene])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
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

    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    const uTex = gl.getUniformLocation(program, 'uTex')
    const uResolution = gl.getUniformLocation(program, 'uResolution')
    const uMouse = gl.getUniformLocation(program, 'uMouse')
    const uMouseActive = gl.getUniformLocation(program, 'uMouseActive')
    const uTime = gl.getUniformLocation(program, 'uTime')
    const uVideoAspect = gl.getUniformLocation(program, 'uVideoAspect')
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

    let lastFrameTime = -1
    // ponytail: the loop reschedules itself forever, so the id has to be held
    // to cancel it on unmount. Without this, every switch to the nebula theme
    // left an immortal rAF loop pinning this canvas + GL context alive — after
    // ~16 round trips the browser starts force-losing the oldest context.
    let rafId = 0
    const render = () => {
      if (paused) return
      const video = activeBufferRef.current === 'A' ? videoRefA.current : videoRefB.current

      // Gate 1 — the video is the only source of "new pixels"; a tick counts
      // as a new frame only when the video's currentTime actually moved, and
      // the texture upload happens in that same tick (no double uploads).
      let newFrame = false
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        if (video.currentTime !== lastFrameTime) {
          lastFrameTime = video.currentTime
          newFrame = true
          gl.bindTexture(gl.TEXTURE_2D, texture)
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
          } catch (_) { /* ignore frame error */ }
        }
      }

      // Gate 2 — ripples and the cursor wave field are the only other sources
      // of change. If none are live and the video didn't advance, skip the
      // draw and go back to sleep until something does.
      const now = performance.now()
      for (let i = ripples.length - 1; i >= 0; i--) {
        if ((now - ripples[i].t0) / 1000 > 2.6) ripples.splice(i, 1)
      }
      const mouseMoved = mouse.active !== lastMouseActive
      lastMouseActive = mouse.active
      if (!newFrame && !needsRedraw && !mouseMoved && ripples.length === 0) {
        rafId = requestAnimationFrame(render)
        return
      }
      // Gate 3 — even when live, 30fps is plenty for a rippling background:
      // cap the draw rate so 120Hz displays do 120 → 30 draws. Never draw
      // before the video has decoded its first frame (texture is empty).
      if (video && video.videoWidth > 0 && (newFrame || needsRedraw || mouseMoved || ripples.length > 0)) {
        if (now - lastDraw >= 31) {
          lastDraw = now
          needsRedraw = false

          for (let i = 0; i < ripples.length; i++) {
            rippleData[i * 3] = ripples[i].x
            rippleData[i * 3 + 1] = ripples[i].y
            rippleData[i * 3 + 2] = (now - ripples[i].t0) / 1000
          }

          gl.useProgram(program)
          gl.uniform1i(uTex, 0)
          gl.uniform2f(uResolution, canvas.width, canvas.height)
          gl.uniform2f(uMouse, mouse.x, mouse.y)
          gl.uniform1f(uMouseActive, mouse.active)
          gl.uniform1f(uTime, (now - start) / 1000)
          gl.uniform1f(uVideoAspect, video.videoWidth / video.videoHeight)
          gl.uniform3fv(uRipples, rippleData)
          gl.uniform1f(uRippleCount, ripples.length)

          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        }
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
      gl.deleteTexture(texture)
      // ponytail: deliberately NOT calling WEBGL_lose_context here. React
      // reuses this same <canvas> element across remounts (StrictMode's
      // double-invoke, HMR), and getContext() on a force-lost canvas returns
      // the same dead context forever — every shader compile then fails and
      // the background renders black. Cancelling the rAF loop above is what
      // actually frees the context: nothing references the canvas afterwards,
      // so the GPU resources go away with GC.
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
