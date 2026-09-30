// Sleeper Towns — the whole model in one place.
//
// Per settlement and anchor city we know three raw numbers: car minutes, PT
// door-to-door minutes and PT in-vehicle minutes. From these:
//
//   ptComfort = ivt × ptFactor + (walk + wait)        usable time on the train counts less
//   tNow      = min(car, ptComfort)                    today's best effective commute
//   tAv       = car × avFactor                         the same drive in a self-driving car
//   gain      = max(0, tNow − min(tAv, ptComfort))     effective minutes AV takes off the commute
//   uplift    = exp(|beta| × gain) − 1                 the anchor's measured price gradient
//   fairNow   = hedonic fair value (commute, tax, attractiveness controls, canton)
//   sleeper   = fairNow × (1 + uplift) / price − 1     discount to post-AV fair value
//   match     = weighted percentile score over the factors the user cares about
//
// A settlement is "viable" when the AV trip stays within the user's commute limit.

// Hedonic control transforms — must mirror FEATURES in data/scripts/07_build_sleeper_data.py
export const FEATURES = {
  tax: (r) => r.tax,
  elev: (r) => (r.elev != null ? r.elev / 1000 : null),
  lake: (r) => (r.lake != null ? Math.log1p(r.lake) : null),
  mwj: (r) => (r.mwj != null ? Math.log1p(r.mwj) : null),
  mw_near: (r) => (r.mw != null ? Math.max(0, 1 - r.mw) : null),
  air_near: (r) => (r.air != null ? Math.max(0, 8 - r.air) / 8 : null),
  grow: (r) => r.grow,
}

// What the user can weight. dir: +1 = higher is better, −1 = lower is better.
export const FACTORS = [
  { key: 'sleeper', label: 'Value — discount to post-AV fair value', dir: 1, get: (r) => r.sleeper, fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%` },
  { key: 'price', label: 'Low price today', dir: -1, get: (r) => r.price, fmt: (v) => `${Math.round(v).toLocaleString('de-CH')} CHF/m²` },
  { key: 'commute', label: 'Short commute (in a self-driving car)', dir: -1, get: (r) => r.tAv, fmt: (v) => `${Math.round(v)} min` },
  { key: 'tax', label: 'Low taxes', dir: -1, get: (r) => r.tax, fmt: (v) => `${v}%` },
  { key: 'lake', label: 'Close to a lake', dir: -1, get: (r) => r.lake, fmt: (v) => `${v.toFixed(1)} km` },
  { key: 'elev', label: 'High up — sun, above the fog', dir: 1, get: (r) => r.elev, fmt: (v) => `${Math.round(v)} m` },
  { key: 'quiet', label: 'Quiet — away from motorway & airport', dir: 1, get: (r) => (r.mw != null && r.air != null ? Math.min(r.mw, r.air / 5) : null), fmt: (v) => `${v.toFixed(1)} km` },
  { key: 'access', label: 'Near a motorway junction (early AV service)', dir: -1, get: (r) => r.mwj, fmt: (v) => `${v.toFixed(1)} km` },
  { key: 'grow', label: 'Growing population (2013–23)', dir: 1, get: (r) => r.grow, fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` },
]

export const DEFAULT_WEIGHTS = { sleeper: 3, price: 2, commute: 2, tax: 1, lake: 1, elev: 1, quiet: 1, access: 0, grow: 0 }

export const METRICS = {
  match: {
    label: 'Match',
    unit: '/100',
    desc: 'Weighted percentile score across the factors you care about (adjust below). 100 = best in every factor you weighted.',
    higherIsBetter: true,
    fmt: (v) => `${Math.round(v)}`,
    get: (r) => r.match,
  },
  sleeper: {
    label: 'Value',
    unit: '%',
    desc: "Sleeper Score: how far below its post-AV fair value the place trades today (fair value from the market fit × AV uplift ÷ today's price).",
    higherIsBetter: true,
    fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`,
    get: (r) => r.sleeper,
  },
  uplift: {
    label: 'AV uplift',
    unit: '%',
    desc: 'Expected relative price uplift once commuting in self-driving cars is mainstream.',
    higherIsBetter: true,
    fmt: (v) => `+${v.toFixed(1)}%`,
    get: (r) => r.uplift,
  },
  price: {
    label: 'Price',
    unit: 'CHF/m²',
    desc: "Today's asking price per m². Lower is better.",
    higherIsBetter: false,
    fmt: (v) => Math.round(v).toLocaleString('de-CH'),
    get: (r) => r.price,
  },
}

export const NO_PRICE_LIMIT = 20000

export const DEFAULTS = {
  anchor: 'zurich',
  tolerance: 45,
  maxPrice: NO_PRICE_LIMIT,
  avFactor: 0.65,
  ptFactor: 0.9,
  metric: 'match',
  weights: DEFAULT_WEIGHTS,
}

export function computeRows(data, s) {
  const anchor = data.anchors[s.anchor]
  if (!anchor) return []
  const beta = Math.abs(anchor.beta)
  const fit = anchor.fit
  const rows = []
  for (const p of data.settlements) {
    const t = p.t[s.anchor]
    if (!t) continue
    const car = t[0] / 60
    const pt = t[1] != null ? t[1] / 60 : null
    const ivt = t[2] != null ? t[2] / 60 : null
    let ptc = Infinity
    if (pt != null) ptc = ivt != null ? ivt * s.ptFactor + (pt - ivt) : pt * s.ptFactor
    const tAv = car * s.avFactor
    const tNow = Math.min(car, ptc)
    const gain = Math.max(0, tNow - Math.min(tAv, ptc))
    const uplift = (Math.exp(beta * gain) - 1) * 100
    const gainChf = p.price != null ? (p.price * uplift) / 100 : null

    let fairNow = null, fairPost = null, sleeper = null
    if (fit && p.price != null && p.tax != null) {
      let pred = fit.alpha + fit.beta * tNow + (fit.fe[p.kt] ?? 0)
      for (const [k, c] of Object.entries(fit.coefs)) {
        const v = FEATURES[k] ? FEATURES[k](p) : null
        pred += c * (v != null ? v : fit.medians[k] ?? 0)
      }
      fairNow = Math.exp(pred)
      fairPost = fairNow * (1 + uplift / 100)
      // interpolated prices inherit their neighbours' level → phantom discounts; excluded
      if (p.src !== 'interpolated') sleeper = (fairPost / p.price - 1) * 100
    }
    const viable =
      tAv <= s.tolerance &&
      (s.maxPrice >= NO_PRICE_LIMIT || (p.price != null && p.price <= s.maxPrice))
    rows.push({ ...p, car, pt, ptc: Number.isFinite(ptc) ? ptc : null, tAv, tNow, gain, uplift, gainChf, fairNow, fairPost, sleeper, viable, match: null })
  }
  computeMatch(rows, s.weights || DEFAULT_WEIGHTS)
  return rows
}

// Percentile rank (0..100) within the viable set; missing values are neutral (50).
function computeMatch(rows, weights) {
  const viable = rows.filter((r) => r.viable)
  const active = FACTORS.filter((f) => (weights[f.key] || 0) > 0)
  const totalW = active.reduce((a, f) => a + weights[f.key], 0)
  if (!viable.length || totalW === 0) return
  const acc = new Float64Array(viable.length)
  for (const f of active) {
    const vals = viable.map(f.get)
    const sorted = vals.filter((v) => v != null).sort((a, b) => a - b)
    const n = sorted.length
    const w = weights[f.key]
    vals.forEach((v, i) => {
      let pct = 50
      if (v != null && n > 1) {
        let lo = 0, hi = n
        while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid }
        pct = (lo / (n - 1)) * 100
        if (f.dir < 0) pct = 100 - pct
      }
      acc[i] += w * pct
    })
  }
  viable.forEach((r, i) => { r.match = acc[i] / totalW })
}

export function computeBounds(rows, metricKey) {
  const get = METRICS[metricKey].get
  const vals = rows.filter((r) => r.viable).map(get).filter((v) => v != null).sort((a, b) => a - b)
  if (vals.length < 5) return null
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor((vals.length * p) / 100))]
  return { p10: q(10), p25: q(25), p50: q(50), p75: q(75), p90: q(90), n: vals.length }
}

export function rankRows(rows, metricKey, limit = 15) {
  const m = METRICS[metricKey]
  const best = new Map()
  for (const r of rows) {
    if (!r.viable) continue
    const v = m.get(r)
    if (v == null) continue
    const cur = best.get(r.mid)
    if (!cur || (m.higherIsBetter ? v > m.get(cur) : v < m.get(cur))) best.set(r.mid, r)
  }
  return [...best.values()]
    .sort((a, b) => (m.higherIsBetter ? m.get(b) - m.get(a) : m.get(a) - m.get(b)))
    .slice(0, limit)
}

export const PALETTES = {
  good: ['#3b2d6b', '#1f6f8b', '#3fbf8f', '#f3e96b'],
  price: ['#3fbf8f', '#f3e96b', '#f08a4b', '#e94560'],
}
export function paletteFor(metricKey) {
  return METRICS[metricKey].higherIsBetter ? PALETTES.good : PALETTES.price
}
export function colorStops(bounds, metricKey) {
  const pal = paletteFor(metricKey)
  const stops = [[bounds.p10, pal[0]], [bounds.p25, pal[1]], [bounds.p75, pal[2]], [bounds.p90, pal[3]]]
  return stops.filter((s, i) => i === 0 || s[0] > stops[i - 1][0])
}

export const fmtMin = (v) => (v == null ? '—' : `${Math.round(v)} min`)
export const normalize = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
