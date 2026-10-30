import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import { DEFAULTS, LIMITS, TODAY, FLIP, FAR, computeResults } from './model'

const DATA_URL = './data/commute.json'
const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const CH_BOUNDS = [[5.95, 45.82], [10.49, 47.81]]

const TODAY_COLOR = '#1d5fd1' // commutable today
const FLIP_COLOR = '#f26b00'  // becomes commutable with a self-driving car
const FAR_COLOR = '#c4bfb8'   // out of range

function normalize(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function fmtMin(m, none = 'keine Verbindung') {
  if (m == null) return none
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

function fmtFactor(k) {
  return k.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function clamp(v, [lo, hi]) {
  return Math.min(hi, Math.max(lo, v))
}

function readUrl() {
  try {
    const q = new URLSearchParams(window.location.search)
    const s = {}
    if (q.get('to')) s.dest = q.get('to')
    const max = parseInt(q.get('max'), 10)
    if (!Number.isNaN(max)) s.threshold = clamp(max, LIMITS.threshold)
    const k = parseFloat(q.get('k'))
    if (!Number.isNaN(k)) s.comfort = clamp(Math.round(k * 10) / 10, LIMITS.comfort)
    if (q.get('av') === '0') s.av = false
    return s
  } catch {
    return {}
  }
}

function writeUrl(s) {
  try {
    const q = new URLSearchParams()
    if (s.dest !== DEFAULTS.dest) q.set('to', s.dest)
    if (s.threshold !== DEFAULTS.threshold) q.set('max', String(s.threshold))
    if (s.comfort !== DEFAULTS.comfort) q.set('k', String(s.comfort))
    if (s.av !== DEFAULTS.av) q.set('av', '0')
    const str = q.toString()
    window.history.replaceState(null, '', str ? `?${str}` : window.location.pathname)
  } catch {
    /* ignore */
  }
}

// Paint for the place dots. In the "today" view flipped places look exactly like
// out-of-range ones, so toggling the switch is what reveals them.
function dotColor(av) {
  return ['match', ['get', 'cat'], TODAY, TODAY_COLOR, FLIP, av ? FLIP_COLOR : FAR_COLOR, FAR_COLOR]
}
function dotOpacity(av) {
  return ['match', ['get', 'cat'], TODAY, 0.9, FLIP, av ? 0.95 : 0.5, 0.5]
}
function dotRadius(av) {
  const r = (base, big) => ['match', ['get', 'cat'], FLIP, av ? big : base, base]
  return ['interpolate', ['linear'], ['zoom'], 6, r(2.2, 3.2), 8, r(4.5, 6), 10, r(8, 10), 12, r(13, 15)]
}

// av = false describes the map as it looks today, where flipped places are still out of range
function verdict(r, threshold, av = true) {
  if (r.cat === TODAY) return 'Heute schon pendelbar'
  if (!av) return `Heute zu weit (über ${threshold} min)`
  if (r.cat === FLIP) return 'Kippt: autonom pendelbar'
  return r.car == null ? 'Autofrei, bleibt zu weit' : `Auch autonom über ${threshold} min`
}

// "Wengen (Lauterbrunnen)" when the settlement is not the municipality's namesake
function placeName(p) {
  return p.n === p.m ? p.n : `${p.n} (${p.m})`
}

export default function App() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [settings, setSettings] = useState(() => ({ ...DEFAULTS, ...readUrl() }))
  const [query, setQuery] = useState('')
  const [hovered, setHovered] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [highlightId, setHighlightId] = useState(null)
  const containerRef = useRef(null)
  const panelRef = useRef(null)
  const mapRef = useRef(null)
  const [mapReady, setMapReady] = useState(false)
  const fittedDest = useRef(null)

  const set = useCallback((patch) => setSettings((s) => ({ ...s, ...patch })), [])

  useEffect(() => {
    fetch(DATA_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        d.places.forEach((p, i) => { p.id = i })
        setData(d)
        if (!d.hubs.some((h) => h.id === settings.dest)) set({ dest: DEFAULTS.dest })
      })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => writeUrl(settings), 250)
    return () => clearTimeout(t)
  }, [settings])

  const dest = data?.hubs.find((h) => h.id === settings.dest) || null

  const { threshold, comfort, av } = settings
  const results = useMemo(() => {
    if (!data || !dest) return null
    return computeResults(data.places, data.car[dest.id], data.pt[dest.id], { threshold, comfort })
  }, [data, dest, threshold, comfort])

  // Init map
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP,
      bounds: CH_BOUNDS,
      minZoom: 5.5,
      maxZoom: 12,
      attributionControl: false,
    })
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    mapRef.current = map
    map.on('load', () => {
      map.resize() // container may have been sized after map construction
      // Keep Switzerland clear of the panel: beside it on desktop, below it on phones
      const panel = panelRef.current?.getBoundingClientRect()
      const wide = window.innerWidth > 700
      const padding = wide
        ? { left: (panel?.right || 0) + 20, top: 30, right: 30, bottom: 70 }
        : { left: 10, top: (panel?.bottom || 0) + 10, right: 10, bottom: 60 }
      // Padding first: fitBounds fits into the padded viewport, and later eases stay centred in it
      map.setPadding(padding)
      map.fitBounds(CH_BOUNDS, { duration: 0 })
      setMapReady(true)
    })
    requestAnimationFrame(() => map.resize())
    return () => map.remove()
  }, [])

  // Place layer: create once, then push new data on every recompute
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !data || !dest) return

    const features = data.places.map((p) => {
      const cat = results?.rows[p.id]?.cat || 0
      return {
        type: 'Feature',
        properties: { id: p.id, cat, z: cat === FLIP ? 3 : cat === TODAY ? 2 : 1 },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      }
    })
    const fc = { type: 'FeatureCollection', features }
    const destFc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [dest.lon, dest.lat] } }],
    }

    if (map.getSource('places')) {
      map.getSource('places').setData(fc)
      map.getSource('dest').setData(destFc)
      return
    }

    map.addSource('places', { type: 'geojson', data: fc })
    map.addSource('dest', { type: 'geojson', data: destFc })
    map.addLayer({
      id: 'places-dots',
      type: 'circle',
      source: 'places',
      layout: { 'circle-sort-key': ['get', 'z'] },
      paint: {
        'circle-radius': dotRadius(av),
        'circle-color': dotColor(av),
        'circle-opacity': dotOpacity(av),
        'circle-stroke-width': 0.5,
        'circle-stroke-color': 'rgba(255,255,255,0.85)',
      },
    })
    map.addLayer({
      id: 'places-ring',
      type: 'circle',
      source: 'places',
      filter: ['in', ['get', 'id'], ['literal', []]],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 7, 10, 14, 12, 20],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#111',
      },
    })
    map.addLayer({
      id: 'dest',
      type: 'circle',
      source: 'dest',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 6, 10, 14],
        'circle-color': '#111',
        'circle-stroke-width': 3,
        'circle-stroke-color': '#fff',
      },
    })

    map.on('mousemove', 'places-dots', (e) => {
      map.getCanvas().style.cursor = 'pointer'
      if (e.features?.length) setHovered({ id: e.features[0].properties.id, x: e.point.x, y: e.point.y })
    })
    map.on('mouseleave', 'places-dots', () => {
      map.getCanvas().style.cursor = ''
      setHovered(null)
    })
    map.on('click', (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ['places-dots'] })
      setSelectedId(f.length ? f[0].properties.id : null)
      setHovered(null) // touch devices never send mouseleave
    })
  }, [mapReady, data, results, dest])

  // The switch: today vs. with a self-driving car
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !map.getLayer('places-dots')) return
    map.setPaintProperty('places-dots', 'circle-color', dotColor(av))
    map.setPaintProperty('places-dots', 'circle-opacity', dotOpacity(av))
    map.setPaintProperty('places-dots', 'circle-radius', dotRadius(av))
  }, [av, mapReady, results])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !map.getLayer('places-ring')) return
    const ids = [selectedId, highlightId].filter((v) => v != null)
    map.setFilter('places-ring', ['in', ['get', 'id'], ['literal', ids]])
  }, [selectedId, highlightId, mapReady, results])

  // Zoom to the commuter belt (today + flipped) once per destination; slider moves keep the view
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !results || !dest || fittedDest.current === dest.id) return
    const first = fittedDest.current == null
    fittedDest.current = dest.id
    let w = dest.lon, e = dest.lon, s = dest.lat, n = dest.lat
    for (const p of data.places) {
      const r = results.rows[p.id]
      if (!r || r.cat === FAR) continue
      w = Math.min(w, p.lon); e = Math.max(e, p.lon)
      s = Math.min(s, p.lat); n = Math.max(n, p.lat)
    }
    map.fitBounds([[w, s], [e, n]], { padding: 30, maxZoom: 9.5, duration: first ? 0 : 800 })
  }, [results, mapReady, dest, data])

  const chooseDest = useCallback((id) => {
    set({ dest: id })
    setSelectedId(null)
    setHovered(null)
  }, [set])

  const focusPlace = useCallback((p) => {
    setSelectedId(p.id)
    setQuery('')
    const map = mapRef.current
    if (map) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 9), duration: 700 })
  }, [])

  // Search settlements and municipalities, incl. other-language names (Coira, Sitten, ...)
  const searchResults = useMemo(() => {
    if (!data || query.length < 2) return []
    const q = normalize(query)
    const starts = []
    const contains = []
    for (const p of data.places) {
      const names = [p.n, p.m, ...(p.alt || [])].map(normalize)
      if (names.some((n) => n.startsWith(q))) starts.push(p)
      else if (names.some((n) => n.includes(q))) contains.push(p)
    }
    starts.sort((a, b) => b.pc - a.pc)
    return [...starts, ...contains].slice(0, 8)
  }, [data, query])

  const stats = results?.stats
  const hoverRow = hovered && results?.rows[hovered.id]
  const hoverPlace = hovered && data?.places[hovered.id]
  const sel = selectedId != null && data?.places[selectedId]
  const selRow = selectedId != null && results?.rows[selectedId]

  return (
    <div className="app">
      <div ref={containerRef} className="map" />

      <div ref={panelRef} className="card panel">
        <h1>Sleeper Towns</h1>
        <p className="tagline">Welche Orte macht das selbstfahrende Auto pendelbar?</p>

        <div className="field-label">Ziel</div>
        <div className="chips">
          {data?.hubs.map((h) => (
            <button
              key={h.id}
              className={`chip${dest?.id === h.id ? ' active' : ''}`}
              onClick={() => chooseDest(h.id)}
            >
              {h.n}
            </button>
          ))}
        </div>

        <button
          role="switch"
          aria-checked={av}
          className={`av-switch${av ? ' on' : ''}`}
          onClick={() => set({ av: !av })}
        >
          <span className="track"><span className="thumb" /></span>
          <span className="av-label">
            mit autonomem Auto
            <span className="av-state">{av ? 'Karte zeigt: morgen' : 'Karte zeigt: heute'}</span>
          </span>
        </button>

        <div className="stats">
          {!stats && <div className="muted">{error ? `Daten nicht geladen: ${error}` : 'Lade Reisezeiten…'}</div>}
          {stats && (
            <>
              <div className="stat">
                <span className="dot" style={{ background: TODAY_COLOR }} />
                <span className="stat-label">Heute pendelbar</span>
                <span className="stat-n">{stats[TODAY]}</span>
              </div>
              <div className={`stat flip${av ? '' : ' off'}`}>
                <span className="dot" style={{ background: FLIP_COLOR }} />
                <span className="stat-label">Kippen: neu pendelbar</span>
                <span className="stat-n">+{stats[FLIP]}</span>
              </div>
              <div className="stat-note">
                Ortschaften mit effektiv höchstens {threshold} min bis {dest?.station}
                {stats[TODAY] > 0 && (
                  <> · mit autonomem Auto {stats[TODAY] + stats[FLIP]}{' '}
                    ({fmtFactor((stats[TODAY] + stats[FLIP]) / stats[TODAY])}× so viele)</>
                )}
              </div>
            </>
          )}
        </div>

        <div className="searchbox">
          <input
            type="text"
            placeholder="Ort suchen…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && searchResults.length > 0 && focusPlace(searchResults[0])}
          />
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((p) => (
                <div key={p.id} className="search-result" onClick={() => focusPlace(p)}>
                  {placeName(p)} <span className="kt">{p.kt}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {sel && (
          <div className="detail">
            <button className="close" onClick={() => setSelectedId(null)} aria-label="Schliessen">×</button>
            <div className="detail-name">
              {placeName(sel)} <span className="kt">{sel.kt}</span>
            </div>
            <div className="detail-sub">Ortschaft mit {data.pop[sel.pc]} Einw. · nach {dest?.station}</div>
            {selRow ? (
              <>
                <div className={`detail-verdict c${selRow.cat}`}>{verdict(selRow, threshold)}</div>
                <table className="detail-times">
                  <tbody>
                    <tr><td>Auto</td><td>{fmtMin(selRow.car, 'autofrei')}</td></tr>
                    <tr><td>ÖV</td><td>{fmtMin(selRow.pt)}</td></tr>
                    <tr className="best">
                      <td>Heute (beste Option)</td>
                      <td>{fmtMin(selRow.today)} · {selRow.todayMode === 'pt' ? 'ÖV' : 'Auto'}</td>
                    </tr>
                    {selRow.car != null && (
                      <tr>
                        <td>Autonom ({fmtMin(selRow.car)} ÷ {fmtFactor(comfort)})</td>
                        <td>{fmtMin(selRow.av)}</td>
                      </tr>
                    )}
                    <tr className="best">
                      <td>Morgen (beste Option)</td>
                      <td>{fmtMin(selRow.tomorrow)} · {selRow.tomorrowMode === 'pt' ? 'ÖV' : 'autonom'}</td>
                    </tr>
                  </tbody>
                </table>
              </>
            ) : (
              <div className="muted">Keine Reisezeit verfügbar.</div>
            )}
          </div>
        )}

        <div className="slider">
          <div className="slider-head">
            <span>Pendelschwelle</span>
            <strong>{threshold} min</strong>
          </div>
          <input
            type="range"
            min={LIMITS.threshold[0]}
            max={LIMITS.threshold[1]}
            step={LIMITS.threshold[2]}
            value={threshold}
            onChange={(e) => set({ threshold: Number(e.target.value) })}
          />
          <div className="hint">Effektive Reisezeit, ab der Pendeln nicht mehr in Frage kommt.</div>
        </div>
        <div className="slider">
          <div className="slider-head">
            <span>Komfortfaktor autonom</span>
            <strong>{fmtFactor(comfort)}</strong>
          </div>
          <input
            type="range"
            min={LIMITS.comfort[0]}
            max={LIMITS.comfort[1]}
            step={LIMITS.comfort[2]}
            value={comfort}
            onChange={(e) => set({ comfort: Math.round(Number(e.target.value) * 10) / 10 })}
          />
          <div className="hint">
            Autozeit ÷ {fmtFactor(comfort)}: 60 min im autonomen Auto zählen wie {Math.round(60 / comfort)} min am
            Steuer — man kann lesen, arbeiten oder schlafen.
          </div>
        </div>

        {results && results.flips.length > 0 && (
          <details className="flip-list">
            <summary>Gekippte Orte ({results.flips.length}), grösste zuerst</summary>
            <div className="flip-rows">
              {results.flips.map((p) => {
                const r = results.rows[p.id]
                return (
                  <div
                    key={p.id}
                    className={`flip-row${selectedId === p.id ? ' active' : ''}`}
                    onClick={() => focusPlace(p)}
                    onMouseEnter={() => setHighlightId(p.id)}
                    onMouseLeave={() => setHighlightId(null)}
                  >
                    <span className="flip-name">{p.n} <span className="kt">{p.kt}</span></span>
                    <span className="flip-times">{r.today} → {r.tomorrow} min</span>
                    <span className="flip-pop">{data.pop[p.pc]}</span>
                  </div>
                )
              })}
            </div>
          </details>
        )}

        <details className="method">
          <summary>So wird gerechnet</summary>
          <ul>
            <li>
              Reisezeiten sind abgefragt, nicht geschätzt: von der Ortsmitte (swissNAMES3D) jeder Ortschaft bis zum
              Hauptbahnhof des Ziels, in Pendelrichtung.
            </li>
            <li>
              <b>Auto</b>: Google Maps mit Verkehrsprognose, Abfahrt Dienstag 07:30.
            </li>
            <li>
              <b>ÖV</b>: SBB-Fahrplan 2026 (transport.opendata.ch), schnellste der vier nächsten Verbindungen ab
              Montag 07:00. Inklusive Fusswege und Umsteigen, ohne Warten vor der ersten Abfahrt.
            </li>
            <li><b>Heute</b> zählt die schnellere der beiden Optionen.</li>
            <li>
              <b>Autonom</b> = Autozeit ÷ Komfortfaktor. Verglichen wird immer mit der besten heutigen Option, nicht
              mit dem Selbstfahren. <b>Kippt</b>: heute über der Pendelschwelle, autonom darunter.
            </li>
            <li>
              Nicht enthalten: Parkplatzsuche, Mehrverkehr durch autonome Autos, Kosten. Ziele sind die zehn
              grössten Bahnknoten. Nur Ortschaften in der Schweiz und in Liechtenstein, Grenzgänger aus dem Ausland
              fehlen.
            </li>
            <li>
              Kein Routenplaner. Code und Daten auf{' '}
              <a href="https://github.com/Kaiman22/sleeper-towns" target="_blank" rel="noreferrer">GitHub</a>.
            </li>
          </ul>
        </details>
      </div>

      <div className="card legend">
        <span><span className="dot" style={{ background: TODAY_COLOR }} />heute pendelbar</span>
        <span className={av ? '' : 'off'}>
          <span className="dot" style={{ background: FLIP_COLOR }} />neu pendelbar (kippt)
        </span>
        <span><span className="dot" style={{ background: FAR_COLOR }} />zu weit</span>
        <span><span className="dot dest" />Ziel</span>
      </div>

      {hoverRow && hoverPlace && (
        <div className="tooltip" style={{ left: hovered.x + 14, top: hovered.y - 10 }}>
          <div className="tooltip-name">{placeName(hoverPlace)} <span className="kt">{hoverPlace.kt}</span></div>
          <div className="tooltip-verdict">{verdict(hoverRow, threshold, av)}</div>
          <div className="tooltip-times">
            Auto {fmtMin(hoverRow.car, 'autofrei')} · ÖV {fmtMin(hoverRow.pt)}
            {hoverRow.av != null && ` · autonom ${fmtMin(hoverRow.av)}`}
          </div>
        </div>
      )}

      <div className="footer">
        Auto: Google Maps, Verkehr Di 07:30 · ÖV: SBB-Fahrplan, Mo ab 07:00 · Orte: swissNAMES3D · kein Routenplaner ·{' '}
        <a href="https://github.com/Kaiman22/sleeper-towns" target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </div>
  )
}
