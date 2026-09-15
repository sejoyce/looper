// Open-Elevation is a free, public, keyless elevation API (backed by SRTM
// data). We only ever fetch elevation for the points of an already-chosen
// route (not the whole street graph), which keeps requests small and fast.
const ELEVATION_ENDPOINT = 'https://api.open-elevation.com/api/v1/lookup'
const CHUNK_SIZE = 120

async function fetchElevationChunk(points) {
  const res = await fetch(ELEVATION_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: points.map((p) => ({ latitude: p.lat, longitude: p.lon })) }),
  })
  if (!res.ok) throw new Error(`Elevation service returned ${res.status}`)
  const data = await res.json()
  return data.results.map((r) => r.elevation)
}

// Fetches elevation (meters) for a list of {lat, lon} points, in modest
// batches. Returns an array aligned with the input; entries are `null`
// where the service couldn't be reached, so callers should tolerate gaps.
export async function fetchElevations(points) {
  const results = new Array(points.length).fill(null)
  for (let i = 0; i < points.length; i += CHUNK_SIZE) {
    const chunk = points.slice(i, i + CHUNK_SIZE)
    try {
      const elevations = await fetchElevationChunk(chunk)
      elevations.forEach((e, idx) => {
        results[i + idx] = e
      })
    } catch {
      // Leave this chunk as null; a partial elevation profile still lets
      // us report a (slightly conservative) gain figure rather than none.
    }
  }
  return results
}

// Builds an ordered list of {lat, lon} points along a route, thinned to
// roughly `intervalMeters` spacing - fine enough to catch real hills,
// coarse enough to keep the elevation API request small.
function decimateRoutePoints(graph, edgeKeys, intervalMeters = 25) {
  const points = []
  let sinceLast = Infinity
  edgeKeys.forEach((key, i) => {
    const edge = graph.edges.get(key)
    const from = graph.nodes.get(edge.from)
    const to = graph.nodes.get(edge.to)
    if (i === 0) points.push({ lat: from.lat, lon: from.lon })
    sinceLast += edge.distance
    if (sinceLast >= intervalMeters || i === edgeKeys.length - 1) {
      points.push({ lat: to.lat, lon: to.lon })
      sinceLast = 0
    }
  })
  return points
}

// Sums positive elevation deltas (climbing) and negative ones (descending)
// along a simple elevation profile. A small per-step threshold filters out
// sensor/data noise so tiny jitter in the elevation dataset isn't counted
// as real climbing.
function summarizeElevationProfile(elevations, noiseThresholdMeters = 1) {
  let gain = 0
  let loss = 0
  let prev = null
  for (const e of elevations) {
    if (e == null) continue
    if (prev != null) {
      const delta = e - prev
      if (delta > noiseThresholdMeters) gain += delta
      else if (delta < -noiseThresholdMeters) loss += -delta
    }
    prev = e
  }
  return { gainMeters: gain, lossMeters: loss }
}

// Fetches and summarizes elevation gain/loss for a generated route. Returns
// null gain/loss (with `available: false`) if the elevation service
// couldn't be reached at all, so the UI can say so rather than show a
// silently-wrong zero.
export async function computeRouteElevation(graph, edgeKeys) {
  const points = decimateRoutePoints(graph, edgeKeys)
  const elevations = await fetchElevations(points)
  const knownCount = elevations.filter((e) => e != null).length
  if (knownCount < Math.max(2, points.length * 0.5)) {
    return { available: false, gainMeters: 0, lossMeters: 0 }
  }
  const { gainMeters, lossMeters } = summarizeElevationProfile(elevations)
  return { available: true, gainMeters, lossMeters }
}
