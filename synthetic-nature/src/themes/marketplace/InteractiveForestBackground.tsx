/**
 * InteractiveForestBackground — 3D Particle Constellation for Marketplace Default Theme
 */

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export type WeatherType = 'clear' | 'rain' | 'snow' | 'fog'

interface InteractiveForestBackgroundProps {
  activeVideoId?: string
  weather?: WeatherType
  onPreloadRequest?: (src: string) => void
}

const SCENE_HALF_W     = 11
const SCENE_HALF_H     = 6.5
const SCENE_DEPTH      = 8
const CONNECT_DIST     = 1.8
const REPEL_RADIUS     = 2.0
const REPEL_STRENGTH   = 0.055
const SPRING_STIFFNESS = 0.018
const DAMPING          = 0.88
const DRIFT_SPEED      = 0.00018

interface PerfTier {
  particleCount: number
  maxLines: number
  pixelRatio: number
  antialias: boolean
  lineInterval: number
}

const PERF_TIERS: Record<'high' | 'mid' | 'low', PerfTier> = {
  high: { particleCount: 620, maxLines: 1800, pixelRatio: 1.5, antialias: true,  lineInterval: 1 },
  mid:  { particleCount: 380, maxLines: 1000, pixelRatio: 1.5, antialias: true,  lineInterval: 2 },
  low:  { particleCount: 200, maxLines: 500,  pixelRatio: 1,   antialias: false, lineInterval: 3 },
}

function detectPerfTier(): PerfTier {
  if (typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return PERF_TIERS.low
  }

  const cores = navigator.hardwareConcurrency || 4
  const mem = (navigator as any).deviceMemory || 4
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
  const dpr = window.devicePixelRatio || 1

  if (mobile || cores <= 4 || mem <= 4) return PERF_TIERS.low
  if (cores >= 8 && mem >= 8 && dpr <= 2) return PERF_TIERS.high
  return PERF_TIERS.mid
}

export function InteractiveForestBackground({
  activeVideoId: _a,
  weather: _w,
  onPreloadRequest: _p,
}: InteractiveForestBackgroundProps) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const tier = detectPerfTier()
    const PARTICLE_COUNT = tier.particleCount
    const MAX_LINES = tier.maxLines

    // 'low-power' keeps dual-GPU laptops on the integrated card — the
    // constellation is light fragment work, not worth waking discrete GPUs.
    const renderer = new THREE.WebGLRenderer({ antialias: tier.antialias, alpha: false, powerPreference: 'low-power' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.pixelRatio))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setClearColor(0x0d0d18, 1)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()

    const camera = new THREE.PerspectiveCamera(
      65,
      mount.clientWidth / mount.clientHeight,
      0.1,
      120,
    )
    camera.position.set(0, 0, 10)

    const positions   = new Float32Array(PARTICLE_COUNT * 3)
    const origins     = new Float32Array(PARTICLE_COUNT * 3)
    const velocities  = new Float32Array(PARTICLE_COUNT * 3)
    const driftOffset = new Float32Array(PARTICLE_COUNT * 3)
    const sizes       = new Float32Array(PARTICLE_COUNT)

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const x = (Math.random() - 0.5) * SCENE_HALF_W * 2
      const y = (Math.random() - 0.5) * SCENE_HALF_H * 2
      const z = (Math.random() - 0.5) * SCENE_DEPTH

      positions[i * 3]     = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
      origins[i * 3]       = x
      origins[i * 3 + 1]   = y
      origins[i * 3 + 2]   = z

      driftOffset[i * 3]     = Math.random() * Math.PI * 2
      driftOffset[i * 3 + 1] = Math.random() * Math.PI * 2
      driftOffset[i * 3 + 2] = Math.random() * Math.PI * 2

      sizes[i] = Math.random() < 0.12 ? 0.055 + Math.random() * 0.03 : 0.025 + Math.random() * 0.015
    }

    const ptGeo = new THREE.BufferGeometry()
    ptGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    ptGeo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1))

    const ptMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uOpacity: { value: 0.92 },
        uColor:   { value: new THREE.Color(0xdde4f0) },
      },
      vertexShader: /* glsl */`
        attribute float size;
        varying float vAlpha;
        void main() {
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          float dist = -mvPos.z;
          vAlpha = clamp(1.0 - dist * 0.04, 0.3, 1.0);
          gl_PointSize = size * (300.0 / dist);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uOpacity;
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float alpha = 1.0 - smoothstep(0.6, 1.0, d);
          gl_FragColor = vec4(uColor, alpha * vAlpha * uOpacity);
        }
      `,
    })

    const points = new THREE.Points(ptGeo, ptMat)
    scene.add(points)

    const linePosArr = new Float32Array(MAX_LINES * 2 * 3)
    const lineAlpArr = new Float32Array(MAX_LINES * 2)

    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePosArr, 3))
    lineGeo.setAttribute('aAlpha',   new THREE.BufferAttribute(lineAlpArr, 1))
    lineGeo.setDrawRange(0, 0)

    const lineMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uColor: { value: new THREE.Color(0xffffff) },
      },
      vertexShader: /* glsl */`
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(uColor, vAlpha * 0.22);
        }
      `,
    })

    const lines = new THREE.LineSegments(lineGeo, lineMat)
    scene.add(lines)

    const mouseNDC   = new THREE.Vector2(0, 0)
    const targetCamX = { v: 0 }
    const targetCamY = { v: 0 }

    const onMouseMove = (e: MouseEvent) => {
      mouseNDC.x = (e.clientX / window.innerWidth)  *  2 - 1
      mouseNDC.y = (e.clientY / window.innerHeight) * -2 + 1
      targetCamX.v = mouseNDC.y * 0.25
      targetCamY.v = mouseNDC.x * 0.4
    }

    window.addEventListener('mousemove', onMouseMove, { passive: true })

    let resizeTimer: number | undefined
    const onResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        camera.aspect = mount.clientWidth / mount.clientHeight
        camera.updateProjectionMatrix()
        renderer.setSize(mount.clientWidth, mount.clientHeight)
      }, 150)
    }
    window.addEventListener('resize', onResize)

    let paused = document.hidden
    const onVisibility = () => {
      paused = document.hidden
      if (!paused && !raf) animate()
    }
    document.addEventListener('visibilitychange', onVisibility)

    let raf = 0
    // The sim reads wall-clock time, not frame count, so drift speed is
    // identical on 60Hz and 120Hz displays (frame-count drift ran 2× fast
    // on ProMotion screens) and is unaffected by the 40fps cap below.
    const startTime = performance.now()
    let lastFrame = 0
    let lastLineUpdate = 0

    const mouseWorld = new THREE.Vector3()
    const getMouseWorld = (): THREE.Vector3 => {
      const halfH = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z
      const halfW = halfH * camera.aspect
      return mouseWorld.set(mouseNDC.x * halfW, mouseNDC.y * halfH, 0)
    }

    const animate = () => {
      if (paused) { raf = 0; return }
      raf = requestAnimationFrame(animate)

      // 40fps cap — the constellation drifts on multi-second timescales;
      // full-rate rendering doubles-to-quadruples CPU/GPU cost for no
      // visible difference.
      const now = performance.now()
      if (now - lastFrame < 25) return
      lastFrame = now

      const pos = positions
      const vel = velocities
      const ori = origins

      const mw = getMouseWorld()
      const t = ((now - startTime) / 1000) * 60 * DRIFT_SPEED

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const i3 = i * 3
        const px = pos[i3],  py = pos[i3 + 1], pz = pos[i3 + 2]

        const dx0 = driftOffset[i3],  dy0 = driftOffset[i3+1], dz0 = driftOffset[i3+2]
        vel[i3]     += Math.sin(t * 1.7 + dx0) * 0.00035
        vel[i3 + 1] += Math.cos(t * 1.3 + dy0) * 0.00035
        vel[i3 + 2] += Math.sin(t * 0.9 + dz0) * 0.00018

        vel[i3]     += (ori[i3]     - px) * SPRING_STIFFNESS
        vel[i3 + 1] += (ori[i3 + 1] - py) * SPRING_STIFFNESS
        vel[i3 + 2] += (ori[i3 + 2] - pz) * SPRING_STIFFNESS

        const cx = px - mw.x,  cy = py - mw.y
        const cd = Math.sqrt(cx * cx + cy * cy)
        if (cd < REPEL_RADIUS && cd > 0.001) {
          const force = ((REPEL_RADIUS - cd) / REPEL_RADIUS) ** 1.5
          vel[i3]     += (cx / cd) * force * REPEL_STRENGTH
          vel[i3 + 1] += (cy / cd) * force * REPEL_STRENGTH
        }

        vel[i3]     *= DAMPING
        vel[i3 + 1] *= DAMPING
        vel[i3 + 2] *= DAMPING

        pos[i3]     += vel[i3]
        pos[i3 + 1] += vel[i3 + 1]
        pos[i3 + 2] += vel[i3 + 2]
      }

      ptGeo.attributes.position.needsUpdate = true

      if (now - lastLineUpdate >= tier.lineInterval * 16) {
        lastLineUpdate = now
        let lIdx = 0
        const lp  = linePosArr
        const la  = lineAlpArr
        const cd2 = CONNECT_DIST * CONNECT_DIST

        outer:
        for (let i = 0; i < PARTICLE_COUNT - 1; i++) {
          const i3 = i * 3
          for (let j = i + 1; j < PARTICLE_COUNT; j++) {
            if (lIdx >= MAX_LINES) break outer
            const j3 = j * 3
            const dx = pos[i3] - pos[j3]
            const dy = pos[i3+1] - pos[j3+1]
            const dz = pos[i3+2] - pos[j3+2]
            const d2 = dx*dx + dy*dy + dz*dz
            if (d2 < cd2) {
              const alpha = (1 - Math.sqrt(d2) / CONNECT_DIST) ** 2
              const base = lIdx * 6
              lp[base]   = pos[i3];   lp[base+1] = pos[i3+1]; lp[base+2] = pos[i3+2]
              lp[base+3] = pos[j3];   lp[base+4] = pos[j3+1]; lp[base+5] = pos[j3+2]
              const ab = lIdx * 2
              la[ab]   = alpha
              la[ab+1] = alpha
              lIdx++
            }
          }
        }

        lineGeo.attributes.position.needsUpdate = true
        lineGeo.attributes.aAlpha.needsUpdate   = true
        lineGeo.setDrawRange(0, lIdx * 2)
      }

      const lerpK = 0.04
      camera.rotation.x += (targetCamX.v - camera.rotation.x) * lerpK
      camera.rotation.y += (targetCamY.v - camera.rotation.y) * lerpK

      renderer.render(scene, camera)
    }

    animate()

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(resizeTimer)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      ptGeo.dispose()
      ptMat.dispose()
      lineGeo.dispose()
      lineMat.dispose()
      renderer.dispose()
      try { mount.removeChild(renderer.domElement) } catch (_) {}
    }
  }, [])

  return (
    <div
      ref={mountRef}
      className="fixed inset-0 w-screen h-screen z-0 pointer-events-auto"
      style={{
        background: '#0d0d18',
        transform: 'translateZ(0)',
        contain: 'strict',
        isolation: 'isolate',
      }}
    />
  )
}
