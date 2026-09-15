import { useState, useRef, useCallback } from 'react'
import RouteForm from './components/RouteForm'
import RouteStats from './components/RouteStats'
import MapView from './components/MapView'
import { geocodeAddress, fetchStreetGraph } from './lib/osm'
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from './lib/graph'
import { generateLoopRoute, summarizeSegments, routeToPolylineRuns, computeDirectionArrows } from './lib/routeGenerator'
import { computeRouteElevation } from './lib/elevation'
import { buildTcxCourse, buildGpx, downloadFile } from './lib/exportCourse'
import { milesToMeters, radiusForTargetMiles } from './lib/geo'

const STAGES = {
  IDLE: 'idle',
  GEOCODING: 'geocoding',
  FETCHING: 'fetching',
  PLOTTING: 'plotting',
  ELEVATION: 'elevation',
  DONE: 'done',
  ERROR: 'error',
}

const METERS_PER_FOOT = 0.3048

// When an elevation preference is set, we need elevation for several
// candidates before picking a winner, so that part stays synchronous
// (blocking) - there's no way around it if the choice depends on it. This
// returns the chosen route and its elevation together.
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
  const [start, setStart] = useState(null)
  const [summary, setSummary] = useState(null)
  const [segments, setSegments] = useState(null)
  const [polylineRuns, setPolylineRuns] = useState(null)
  const [directionArrows, setDirectionArrows] = useState(null)
  const [elevation, setElevation] = useState(null)
  const [regenerating, setRegenerating] = useState(false)

  const graphRef = useRef(null)
  const startNodeRef = useRef(null)
  const targetMetersRef = useRef(null)
  const seedRef = useRef(0)

  const loading = [STAGES.GEOCODING, STAGES.FETCHING, STAGES.PLOTTING, STAGES.ELEVATION].includes(stage)

  function currentElevationPrefs() {
    const minFt = parseFloat(minElevation)
    const maxFt = parseFloat(maxElevation)
    return {
      minFt: Number.isFinite(minFt) && minElevation !== '' ? minFt : null,
      maxFt: Number.isFinite(maxFt) && maxElevation !== '' ? maxFt : null,
    }
  }

  const plot = useCallback(async (graph, startNodeId, targetMeters, seed, elevationPrefs) => {
    const hasPref = elevationPrefs.minFt != null || elevationPrefs.maxFt != null

    if (hasPref) {
      // Need elevation on several candidates before we can even pick a
      // winner, so this path has to block on it.
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

    // No preference: the route itself doesn't depend on elevation at all,
    // so show it immediately and let elevation populate a moment later
    // instead of making the whole result wait on a network round trip.
    const route = generateLoopRoute(graph, startNodeId, targetMeters, { seed })
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

  async function handleSubmit() {
    setError(null)
    setSummary(null)
    setSegments(null)
    setPolylineRuns(null)
    setDirectionArrows(null)
    setElevation(null)

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

      // Snap the route's start/finish onto the exact closest point on the
      // street network (splitting a segment if needed), rather than just
      // the nearest existing intersection - this is what keeps the loop's
      // start tight to the actual address instead of drifting to whatever
      // corner happens to be nearby.
      const startNodeId = snapStartToNetwork(graph, location.lat, location.lon)
      if (startNodeId == null) {
        throw new Error('No street data found near that address. Try a slightly different address.')
      }
      graph.startNodeId = startNodeId
      analyzeDeadEnds(graph) // must run after snapping, so it reflects the final topology

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

      setSummary(result.summary)
      setSegments(result.segments)
      setPolylineRuns(result.polylineRuns)
      setDirectionArrows(result.directionArrows)
      setElevation(result.elevation)
      setStage(STAGES.DONE)
      if (result.elevationPromise) {
        result.elevationPromise.then((elev) => setElevation(elev))
      }
    } catch (err) {
      setError(err.message || 'Something went wrong finding a route.')
      setStage(STAGES.ERROR)
    }
  }

  async function handleRegenerate() {
    if (!graphRef.current || !startNodeRef.current) return
    setRegenerating(true)
    seedRef.current += 1
    try {
      const elevationPrefs = currentElevationPrefs()
      const result = await plot(graphRef.current, startNodeRef.current, targetMetersRef.current, seedRef.current, elevationPrefs)
      if (result) {
        setSummary(result.summary)
        setSegments(result.segments)
        setPolylineRuns(result.polylineRuns)
        setDirectionArrows(result.directionArrows)
        setElevation(result.elevation)
        if (result.elevationPromise) {
          result.elevationPromise.then((elev) => setElevation(elev))
        }
      }
    } finally {
      setRegenerating(false)
    }
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
            onSubmit={handleSubmit}
            loading={loading}
          />

          {stage === STAGES.GEOCODING && <p className="status-line">Locating your address…</p>}
          {stage === STAGES.FETCHING && <p className="status-line">Reading streets and trails nearby…</p>}
          {stage === STAGES.PLOTTING && <p className="status-line">Testing routes for the best loop…</p>}
          {stage === STAGES.ELEVATION && <p className="status-line">Checking elevation…</p>}
          {error && <p className="status-line status-error">{error}</p>}

          {summary && (
            <RouteStats
              summary={summary}
              segments={segments}
              elevation={elevation}
              onRegenerate={handleRegenerate}
              regenerating={regenerating}
              onExportTcx={handleExportTcx}
              onExportGpx={handleExportGpx}
            />
          )}

          <p className="legend">
            <span className="legend-swatch trail" /> trail &nbsp;
            <span className="legend-swatch street" /> street
          </p>
        </aside>

        <main className="map-pane">
          <MapView start={start} polylineRuns={polylineRuns} directionArrows={directionArrows} />
        </main>
      </div>
    </div>
  )
}
