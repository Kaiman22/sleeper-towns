import React, { useState, useEffect, useMemo, useCallback } from 'react'
import Map from './Map'
import Panel from './Panel'
import { DEFAULTS, METRICS, computeRows, computeBounds } from './model'

const DATA_URL = './data/sleeper.json'

function readUrl() {
  try {
    const q = new URLSearchParams(window.location.search)
    const s = {}
    if (q.get('to')) s.anchor = q.get('to')
    if (q.get('max')) s.tolerance = parseInt(q.get('max'), 10)
    if (q.get('by') && METRICS[q.get('by')]) s.metric = q.get('by')
    return s
  } catch {
    return {}
  }
}

function writeUrl(s) {
  try {
    const q = new URLSearchParams()
    if (s.anchor !== DEFAULTS.anchor) q.set('to', s.anchor)
    if (s.tolerance !== DEFAULTS.tolerance) q.set('max', String(s.tolerance))
    if (s.metric !== DEFAULTS.metric) q.set('by', s.metric)
    const str = q.toString()
    window.history.replaceState(null, '', str ? `?${str}` : window.location.pathname)
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [settings, setSettings] = useState(() => ({ ...DEFAULTS, ...readUrl() }))
  const [selectedId, setSelectedId] = useState(null)
  const [highlightId, setHighlightId] = useState(null)
  const [hover, setHover] = useState(null)

  useEffect(() => {
    fetch(DATA_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        setData(d)
        if (!d.anchors[settings.anchor]) setSettings((s) => ({ ...s, anchor: DEFAULTS.anchor }))
      })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => writeUrl(settings), 250)
    return () => clearTimeout(t)
  }, [settings])

  const rows = useMemo(() => (data ? computeRows(data, settings) : []), [data, settings])
  const bounds = useMemo(() => computeBounds(rows, settings.metric), [rows, settings.metric])
  const anchor = data?.anchors[settings.anchor] || null

  const onHover = useCallback((id, point) => setHover(id ? { id, ...point } : null), [])
  const hoverRow = hover ? rows.find((r) => r.id === hover.id) : null
  const metric = METRICS[settings.metric]

  return (
    <div className="app">
      <div className="map">
        {!data && <div className="loading">{error ? `Failed to load data: ${error}` : 'Loading…'}</div>}
        <Map
          rows={rows}
          metricKey={settings.metric}
          bounds={bounds}
          anchor={anchor}
          selectedId={selectedId}
          highlightId={highlightId}
          onSelect={setSelectedId}
          onHover={onHover}
        />
        {hoverRow && (
          <div className="tooltip" style={{ left: hover.x + 14, top: hover.y - 10 }}>
            <b>
              {hoverRow.name}
              {hoverRow.muni !== hoverRow.name ? ` (${hoverRow.muni})` : ''}
            </b>
            <span>
              {hoverRow.viable
                ? metric.get(hoverRow) != null
                  ? `${metric.label}: ${metric.fmt(metric.get(hoverRow))}`
                  : 'no price data'
                : `outside limits · AV ${Math.round(hoverRow.tAv)} min`}
            </span>
          </div>
        )}
      </div>
      <Panel
        data={data}
        rows={rows}
        settings={settings}
        setSettings={setSettings}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
        setHighlightId={setHighlightId}
      />
    </div>
  )
}
