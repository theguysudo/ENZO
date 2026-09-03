import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export interface InteractiveNebulaShaderProps {
  hasActiveReminders?: boolean
  hasUpcomingReminders?: boolean
  disableCenterDimming?: boolean
  className?: string
}

/**
 * Full-screen nebula shader background.
 * Props drive three GLSL uniforms—no demo markup here.
 */
export function InteractiveNebulaShader({
  hasActiveReminders = false,
  hasUpcomingReminders = false,
  disableCenterDimming = false,
  className = '',
}: InteractiveNebulaShaderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const materialRef = useRef<THREE.ShaderMaterial | null>(null)

  // Sync props into uniforms
  useEffect(() => {
    const mat = materialRef.current
    if (mat) {
      mat.uniforms.hasActiveReminders.value = hasActiveReminders
      mat.uniforms.hasUpcomingReminders.value = hasUpcomingReminders
      mat.uniforms.disableCenterDimming.value = disableCenterDimming
    }
  }, [hasActiveReminders, hasUpcomingReminders, disableCenterDimming])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Renderer, scene, camera, clock
    // Background shader pass, tuned for cost: no MSAA (pointless on a
    // full-screen quad), 'low-power' keeps dual-GPU laptops on the
    // integrated card instead of waking the discrete one, and the pixel
    // ratio is capped at 1.5 — a ray-marched nebula at full retina DPR
    // shades 4× the pixels for no visible gain.
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    // Vertex shader: pass UVs
    const vertexShader = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `

    // Ray-marched nebula fragment shader with reminder-driven palettes
    const fragmentShader = `
      precision mediump float;
      uniform vec2 iResolution;
      uniform float iTime;
      uniform bool hasActiveReminders;
      uniform bool hasUpcomingReminders;
      uniform bool disableCenterDimming;
      varying vec2 vUv;

      #define t iTime
      mat2 m(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
      float map(vec3 p){
        p.xz *= m(t*0.4);
        p.xy *= m(t*0.3);
        vec3 q = p*2. + t;
        return length(p + vec3(sin(t*0.7))) * log(length(p)+1.0)
             + sin(q.x + sin(q.z + sin(q.y))) * 0.5 - 1.0;
      }

      void mainImage(out vec4 O, in vec2 fragCoord) {
        vec2 uv = fragCoord / min(iResolution.x, iResolution.y) - vec2(.9, .5);
        uv.x += .4;
        vec3 col = vec3(0.0);
        float d = 2.5;

        // Ray-march
        for (int i = 0; i <= 5; i++) {
          vec3 p = vec3(0,0,5.) + normalize(vec3(uv, -1.)) * d;
          float rz = map(p);
          float f  = clamp((rz - map(p + 0.1)) * 0.5, -0.1, 1.0);

          vec3 base = hasActiveReminders
            ? vec3(0.05,0.2,0.5) + vec3(4.0,2.0,5.0)*f
            : hasUpcomingReminders
            ? vec3(0.05,0.3,0.1) + vec3(2.0,5.0,1.0)*f
            : vec3(0.1,0.3,0.4) + vec3(5.0,2.5,3.0)*f;

          col = col * base + smoothstep(2.5, 0.0, rz) * 0.7 * base;
          d += min(rz, 1.0);
        }

        // Center dimming
        float dist   = distance(fragCoord, iResolution*0.5);
        float radius = min(iResolution.x, iResolution.y) * 0.5;
        float dim    = disableCenterDimming
                     ? 1.0
                     : smoothstep(radius*0.3, radius*0.5, dist);

        O = vec4(col, 1.0);
        if (!disableCenterDimming) {
          O.rgb = mix(O.rgb * 0.3, O.rgb, dim);
        }
      }

      void main() {
        mainImage(gl_FragColor, vUv * iResolution);
      }
    `

    // Uniforms (iMouse removed — the shader never read it; tracking the
    // pointer every mousemove was pure listener cost.)
    const uniforms = {
      iTime: { value: 0 },
      iResolution: { value: new THREE.Vector2() },
      hasActiveReminders: { value: hasActiveReminders },
      hasUpcomingReminders: { value: hasUpcomingReminders },
      disableCenterDimming: { value: disableCenterDimming },
    }

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
    })
    materialRef.current = material
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    scene.add(mesh)

    // Resize
    const onResize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      renderer.setSize(w, h)
      uniforms.iResolution.value.set(w, h)
    }
    window.addEventListener('resize', onResize)
    onResize()

    // Animation loop — capped at 30fps (a slow-moving nebula needs no more),
    // and suspended while the tab is hidden. iTime accumulates only on
    // rendered frames (clamped) so returning to the tab never jumps the pose.
    let paused = document.hidden
    let rafId = 0
    let lastDraw = 0
    let lastTick = performance.now()
    let iTime = 0

    const render = () => {
      if (paused) { rafId = 0; return }
      rafId = requestAnimationFrame(render)
      const now = performance.now()
      if (now - lastDraw < 33) return
      lastDraw = now
      iTime += Math.min((now - lastTick) / 1000, 0.1)
      lastTick = now
      uniforms.iTime.value = iTime
      renderer.render(scene, camera)
    }

    const onVisibility = () => {
      const wasPaused = paused
      paused = document.hidden
      if (wasPaused && !paused && !rafId) rafId = requestAnimationFrame(render)
    }
    document.addEventListener('visibilitychange', onVisibility)

    rafId = requestAnimationFrame(render)

    return () => {
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      cancelAnimationFrame(rafId)
      container.removeChild(renderer.domElement)
      material.dispose()
      mesh.geometry.dispose()
      renderer.dispose()
      materialRef.current = null
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 bg-background ${className}`}
      aria-label="Interactive nebula background"
    />
  )
}

export default InteractiveNebulaShader
