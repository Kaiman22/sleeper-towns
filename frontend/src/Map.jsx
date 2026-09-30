import React, { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import { METRICS, colorStops, paletteFor } from './model'

const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const RADIUS = ['interpolate', ['linear'], ['zoom'], 6, 2.5, 8, 4.5, 10, 7, 12, 11]
const RING = ['interpolate', ['linear'], ['zoom'], 6, 7, 8, 10, 10, 14, 12, 19]

function toGeoJSON(rows, metricKey) {
  const get = METRICS[metricKey].get
  return {
    type: 'FeatureCollection',
    features: rows.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { id: r.id, v: r.viable ? get(r) : null, viable: r.viable ? 1 : 0 },
    })),
  }
}

function colorExpr(bounds, metricKey) {
  if (!bounds) return paletteFor(metricKey)[2]
  const stops = colorStops(bounds, metricKey)
  if (stops.length < 2) return stops[0][1]
  return ['interpolate', ['linear'], ['coalesce', ['get', 'v'], 0], ...stops.flat()]
}

export default function Map({ rows, metricKey, bounds, anchor, selectedId, highlightId, onSelect, onHover }) {
  const el = useRef(null)
  const map = useRef(null)
  const ready = useRef(false)
  const latest = useRef({ rows, metricKey, bounds, onSelect, onHover })
  latest.current = { rows, metricKey, bounds, onSelect, onHover }

  // Create map + layers once
  useEffect(() => {
    const m = new maplibregl.Map({
      container: el.current,
      style: STYLE,
      center: [8.35, 47.1],
      zoom: 8.2,
      minZoom: 6,
      maxZoom: 14,
      attributionControl: false,
    })
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    map.current = m
    window.__sleeperMap = m // debugging hook (console): center, zoom, layers

    m.on('load', () => {
      const { rows, metricKey, bounds } = latest.current
      m.addSource('pts', { type: 'geojson', data: toGeoJSON(rows, metricKey) })
      m.addSource('anchor', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })

      m.addLayer({
        id: 'pts-dim',
        type: 'circle',
        source: 'pts',
        filter: ['any', ['==', ['get', 'viable'], 0], ['==', ['get', 'v'], null]],
        paint: { 'circle-radius': RADIUS, 'circle-color': '#3a3f4f', 'circle-opacity': 0.35 },
      })
      m.addLayer({
        id: 'pts',
        type: 'circle',
        source: 'pts',
        filter: ['all', ['==', ['get', 'viable'], 1], ['!=', ['get', 'v'], null]],
        paint: {
          'circle-radius': RADIUS,
          'circle-color': colorExpr(bounds, metricKey),
          'circle-opacity': 0.85,
          'circle-stroke-width': 0.5,
          'circle-stroke-color': 'rgba(255,255,255,0.35)',
        },
      })
      m.addLayer({
        id: 'pts-hl',
        type: 'circle',
        source: 'pts',
        filter: ['==', ['get', 'id'], ''],
        paint: { 'circle-radius': RING, 'circle-color': 'transparent', 'circle-stroke-width': 3, 'circle-stroke-color': '#ffeb3b' },
      })
      m.addLayer({
        id: 'pts-sel',
        type: 'circle',
        source: 'pts',
        filter: ['==', ['get', 'id'], ''],
        paint: { 'circle-radius': RADIUS, 'circle-color': 'transparent', 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff' },
      })
      m.addLayer({
        id: 'anchor',
        type: 'circle',
        source: 'anchor',
        paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-width': 3, 'circle-stroke-color': '#e94560' },
      })
      m.addLayer({
        id: 'anchor-label',
        type: 'symbol',
        source: 'anchor',
        layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#0f1117', 'text-halo-width': 1.5 },
      })

      for (const layer of ['pts', 'pts-dim']) {
        m.on('mousemove', layer, (e) => {
          m.getCanvas().style.cursor = 'pointer'
          if (e.features?.length) latest.current.onHover(e.features[0].properties.id, e.point)
        })
        m.on('mouseleave', layer, () => {
          m.getCanvas().style.cursor = ''
          latest.current.onHover(null)
        })
        m.on('click', layer, (e) => {
          if (e.features?.length) latest.current.onSelect(e.features[0].properties.id)
        })
      }
      ready.current = true
      m.fire('sleeper-ready')
    })

    return () => {
      m.remove()
      map.current = null
      ready.current = false
    }
  }, [])

  // Data / colors
  useEffect(() => {
    const m = map.current
    if (!m) return
    const apply = () => {
      m.getSource('pts')?.setData(toGeoJSON(rows, metricKey))
      m.setPaintProperty('pts', 'circle-color', colorExpr(bounds, metricKey))
    }
    if (ready.current) apply()
    else m.once('sleeper-ready', apply)
  }, [rows, metricKey, bounds])

  // Anchor marker + fly
  useEffect(() => {
    const m = map.current
    if (!m || !anchor) return
    const apply = () => {
      m.getSource('anchor')?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [anchor.lon, anchor.lat] }, properties: { name: anchor.name } }],
      })
      m.flyTo({ center: [anchor.lon, anchor.lat], zoom: 9.2, duration: 900 })
    }
    if (ready.current) apply()
    else m.once('sleeper-ready', apply)
  }, [anchor])

  // Selection / highlight rings
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    m.setFilter('pts-sel', ['==', ['get', 'id'], selectedId || ''])
    const r = selectedId && rows.find((x) => x.id === selectedId)
    if (r) m.flyTo({ center: [r.lon, r.lat], zoom: Math.max(m.getZoom(), 10.5), duration: 700 })
  }, [selectedId])
  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    m.setFilter('pts-hl', ['==', ['get', 'id'], highlightId || ''])
  }, [highlightId])

  const metric = METRICS[metricKey]
  const pal = paletteFor(metricKey)
  return (
    <>
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      <div className="legend">
        <b>{metric.label}</b> {bounds ? `· ${bounds.n.toLocaleString()} places within limits` : ''}
        <div className="bar" style={{ background: `linear-gradient(to right, ${pal.join(', ')})` }} />
        {bounds && (
          <div className="ends">
            <span>{metric.fmt(bounds.p10)}</span>
            <span>{metric.fmt(bounds.p50)}</span>
            <span>{metric.fmt(bounds.p90)}</span>
          </div>
        )}
      </div>
    </>
  )
}
