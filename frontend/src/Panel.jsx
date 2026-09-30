import React, { useMemo, useState } from 'react'
import { METRICS, FACTORS, NO_PRICE_LIMIT, rankRows, fmtMin, normalize } from './model'

function Search({ rows, onPick }) {
  const [q, setQ] = useState('')
  const hits = useMemo(() => {
    if (q.length < 2) return []
    const n = normalize(q)
    const seen = new Set()
    const out = []
    for (const r of rows) {
      if (!normalize(r.name).includes(n) && !normalize(r.muni).includes(n)) continue
      if (seen.has(r.mid + r.name)) continue
      seen.add(r.mid + r.name)
      out.push(r)
      if (out.length >= 8) break
    }
    return out
  }, [q, rows])
  return (
    <div className="search">
      <input type="text" placeholder="Find a place…" value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.length > 0 && (
        <div className="results">
          {hits.map((r) => (
            <div key={r.id} onClick={() => { onPick(r.id); setQ('') }}>
              {r.name}
              <small>{r.muni !== r.name ? `${r.muni} · ` : ''}{r.kt}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Detail({ r, anchor, settings, onClose, available }) {
  const metric = METRICS[settings.metric]
  const v = metric.get(r)
  const drivesToday = r.ptc == null || r.car <= r.ptc
  const why = !r.viable
    ? `Outside your ${settings.tolerance}-minute limit: the trip to ${anchor.name} still takes ~${Math.round(r.tAv)} minutes of effective time in a self-driving car.`
    : r.gain <= 0.5
    ? `Public transport to ${anchor.name} is already about as good as a self-driving car would feel here (${fmtMin(r.ptc)} effective vs ${fmtMin(r.tAv)}). Little to unlock.`
    : `Today the best way to ${anchor.name} is ${drivesToday ? `driving (${fmtMin(r.car)})` : `public transport (${fmtMin(r.pt)} door to door, ${fmtMin(r.ptc)} effective)`}. In a self-driving car the same ${fmtMin(r.car)} drive counts like ${fmtMin(r.tAv)} of usable time — an effective gain of ${fmtMin(r.gain)}. At the ${anchor.name} market's price gradient of −${anchor.pct_per_10min}% per 10 commute minutes that implies roughly +${r.uplift.toFixed(1)}%.`
  const factors = (available || FACTORS).filter((f) => !['sleeper', 'price', 'commute'].includes(f.key))
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>{r.name}</h3>
          <div className="sub">{r.muni !== r.name ? `${r.muni} · ` : ''}{r.kt}</div>
        </div>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="hero">{r.viable && v != null ? metric.fmt(v) : '—'}</div>
      <div className="hero-label">
        {metric.label}{metric.unit === '/100' ? ' score' : ''}
        {r.viable && (
          <>
            {settings.metric !== 'match' && r.match != null && ` · match ${Math.round(r.match)}`}
            {settings.metric !== 'sleeper' && r.sleeper != null && ` · value ${r.sleeper >= 0 ? '+' : ''}${r.sleeper.toFixed(0)}%`}
            {settings.metric !== 'uplift' && ` · AV uplift +${r.uplift.toFixed(1)}%`}
          </>
        )}
      </div>
      <div className="kv">
        <div><b>{r.price != null ? Math.round(r.price).toLocaleString('de-CH') : '—'}{r.src === 'interpolated' && <span className="est"> est.</span>}</b><span>CHF/m² today</span></div>
        <div><b>{r.fairNow != null ? Math.round(r.fairNow).toLocaleString('de-CH') : '—'}</b><span>fair value today</span></div>
        <div><b>{r.fairPost != null ? Math.round(r.fairPost).toLocaleString('de-CH') : '—'}</b><span>fair value after AV</span></div>
        <div><b>{fmtMin(r.car)}</b><span>car today</span></div>
        <div><b>{fmtMin(r.pt)}</b><span>PT door to door</span></div>
        <div><b>{fmtMin(r.tAv)}</b><span>feels like, in AV</span></div>
      </div>
      <div className="kv">
        {factors.map((f) => {
          const fv = f.get(r)
          return (
            <div key={f.key}><b>{fv != null ? f.fmt(fv) : '—'}</b><span>{f.short || f.label.split(' —')[0].toLowerCase()}</span></div>
          )
        })}
      </div>
      <div className="why">
        {why}
        {r.viable && r.fairNow != null && r.src !== 'interpolated' && (
          <> Today it trades {Math.abs((r.price / r.fairNow - 1) * 100).toFixed(0)}% {r.price < r.fairNow ? 'below' : 'above'} what places with the same commute, tax, setting and canton typically cost.</>
        )}
      </div>
    </div>
  )
}

export default function Panel({ data, rows, settings, setSettings, selectedId, setSelectedId, setHighlightId }) {
  const set = (patch) => setSettings((s) => ({ ...s, ...patch }))
  const setWeight = (key, w) => setSettings((s) => ({ ...s, weights: { ...s.weights, [key]: w } }))
  const metric = METRICS[settings.metric]
  const anchor = data?.anchors[settings.anchor]
  const ranked = useMemo(() => rankRows(rows, settings.metric), [rows, settings.metric])
  const selected = selectedId ? rows.find((r) => r.id === selectedId) : null
  const viableCount = useMemo(() => rows.filter((r) => r.viable).length, [rows])
  const available = useMemo(() => {
    const cov = data?.meta?.factor_coverage || {}
    return FACTORS.filter((f) => !(f.key === 'grow' && !cov.grow) && !(f.key === 'lake' && !cov.lake) && !(f.key === 'elev' && !cov.elev)
      && !(f.key === 'quiet' && !(cov.mw && cov.air)) && !(f.key === 'access' && !cov.mwj))
  }, [data])

  return (
    <div className="panel">
      <div className="panel-header">
        <h1>Sleeper Towns</h1>
        <p>Where self-driving cars wake up Swiss property values.</p>
        <p className="how">
          Pick where you commute to and what matters to you. We find places that are cheap today because
          the drive is long-ish and public transport is weak — the commute a self-driving car turns into
          usable time — and rank them by your priorities.
        </p>
      </div>

      {data && (
        <>
          <div className="field">
            <label>I commute to</label>
            <select value={settings.anchor} onChange={(e) => { set({ anchor: e.target.value }); setSelectedId(null) }}>
              {Object.entries(data.anchors).map(([id, a]) => (
                <option key={id} value={id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Max commute in a self-driving car <b>{settings.tolerance} min</b></label>
            <input type="range" min="20" max="90" step="5" value={settings.tolerance} onChange={(e) => set({ tolerance: +e.target.value })} />
          </div>

          <div className="field">
            <label>Max price <b>{settings.maxPrice >= NO_PRICE_LIMIT ? 'any' : `${settings.maxPrice.toLocaleString('de-CH')} CHF/m²`}</b></label>
            <input type="range" min="3000" max={NO_PRICE_LIMIT} step="500" value={settings.maxPrice} onChange={(e) => set({ maxPrice: +e.target.value })} />
          </div>

          <div className="field">
            <label>What matters to you <span className="muted">0 = ignore · 5 = essential</span></label>
            <div className="weights">
              {available.map((f) => (
                <div key={f.key} className="weight">
                  <span>{f.label}</span>
                  <input type="range" min="0" max="5" step="1" value={settings.weights?.[f.key] ?? 0} onChange={(e) => setWeight(f.key, +e.target.value)} />
                  <b>{settings.weights?.[f.key] ?? 0}</b>
                </div>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Color & rank by</label>
            <div className="seg">
              {Object.entries(METRICS).map(([k, m]) => (
                <button key={k} className={settings.metric === k ? 'on' : ''} onClick={() => set({ metric: k })}>{m.label}</button>
              ))}
            </div>
            <span className="muted">{metric.desc}</span>
          </div>

          <Search rows={rows} onPick={setSelectedId} />

          {selected && anchor && (
            <Detail r={selected} anchor={anchor} settings={settings} available={available} onClose={() => setSelectedId(null)} />
          )}

          <div>
            <h2>Top {ranked.length} sleeper towns · {metric.label}</h2>
            <div className="list" onMouseLeave={() => setHighlightId(null)}>
              {ranked.map((r, i) => (
                <div
                  key={r.id}
                  className={`row${r.id === selectedId ? ' on' : ''}`}
                  onClick={() => setSelectedId(r.id)}
                  onMouseEnter={() => setHighlightId(r.id)}
                >
                  <span className="rank">{i + 1}</span>
                  <span className="name">{r.name}{r.muni !== r.name && <small>{r.muni}</small>}</span>
                  <span className="kt">{r.kt}</span>
                  <span className="price">{r.price != null ? Math.round(r.price).toLocaleString('de-CH') : '—'}{r.src === 'interpolated' && <span className="est"> est</span>}</span>
                  <span className="val">{metric.fmt(metric.get(r))}</span>
                </div>
              ))}
              {ranked.length === 0 && <p className="muted">Nothing within these limits — raise the commute or price limit.</p>}
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              {viableCount.toLocaleString()} of {rows.length.toLocaleString()} settlements within limits · one entry per municipality
            </p>
          </div>

          <details className="expander">
            <summary>Assumptions & method</summary>
            <div className="body">
              <div className="field">
                <label>60 min in a self-driving car feels like <b>{Math.round(60 * settings.avFactor)} min of driving</b></label>
                <input type="range" min="18" max="60" value={Math.round(60 * settings.avFactor)} onChange={(e) => set({ avFactor: +e.target.value / 60 })} />
              </div>
              <div className="field">
                <label>60 min on the train feels like <b>{Math.round(60 * settings.ptFactor)} min of driving</b></label>
                <input type="range" min="18" max="60" value={Math.round(60 * settings.ptFactor)} onChange={(e) => set({ ptFactor: +e.target.value / 60 })} />
                <span>Applies to in-vehicle time only; walking and waiting count in full.</span>
              </div>
              {anchor && (
                <p>
                  <b>Price gradient to {anchor.name}:</b> −{anchor.pct_per_10min}% per 10 minutes of effective commute,
                  measured on {anchor.n} municipalities with market prices (within-canton hedonic fit with tax, elevation,
                  lake / motorway / airport distance and population growth as controls{anchor.r2 != null ? `, R² ${anchor.r2}` : ''}).
                  {!anchor.fitted && ' The local fit was not robust, so the Zürich gradient is used as a fallback.'}
                </p>
              )}
              <p>
                <b>Match.</b> Each weighted factor is turned into a percentile among the places within your limits (missing data
                counts as neutral) and averaged with your weights. <b>Value</b> is the discount to the post-AV fair value; it
                already nets out what the place "should" cost for its commute, tax and setting, so the remaining gap is either
                mispricing or something the data cannot see — check the place yourself.
              </p>
              <p>
                <b>Data.</b> Car times: Google routing. PT: SBB timetable, Monday 07:00 departures, door to door. Prices: Neho
                hedonic estimates and Homegate listing medians per municipality ("est." = interpolated, excluded from Value).
                Tax: ESTV. Elevation: swisstopo. Lakes, motorways, junctions: OpenStreetMap. Population: BFS.{' '}
                <a href="https://github.com/Kaiman22/sleeper-towns" target="_blank" rel="noreferrer">Methodology & source</a>
              </p>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
