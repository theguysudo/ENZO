import { useEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'

/**
 * Tactile "liquid" button — a WebGL capsule rendered inside a sandboxed iframe
 * so its shader can never collide with the app's own contexts.
 *
 * The liquid is a single-triangle full-screen quad: a sine-stacked surface
 * line at u_level with slosh/tilt/gulp physics driven by pointer movement and
 * clicks. Clicks inside the sandbox can't reach React directly, so the iframe
 * posts a message to the parent, which this wrapper translates into onClick.
 *
 * Adapted from the shadcn-style template for the nav:
 *  - no CDNs (GSAP/Tailwind/iconify/Inter) — inline CSS + system font + a
 *    hand-inlined lucide arrow; the label is plain visible text, no GSAP
 *    entrance that could leave it at opacity:0
 *  - the demo's full-page fbm background is dropped (it would paint a dark
 *    rectangle inside the nav glass and cost a second WebGL context); the
 *    iframe body is transparent so the nav glass shows through
 *  - draw gated to ~30fps (physics still runs per rAF) and both contexts are
 *    low-power, per the platform-wide CPU budget; prefers-reduced-motion
 *    freezes u_time and widens the draw gate
 *  - light mode is the classic invert + hue-rotate filter, so the cyan hue
 *    survives on a light surface
 */

const CLICK_MESSAGE = 'enzo:tactile-button-click'
const PAD = 8

export interface TactileButtonProps {
  label?: string
  mode?: 'dark' | 'light'
  width?: number
  height?: number
  fontSize?: number
  onClick?: () => void
  className?: string
  style?: CSSProperties
}

function buildTactileDocument(opts: {
  label: string
  width: number
  height: number
  fontSize: number
}): string {
  const { label, width, height, fontSize } = opts
  const radius = Math.max(10, Math.round(height * 0.32))
  const arrowSize = Math.max(10, Math.round(fontSize * 1.2))

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #btn {
    position: relative;
    width: ${width}px; height: ${height}px;
    border: 0; border-radius: ${radius}px; overflow: hidden;
    background: #04080e; cursor: pointer; outline: none; padding: 0;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05), 0 10px 28px rgba(0,0,0,0.45);
    transition: transform 0.18s ease;
  }
  #btn:hover { transform: translateY(-1px); }
  #btn:active { transform: translateY(0) scale(0.985); }
  #btn:focus-visible {
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05), 0 0 0 2px rgba(6,182,212,0.55);
  }
  /* Gradient border ring — masked to a 1px edge, above the liquid */
  #btn::after {
    content: ''; position: absolute; inset: 0; z-index: 3; pointer-events: none;
    border-radius: ${radius}px; padding: 1px;
    background: linear-gradient(to bottom, rgba(6,182,212,0.30), rgba(38,38,38,0.20), rgba(8,51,68,0.40));
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    mask-composite: exclude;
  }
  #cv { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  #lbl {
    position: relative; z-index: 2; pointer-events: none;
    display: inline-flex; align-items: center; gap: 0.55em;
    font-size: ${fontSize}px; font-weight: 800;
    letter-spacing: 0.30em; text-indent: 0.30em; text-transform: uppercase;
    color: #f2fdff;
    text-shadow: 0 1px 2px rgba(0,10,18,0.95), 0 0 4px rgba(0,15,25,0.9), 0 1px 10px rgba(0,18,25,0.85);
    transition: transform 0.18s ease;
  }
  #btn:hover #lbl { transform: translateX(2px); }
  #lbl svg { opacity: 1; flex-shrink: 0; }
</style>
</head>
<body>
<button id="btn" type="button" aria-label="${label}">
  <canvas id="cv"></canvas>
  <span id="lbl">${label}<svg xmlns="http://www.w3.org/2000/svg" width="${arrowSize}" height="${arrowSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></span>
</button>
<script>
(function () {
  var W = ${width}, H = ${height};
  var cv = document.getElementById('cv');
  var btn = document.getElementById('btn');

  var reduced = false;
  try { reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  function fallback() {
    cv.style.background = 'linear-gradient(to top, #02435f 0%, #017a99 54%, #04080e 56%, #04080e 100%)';
  }

  var gl = null;
  var opts = { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' };
  try { gl = cv.getContext('webgl', opts) || cv.getContext('experimental-webgl', opts); } catch (e) {}
  if (!gl) { fallback(); return; }

  var VS = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';

  var FS = [
    'precision highp float;',
    'uniform vec2 u_res;',
    'uniform float u_time;',
    'uniform float u_level;',
    'uniform float u_tilt;',
    'uniform float u_slosh;',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
    'float noise(vec2 p){',
    '  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),',
    '             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'float fbm(vec2 p){',
    '  float v = 0.0; float a = 0.5;',
    '  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; }',
    '  return v;',
    '}',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / u_res;',
    '  float x = uv.x; float t = u_time;',
    '  float amp = 0.012 + u_slosh * 0.045;',
    '  float surf = u_level + u_tilt * (uv.x - 0.5) * 0.34',
    '    + amp * sin(x * 5.1 + t * 4.6)',
    '    + amp * 0.62 * sin(x * 9.7 - t * 6.8 + 1.7)',
    '    + amp * 0.38 * sin(x * 14.3 + t * 8.9 + 4.2);',
    '  float d = surf - uv.y;',
    '  float inside = smoothstep(0.0, 0.012, d);',
    '  float depth = clamp(d * 3.0, 0.0, 1.0);',
    '  vec3 liq = mix(vec3(0.0, 0.52, 0.62), vec3(0.012, 0.09, 0.28), depth);',
    '  float ca = fbm(vec2(x * 6.0, d * 2.0 - t * 0.35));',
    '  liq += vec3(0.16, 0.24, 0.26) * pow(max(ca - 0.55, 0.0) * 2.2, 2.0) * inside;',
    '  vec3 col = vec3(0.014, 0.030, 0.048);',
    '  col += vec3(0.007, 0.015, 0.024) * (1.0 - uv.y);',
    '  col = mix(col, liq, inside);',
    '  col += vec3(0.20, 0.46, 0.52) * exp(-abs(d) * 80.0) * 0.55;',
    '  col += vec3(0.26, 0.55, 0.60) * exp(-abs(d) * 220.0) * 0.30;',
    '  float vig = smoothstep(1.25, 0.35, length(uv - vec2(0.5, 0.5)));',
    '  col *= mix(0.62, 1.0, vig);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\\n');

  function makeShader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
    return s;
  }
  var vs = makeShader(gl.VERTEX_SHADER, VS);
  var fs = makeShader(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) { fallback(); return; }
  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { fallback(); return; }
  gl.useProgram(prog);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  var uRes = gl.getUniformLocation(prog, 'u_res');
  var uTime = gl.getUniformLocation(prog, 'u_time');
  var uLevel = gl.getUniformLocation(prog, 'u_level');
  var uTilt = gl.getUniformLocation(prog, 'u_tilt');
  var uSlosh = gl.getUniformLocation(prog, 'u_slosh');

  var dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.max(1, Math.round(W * dpr));
  cv.height = Math.max(1, Math.round(H * dpr));
  gl.viewport(0, 0, cv.width, cv.height);

  /* Liquid state: idle level, slosh energy from pointer motion, tilt toward
     the cursor, and a "gulp" dip on click. */
  var BASE = 0.56;
  var level = BASE, gulp = 0, slosh = 0.35, tilt = 0, tiltTarget = 0, lastX = 0.5;

  btn.addEventListener('mousemove', function (e) {
    var r = btn.getBoundingClientRect();
    var x = (e.clientX - r.left) / Math.max(1, r.width);
    x = Math.max(0, Math.min(1, x));
    slosh = Math.min(1.4, slosh + Math.abs(x - lastX) * 2.6);
    lastX = x;
    tiltTarget = (x - 0.5) * 2.0;
  });
  btn.addEventListener('mouseleave', function () { tiltTarget = 0; });

  btn.addEventListener('click', function () {
    gulp = 1;
    slosh = Math.min(1.6, slosh + 0.7);
    try { window.parent.postMessage({ type: '${CLICK_MESSAGE}' }, '*'); } catch (err) {}
  });

  /* Physics every frame; draw gated to ~30fps (reduced motion: 10fps with a
     frozen clock, since only the post-click level change can move). */
  var gate = reduced ? 100 : 33;
  var last = performance.now(), lastDraw = -1e9;
  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    slosh *= Math.exp(-1.5 * dt);
    gulp *= Math.exp(-1.1 * dt);
    tilt += (tiltTarget - tilt) * Math.min(1, dt * 5);
    var levelTarget = BASE - 0.36 * gulp;
    level += (levelTarget - level) * Math.min(1, dt * 5.5);

    if (now - lastDraw >= gate) {
      lastDraw = now;
      gl.uniform2f(uRes, cv.width, cv.height);
      gl.uniform1f(uTime, reduced ? 2.0 : now / 1000);
      gl.uniform1f(uLevel, level);
      gl.uniform1f(uTilt, tilt);
      gl.uniform1f(uSlosh, reduced ? 0.25 : slosh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
</script>
</body>
</html>`
}

export function TactileButton({
  label = 'Login',
  mode = 'dark',
  width = 250,
  height = 70,
  fontSize = 14,
  onClick,
  className,
  style,
}: TactileButtonProps) {
  const onClickRef = useRef(onClick)

  useEffect(() => {
    onClickRef.current = onClick
  }, [onClick])

  const srcDoc = useMemo(
    () => buildTactileDocument({ label, width, height, fontSize }),
    [label, width, height, fontSize],
  )

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === CLICK_MESSAGE) onClickRef.current?.()
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const lightFilter =
    mode === 'light'
      ? 'invert(1) hue-rotate(180deg) saturate(0.92) brightness(1.02)'
      : undefined

  return (
    <iframe
      title={`${label} button`}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      scrolling="no"
      className={className}
      style={{
        width: width + PAD * 2,
        height: height + PAD * 2,
        border: 0,
        background: 'transparent',
        filter: lightFilter,
        ...style,
      }}
    />
  )
}

export default TactileButton
