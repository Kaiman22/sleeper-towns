// Sleeper Towns — the whole model in one place.
//
// Per settlement and anchor city we know three raw numbers: car minutes, PT
// door-to-door minutes and PT in-vehicle minutes. From these:
//
//   ptComfort = ivt × ptFactor + (walk + wait)        usable time on the train counts less
//   tNow      = min(car, ptComfort)                    today's best effective commute
//   tAv       = car × avFactor                         the same drive in a self-driving car
//   gain      = max(0, tNow − min(tAv, ptComfort))     effective minutes AV takes off the commute
//   uplift    = exp(|beta| × gain) − 1                 translated with the anchor's measured
//                                                      price gradient (d log price / minute)
//
// A settlement is "viable" when the AV trip stays within the user's commute limit.
// Remote places with huge raw savings but no commutable destination are simply
// filtered out — savings nobody can use never capitalize into property value.

export const METRICS = {
  sleeper: {
    label: 'Sleeper Score',
    unit: '%',
    desc: "How far below its post-AV fair value the place trades today: fair value from the market fit × AV uplift ÷ today's price. Cheap for its future access.",
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
  gain_chf: {
    label: 'Uplift CHF/m²',
    unit: 'CHF/m²',
    desc: "Expected uplift in CHF per m² (uplift % × today's price).",
    higherIsBetter: true,
    fmt: (v) => `+${Math.round(v).toLocaleString('de-CH')}`,
    get: (r) => r.gainChf,
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

export const DEFAULTS = {
  anchor: 'zurich',
  tolerance: 45,   // max acceptable AV commute (min)
  maxPrice: 20000, // >= 20000 means "no limit"
  avFactor: 0.65,  // 60 min in an AV feels like 39 min of driving
  ptFactor: 0.9,   // in-vehicle PT time feels like 90% of driving
  metric: 'sleeper',
}

export const NO_PRICE_LIMIT = 20000

export function computeRows(data, s) {
  const anchor = data.anchors[s.anchor]
  if (!anchor) return []
  const beta = Math.abs(anchor.beta)
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
    // Hedonic fair value today (what places with this commute, tax and canton cost),
    // lifted by the AV uplift → post-AV fair value. Sleeper = discount to that value.
    // Interpolated prices are excluded: a lakeside town priced from its cheaper
    // neighbours would show a phantom discount.
    let fairNow = null, fairPost = null, sleeper = null
    const fit = anchor.fit
    if (fit && p.price != null && p.tax != null) {
      const pred = fit.alpha + fit.beta * tNow + fit.gamma * p.tax + (fit.fe[p.kt] ?? 0)
      fairNow = Math.exp(pred)
      fairPost = fairNow * (1 + uplift / 100)
      if (p.src !== 'interpolated') sleeper = (fairPost / p.price - 1) * 100
    }
    const viable =
      tAv <= s.tolerance &&
      (s.maxPrice >= NO_PRICE_LIMIT || (p.price != null && p.price <= s.maxPrice))
    rows.push({ ...p, car, pt, ptc: Number.isFinite(ptc) ? ptc : null, tAv, tNow, gain, uplift, gainChf, fairNow, fairPost, sleeper, viable })
  }
  return rows
}

// Quantile bounds over viable rows with a value — drives color stops and legend.
export function computeBounds(rows, metricKey) {
  const get = METRICS[metricKey].get
  const vals = rows.filter((r) => r.viable).map(get).filter((v) => v != null).sort((a, b) => a - b)
  if (vals.length < 5) return null
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor((vals.length * p) / 100))]
  return { p10: q(10), p25: q(25), p50: q(50), p75: q(75), p90: q(90), n: vals.length }
}

// Ranked list: best settlement per municipality, sorted by the active metric.
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
  good: ['#3b2d6b', '#1f6f8b', '#3fbf8f', '#f3e96b'], // low → high, higher is better
  price: ['#3fbf8f', '#f3e96b', '#f08a4b', '#e94560'], // cheap → expensive
}

export function paletteFor(metricKey) {
  return METRICS[metricKey].higherIsBetter ? PALETTES.good : PALETTES.price
}

export function colorStops(bounds, metricKey) {
  const pal = paletteFor(metricKey)
  const stops = [
    [bounds.p10, pal[0]],
    [bounds.p25, pal[1]],
    [bounds.p75, pal[2]],
    [bounds.p90, pal[3]],
  ]
  return stops.filter((s, i) => i === 0 || s[0] > stops[i - 1][0])
}

export const fmtMin = (v) => (v == null ? '—' : `${Math.round(v)} min`)
export const fmtChf = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString('de-CH')} CHF/m²`)
export const normalize = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
