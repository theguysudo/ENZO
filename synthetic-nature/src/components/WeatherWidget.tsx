// WeatherWidget — the ambient side widget in the Marketplace filter sidebar.
//
// The card itself is the classic animated weather chip, unchanged in geometry
// and motion: a narrow capsule that widens on hover, a big temperature that
// lifts and scales up, and condition lines that slide in from off-card. Only
// the skin differs from the original flat grey/blue demo — frosted glass with
// the same rim language as the rest of ENZO, and a sky wash on hover instead
// of the blue paint.
//
// Data is ambient, not interactive: the visitor's IP is geolocated once
// (ipwho.is, geojs fallback — both free, keyless) and the current conditions
// come from Open-Meteo. The result is cached in sessionStorage for 30 minutes
// so re-entering the catalog doesn't refetch. If both lookups fail the card
// degrades to a quiet "—" instead of disappearing mid-layout.

import { useEffect, useState } from 'react'

type Weather = {
  tempC: number
  humidity: number
  code: number
  city: string
}

const CACHE_KEY = 'enzo.weather.widget'
const CACHE_TTL = 30 * 60 * 1000

// WMO weather interpretation codes → short human label
function describeWmo(code: number): string {
  if (code === 0) return 'clear sky'
  if (code === 1) return 'mainly clear'
  if (code === 2) return 'partly cloudy'
  if (code === 3) return 'overcast'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if (code >= 61 && code <= 67) return 'rain'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 80 && code <= 82) return 'rain showers'
  if (code === 85 || code === 86) return 'snow showers'
  if (code >= 95) return 'thunderstorm'
  return '…'
}

async function locateByIp(): Promise<{ lat: number; lon: number; city: string }> {
  // ipwho.is — numbers for lat/lon, { success } guard
  try {
    const geo = await fetch('https://ipwho.is/').then((r) => r.json())
    const lat = Number(geo?.latitude)
    const lon = Number(geo?.longitude)
    if (geo?.success && Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon, city: geo.city || geo.region || '' }
    }
  } catch {
    /* fall through to geojs */
  }
  // get.geojs.io — lat/lon arrive as strings
  const geo = await fetch('https://get.geojs.io/v1/ip/geo.json').then((r) => r.json())
  const lat = Number(geo?.latitude)
  const lon = Number(geo?.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('no geo')
  return { lat, lon, city: geo.city || geo.region || '' }
}

async function fetchWeather(): Promise<Weather> {
  const { lat, lon, city } = await locateByIp()
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,weather_code&timezone=auto'
  const data = await fetch(url).then((r) => r.json())
  const cur = data?.current
  if (!cur || !Number.isFinite(cur.temperature_2m)) throw new Error('no weather')
  return {
    tempC: cur.temperature_2m,
    humidity: cur.relative_humidity_2m ?? 0,
    code: cur.weather_code ?? 0,
    city,
  }
}

export function WeatherWidget() {
  const [wx, setWx] = useState<Weather | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false

    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null') as
        | { at: number; wx: Weather }
        | null
      if (cached && Date.now() - cached.at < CACHE_TTL) {
        setWx(cached.wx)
        return () => {
          cancelled = true
        }
      }
    } catch {
      /* bad cache entry — refetch */
    }

    fetchWeather()
      .then((data) => {
        if (cancelled) return
        setWx(data)
        setFailed(false)
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), wx: data }))
        } catch {
          /* storage full/unavailable — cache is best-effort */
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const temp = wx ? `${Math.round(wx.tempC)}°` : failed ? '—' : '…'

  return (
    <div
      title="Live weather · located by IP (Open-Meteo)"
      className="group relative h-48 w-28 cursor-pointer overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-4 font-mono-display text-white duration-300 backdrop-blur-xl transition-all shadow-[inset_0_1px_1px_rgba(255,255,255,0.2),0_10px_30px_rgba(0,0,0,0.35)] hover:w-56 hover:border-sky-400/30 hover:bg-sky-400/10 hover:shadow-[inset_0_1px_1px_rgba(255,255,255,0.32),0_0_28px_rgba(56,189,248,0.22)]"
    >
      <h3 className="text-center text-xl text-white/80">Today</h3>
      <div className="relative">
        <svg
          viewBox="0 0 64 64"
          xmlnsXlink="http://www.w3.org/1999/xlink"
          xmlns="http://www.w3.org/2000/svg"
          className="w-20 scale-[110%]"
        >
          <defs>
            <linearGradient
              gradientUnits="userSpaceOnUse"
              y2="28.33"
              y1="19.67"
              x2="21.5"
              x1="16.5"
              id="wx-b"
            >
              <stop stopColor="#fbbf24" offset={0} />
              <stop stopColor="#fbbf24" offset=".45" />
              <stop stopColor="#f59e0b" offset={1} />
            </linearGradient>
            <linearGradient
              gradientUnits="userSpaceOnUse"
              y2="50.8"
              y1="21.96"
              x2="39.2"
              x1="22.56"
              id="wx-c"
            >
              <stop stopColor="#f3f7fe" offset={0} />
              <stop stopColor="#f3f7fe" offset=".45" />
              <stop stopColor="#deeafb" offset={1} />
            </linearGradient>
            <linearGradient
              gradientUnits="userSpaceOnUse"
              y2="48.05"
              y1="42.95"
              x2="25.47"
              x1="22.53"
              id="wx-a"
            >
              <stop stopColor="#4286ee" offset={0} />
              <stop stopColor="#4286ee" offset=".45" />
              <stop stopColor="#0950bc" offset={1} />
            </linearGradient>
            <linearGradient
              xlinkHref="#wx-a"
              y2="48.05"
              y1="42.95"
              x2="32.47"
              x1="29.53"
              id="wx-d"
            />
            <linearGradient
              xlinkHref="#wx-a"
              y2="48.05"
              y1="42.95"
              x2="39.47"
              x1="36.53"
              id="wx-e"
            />
          </defs>
          <circle
            strokeWidth=".5"
            strokeMiterlimit={10}
            stroke="#f8af18"
            fill="url(#wx-b)"
            r={5}
            cy={24}
            cx={19}
          />
          <path
            d="M19 15.67V12.5m0 23v-3.17m5.89-14.22l2.24-2.24M10.87 32.13l2.24-2.24m0-11.78l-2.24-2.24m16.26 16.26l-2.24-2.24M7.5 24h3.17m19.83 0h-3.17"
            strokeWidth={2}
            strokeMiterlimit={10}
            strokeLinecap="round"
            stroke="#fbbf24"
            fill="none"
          >
            <animateTransform
              values="0 19 24; 360 19 24"
              type="rotate"
              repeatCount="indefinite"
              dur="45s"
              attributeName="transform"
            />
          </path>
          <path
            d="M46.5 31.5h-.32a10.49 10.49 0 00-19.11-8 7 7 0 00-10.57 6 7.21 7.21 0 00.1 1.14A7.5 7.5 0 0018 45.5a4.19 4.19 0 00.5 0v0h28a7 7 0 000-14z"
            strokeWidth=".5"
            strokeMiterlimit={10}
            stroke="#e6effc"
            fill="url(#wx-c)"
          />
          <path
            d="M24.39 43.03l-.78 4.94"
            strokeWidth={2}
            strokeMiterlimit={10}
            strokeLinecap="round"
            stroke="url(#wx-a)"
            fill="none"
          >
            <animateTransform
              values="1 -5; -2 10"
              type="translate"
              repeatCount="indefinite"
              dur="0.7s"
              attributeName="transform"
            />
          </path>
          <path
            d="M31.39 43.03l-.78 4.94"
            strokeWidth={2}
            strokeMiterlimit={10}
            strokeLinecap="round"
            stroke="url(#wx-d)"
            fill="none"
          >
            <animateTransform
              values="1 -5; -2 10"
              type="translate"
              repeatCount="indefinite"
              dur="0.7s"
              begin="-0.4s"
              attributeName="transform"
            />
          </path>
          <path
            d="M38.39 43.03l-.78 4.94"
            strokeWidth={2}
            strokeMiterlimit={10}
            strokeLinecap="round"
            stroke="url(#wx-e)"
            fill="none"
          >
            <animateTransform
              values="1 -5; -2 10"
              type="translate"
              repeatCount="indefinite"
              dur="0.7s"
              begin="-0.2s"
              attributeName="transform"
            />
          </path>
        </svg>
        <h4 className="absolute left-1/2 -translate-x-1/2 text-center font-garamond text-5xl font-light duration-300 group-hover:translate-x-8 group-hover:-translate-y-16 group-hover:scale-150">
          {temp}
        </h4>
      </div>
      <div className="absolute -left-32 mt-2 duration-300 group-hover:left-10">
        <p className="max-w-[110px] truncate text-sm text-white/70">
          {wx?.city || (failed ? 'no signal' : 'locating…')}
        </p>
        <p className="text-sm text-white/70">{wx ? describeWmo(wx.code) : '\u00a0'}</p>
        <p className="text-sm text-white/70">{wx ? `${wx.humidity}% humidity` : '\u00a0'}</p>
      </div>
    </div>
  )
}

export default WeatherWidget
