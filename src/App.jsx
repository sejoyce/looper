import { useState, useRef, useCallback } from 'react'
import RouteForm from './components/RouteForm'
import RouteStats from './components/RouteStats'
import MapView from './components/MapView'
import RouteThumbnail from './components/RouteThumbnail'
import { geocodeAddress, fetchStreetGraph } from './lib/osm'
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from './lib/graph'
import { generateLoopRoute, summarizeSegments, routeToPolylineRuns, computeDirectionArrows } from './lib/routeGenerator'
import { computeRouteElevation } from './lib/elevation'
import { buildTcxCourse, buildGpx, downloadFile } from './lib/exportCourse'
import { milesToMeters, radiusForTargetMiles, metersToMiles } from './lib/geo'
import { compareRoutes, isMeaningfullyWorse } from './lib/routeComparison'

const STAGES = {
  IDLE: 'idle',
  GEOCODING: 'geocoding',
  FETCHING: 'fetching',
  PLOTTING: 'plotting',
  DONE: 'done',
  ERROR: 'error',
}

const STAGE_MESSAGES = {
  [STAGES.GEOCODING]: 'Locating your address…',
  [STAGES.FETCHING]: 'Reading streets and trails nearby…',
  [STAGES.PLOTTING]: 'Testing routes for the best loop…',
}

const METERS_PER_FOOT = 0.3048
const MAX_HISTORY = 8

function yieldToBrowser() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

async function pickBestCandidateWithElevation(graph, startNodeId, targetMeters, seed, elevationPrefs) {
  const candidates = []
  for (let i = 0; i < 5; i++) {
    const route = generateLoopRoute(graph, startNodeId, targetMeters, { seed: seed + i * 7919 })
    if (route) candidates.push(route)
  }
  if (candidates.length === 0) return null

  const withElevation = []
  for (const route of candidates) {
    const elev = await computeRouteElevation(graph, route.edgeKeys)
    withElevation.push({ route, elev })
  }

  function violationFt(elev) {
    if (!elev.available) return Infinity
    const gainFt = elev.gainMeters / METERS_PER_FOOT
    let v = 0
    if (elevationPrefs.minFt != null && gainFt < elevationPrefs.minFt) v += elevationPrefs.minFt - gainFt
    if (elevationPrefs.maxFt != null && gainFt > elevationPrefs.maxFt) v += gainFt - elevationPrefs.maxFt
    return v
  }

  withElevation.sort((a, b) => violationFt(a.elev) - violationFt(b.elev))
  const best = withElevation[0]
  const v = violationFt(best.elev)

  let elevationNote = null
  if (v === Infinity) {
    elevationNote = "Elevation data wasn't available for this route just now."
  } else if (v > 0) {
    elevationNote = `Couldn't find a loop matching your elevation preference near this address - closest option has about ${Math.round(best.elev.gainMeters / METERS_PER_FOOT)} ft of gain.`
  }

  return { route: best.route, elevation: { ...best.elev, elevationNote } }
}

export default function App() {
  const [address, setAddress] = useState('')
  const [miles, setMiles] = useState('3')
  const [minElevation, setMinElevation] = useState('')
  const [maxElevation, setMaxElevation] = useState('')
  const [stage, setStage] = useState(STAGES.IDLE)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [start, setStart] = useState(null)
  const [summary, setSummary] = useState(null)
  const [segments, setSegments] = useState(null)
  const [polylineRuns, setPolylineRuns] = useState(null)
  const [directionArrows, setDirectionArrows] = useState(null)
  const [elevation, setElevation] = useState(null)
  const [history, setHistory] = useState([])
  const [activeHistoryId, setActiveHistoryId] = useState(null)

  const graphRef = useRef(null)
  const startNodeRef = useRef(null)
  const targetMetersRef = useRef(null)
  const seedRef = useRef(0)
  const historyIdRef = useRef(0)
  const lastGeneratedRef = useRef(null) // { address, miles, minFt, maxFt }

  const loading = [STAGES.GEOCODING, STAGES.FETCHING, STAGES.PLOTTING].includes(stage)
  const hasRoute = !!summary

  function currentElevationPrefs() {
    const minFt = parseFloat(minElevation)
    const maxFt = parseFloat(maxElevation)
    return {
      minFt: Number.isFinite(minFt) && minElevation !== '' ? minFt : null,
      maxFt: Number.isFinite(maxFt) && maxElevation !== '' ? maxFt : null,
    }
  }

  const plot = useCallback(async (graph, startNodeId, targetMeters, seed, elevationPrefs) => {
    // The route search below is synchronous, CPU-bound JS - without a real
    // await first, it can start running before the browser has painted the
    // "loading" state that was just set, so the spinner never actually
    // becomes visible until the (possibly multi-second) computation is
    // already done. Yielding here first (via double rAF, so it waits for an
    // actual paint rather than just the next microtask) fixes that.
    await yieldToBrowser()

    const hasPref = elevationPrefs.minFt != null || elevationPrefs.maxFt != null

    if (hasPref) {
      const planned = await pickBestCandidateWithElevation(graph, startNodeId, targetMeters, seed, elevationPrefs)
      if (!planned) return null
      return {
        summary: planned.route,
        segments: summarizeSegments(graph, planned.route.edgeKeys),
        polylineRuns: routeToPolylineRuns(graph, planned.route.edgeKeys),
        directionArrows: computeDirectionArrows(graph, planned.route.edgeKeys),
        elevation: planned.elevation,
        elevationPromise: null,
      }
    }

    // Try a few seeds and keep the best, so a single unlucky attempt
    // doesn't produce a worse result than the area actually supports - but
    // stop as soon as one is already clean and on-target, since each
    // attempt re-runs the full search and this was the single biggest cost
    // in regenerating (3x the cost of one search, every time, even when
    // the very first attempt was already great).
    let route = null
    for (let i = 0; i < 3; i++) {
      const candidate = generateLoopRoute(graph, startNodeId, targetMeters, { seed: seed + i * 13337 })
      if (candidate && (!route || compareRoutes(candidate, route) < 0)) route = candidate
      if (route && route.withinTolerance && route.tinyLoopCount === 0 && route.turnCount / metersToMiles(route.distanceMeters) <= 14) {
        break
      }
    }
    if (!route) return null
    return {
      summary: route,
      segments: summarizeSegments(graph, route.edgeKeys),
      polylineRuns: routeToPolylineRuns(graph, route.edgeKeys),
      directionArrows: computeDirectionArrows(graph, route.edgeKeys),
      elevation: null,
      elevationPromise: computeRouteElevation(graph, route.edgeKeys),
    }
  }, [])

  function pushHistory(result) {
    const id = ++historyIdRef.current
    setHistory((prev) => {
      const next = [...prev, { id, ...result }]
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
    })
    setActiveHistoryId(id)
    return id
  }

  function applyResult(result, historyId) {
    setSummary(result.summary)
    setSegments(result.segments)
    setPolylineRuns(result.polylineRuns)
    setDirectionArrows(result.directionArrows)
    setElevation(result.elevation)
    if (result.elevationPromise) {
      result.elevationPromise.then((elev) => {
        setElevation(elev)
        if (historyId != null) {
          setHistory((prev) => prev.map((h) => (h.id === historyId ? { ...h, elevation: elev } : h)))
        }
      })
    }
  }

  function sameAsLastGenerated(elevationPrefs) {
    const last = lastGeneratedRef.current
    if (!last) return false
    return (
      last.address === address &&
      last.miles === miles &&
      last.minFt === elevationPrefs.minFt &&
      last.maxFt === elevationPrefs.maxFt
    )
  }

  async function runFreshSearch() {
    setError(null)
    setNotice(null)
    setSummary(null)
    setSegments(null)
    setPolylineRuns(null)
    setDirectionArrows(null)
    setElevation(null)
    setHistory([])
    setActiveHistoryId(null)

    const targetMiles = parseFloat(miles)
    if (!targetMiles || targetMiles <= 0) {
      setError('Enter a target distance greater than zero.')
      setStage(STAGES.ERROR)
      return
    }

    try {
      setStage(STAGES.GEOCODING)
      const location = await geocodeAddress(address)
      setStart(location)

      setStage(STAGES.FETCHING)
      const targetMeters = milesToMeters(targetMiles)
      const radius = radiusForTargetMiles(targetMiles)
      const osmData = await fetchStreetGraph(location.lat, location.lon, radius)
      const graph = buildGraph(osmData)

      if (graph.nodes.size === 0) {
        throw new Error('No street data found near that address. Try a slightly different address.')
      }

      const startNodeId = snapStartToNetwork(graph, location.lat, location.lon)
      if (startNodeId == null) {
        throw new Error('No street data found near that address. Try a slightly different address.')
      }
      graph.startNodeId = startNodeId
      analyzeDeadEnds(graph)

      graphRef.current = graph
      startNodeRef.current = startNodeId
      targetMetersRef.current = targetMeters
      seedRef.current = Date.now()

      setStage(STAGES.PLOTTING)
      const elevationPrefs = currentElevationPrefs()
      const result = await plot(graph, startNodeId, targetMeters, seedRef.current, elevationPrefs)
      if (!result) {
        throw new Error(
          "Couldn't find any runnable loop from this address - the street data nearby may be too sparse (or too dead-end-heavy) for a loop this size. Try a nearby address or a shorter distance."
        )
      }

      lastGeneratedRef.current = { address, miles, minFt: elevationPrefs.minFt, maxFt: elevationPrefs.maxFt }
      const id = pushHistory(result)
      applyResult(result, id)
      setStage(STAGES.DONE)
    } catch (err) {
      setError(err.message || 'Something went wrong finding a route.')
      setStage(STAGES.ERROR)
    }
  }

  async function runRegenerate() {
    setError(null)
    setNotice(null)
    setStage(STAGES.PLOTTING)
    seedRef.current += 1
    try {
      const elevationPrefs = currentElevationPrefs()
      const result = await plot(graphRef.current, startNodeRef.current, targetMetersRef.current, seedRef.current, elevationPrefs)

      if (!result || isMeaningfullyWorse(result.summary, summary)) {
        setNotice(
          "That's the best loop this street network has to offer near your target - no better distinct option found. Showing your last result."
        )
        return
      }

      const id = pushHistory(result)
      applyResult(result, id)
    } catch (err) {
      setError(err.message || 'Something went wrong finding another route.')
    } finally {
      setStage(STAGES.DONE)
    }
  }

  // One button drives both flows: if the address/mileage/elevation
  // preferences haven't changed since the last generation, "regenerate" on
  // the same street data; otherwise (or on the very first run) do the full
  // fresh search. This is also what lets the button's own label ("Find my
  // loop" vs "Try a different loop") stay in sync with what will actually
  // happen when it's clicked.
  async function handleGenerate() {
    const elevationPrefs = currentElevationPrefs()
    if (hasRoute && graphRef.current && sameAsLastGenerated(elevationPrefs)) {
      await runRegenerate()
    } else {
      await runFreshSearch()
    }
  }

  function handleSelectHistory(entry) {
    setActiveHistoryId(entry.id)
    setNotice(null)
    setSummary(entry.summary)
    setSegments(entry.segments)
    setPolylineRuns(entry.polylineRuns)
    setDirectionArrows(entry.directionArrows)
    setElevation(entry.elevation)
  }

  function handleExportTcx() {
    if (!graphRef.current || !summary) return
    const xml = buildTcxCourse(graphRef.current, summary.edgeKeys, `Looper ${miles}mi from ${address}`)
    downloadFile('looper-route.tcx', xml, 'application/vnd.garmin.tcx+xml')
  }

  function handleExportGpx() {
    if (!graphRef.current || !summary) return
    const xml = buildGpx(graphRef.current, summary.edgeKeys, `Looper ${miles}mi from ${address}`)
    downloadFile('looper-route.gpx', xml, 'application/gpx+xml')
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <h1>Looper</h1>
          <p className="tagline">Trail-first running loops from your front door.</p>
        </div>
        <svg className="header-squiggle" viewBox="0 0 400 24" preserveAspectRatio="none" aria-hidden="true">
          <polyline
            points="0,18 20,18 32,6 48,20 64,4 80,18 100,10 120,18 140,8 160,18 184,6 200,18 220,12 240,18 264,4 280,18 300,10 320,18 344,6 360,18 380,14 400,18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <RouteForm
            address={address}
            setAddress={setAddress}
            miles={miles}
            setMiles={setMiles}
            minElevation={minElevation}
            setMinElevation={setMinElevation}
            maxElevation={maxElevation}
            setMaxElevation={setMaxElevation}
            onSubmit={handleGenerate}
            loading={loading}
            hasRoute={hasRoute}
          />

          {error && <p className="status-line status-error">{error}</p>}
          {notice && <p className="tolerance-note">{notice}</p>}

          {summary && (
            <RouteStats
              summary={summary}
              segments={segments}
              elevation={elevation}
              onExportTcx={handleExportTcx}
              onExportGpx={handleExportGpx}
            />
          )}

          {history.length > 1 && (
            <div className="history-section">
              <span className="field-label">Loops you've generated</span>
              <div className="history-strip">
                {history.map((entry) => (
                  <button
                    key={entry.id}
                    className={`history-thumb${entry.id === activeHistoryId ? ' is-active' : ''}`}
                    onClick={() => handleSelectHistory(entry)}
                    title={`${(entry.summary.distanceMeters / 1609.344).toFixed(2)} mi`}
                  >
                    <RouteThumbnail polylineRuns={entry.polylineRuns} />
                    <span className="history-thumb-label">{(entry.summary.distanceMeters / 1609.344).toFixed(2)} mi</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="legend">
            <span className="legend-swatch trail" /> trail &nbsp;
            <span className="legend-swatch street" /> street
          </p>
        </aside>

        <main className="map-pane">
          <MapView start={start} polylineRuns={polylineRuns} directionArrows={directionArrows} />
          {loading && (
            <div className="map-loading-overlay">
              <div className="map-loading-spinner" aria-hidden="true" />
              <p className="map-loading-text">{STAGE_MESSAGES[stage] || 'Working…'}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
