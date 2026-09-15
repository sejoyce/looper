// Mocks the Open-Elevation API (unreachable from this sandbox) to verify
// the decimation, batching, and gain/loss calculation logic is correct.
import { buildGraph, nearestNode, analyzeDeadEnds } from '../src/lib/graph.js'
import { computeRouteElevation } from '../src/lib/elevation.js'

// Simple graph: a straight line of 6 nodes going "uphill" then back down,
// forming a loop back to start via a return leg at constant elevation.
const elements = [
  { type: 'node', id: 1, lat: 39.9500, lon: -75.1600 },
  { type: 'node', id: 2, lat: 39.9505, lon: -75.1600 },
  { type: 'node', id: 3, lat: 39.9510, lon: -75.1600 },
  { type: 'node', id: 4, lat: 39.9510, lon: -75.1595 },
  { type: 'node', id: 5, lat: 39.9505, lon: -75.1595 },
  { type: 'node', id: 6, lat: 39.9500, lon: -75.1595 },
]
elements.push({ type: 'way', id: 1, nodes: [1, 2, 3], tags: { highway: 'residential', name: 'Up St' } })
elements.push({ type: 'way', id: 2, nodes: [3, 4], tags: { highway: 'residential', name: 'Cross St' } })
elements.push({ type: 'way', id: 3, nodes: [4, 5, 6], tags: { highway: 'residential', name: 'Down St' } })
elements.push({ type: 'way', id: 4, nodes: [6, 1], tags: { highway: 'residential', name: 'Close St' } })

const graph = buildGraph({ elements })
const start = nearestNode(graph, 39.95, -75.16)
graph.startNodeId = start.id
analyzeDeadEnds(graph)

// Build a manual "route" edge list going all the way around the loop.
const edgeKeys = []
const order = [[1,2],[2,3],[3,4],[4,5],[5,6],[6,1]]
for (const [a,b] of order) {
  for (const [key, edge] of graph.edges) {
    if (edge.from === a && edge.to === b) { edgeKeys.push(key); break }
  }
}
console.log(`Route has ${edgeKeys.length} edges`)

// Mock elevation: rises 30m from node 1->3, flat 3->4, drops back down 4->6, flat 6->1.
// Since decimateRoutePoints samples ~every 25m and our segments are ~55m/500m long,
// we mostly just need fetch() to respond with a plausible elevation per queried point.
const elevationByLatBand = (lat) => {
  // 39.9500 = 0m, 39.9505 = 30m (peak), 39.9510 = 30m (still up top per this graph)
  if (lat <= 39.95005) return 0
  return 30
}

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body)
  const results = body.locations.map((loc) => ({ elevation: elevationByLatBand(loc.latitude) }))
  return { ok: true, json: async () => ({ results }) }
}

const result = await computeRouteElevation(graph, edgeKeys)
console.log('Elevation result:', result)
console.log(result.available ? 'OK: elevation reported as available' : 'FAILED: elevation reported unavailable')
console.log(`Gain: ${(result.gainMeters).toFixed(1)}m (expect ~30m, the single climb)`) 
console.log(`Loss: ${(result.lossMeters).toFixed(1)}m (expect ~30m, the single descent)`) 

const ok = result.available && Math.abs(result.gainMeters - 30) < 5 && Math.abs(result.lossMeters - 30) < 5
console.log(ok ? '\nALL ELEVATION CHECKS PASSED' : '\nELEVATION CHECKS FAILED')
process.exit(ok ? 0 : 1)
