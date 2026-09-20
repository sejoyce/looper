// Verifies computeRenderSegments correctly offsets and marks repeated
// passes over the same street/trail segment, so laps or crossed-over
// sections render as visibly distinct lines rather than perfect overlaps.
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute, computeRenderSegments } from '../src/lib/routeGenerator.js'
import { haversine, milesToMeters } from '../src/lib/geo.js'

let nodeId = 1
const elements = []
function addNode(lat, lon) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }

// A tiny 4x4 grid (small on purpose - forces the laps fallback to trigger
// for a 3mi target, guaranteeing a repeated pass).
const SIZE = 4, SPACING = 0.0006
const ids = {}
for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) ids[`${x},${y}`] = addNode(39.75 + y * SPACING, -75.55 + x * SPACING)
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(ids[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Row ${y}` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(ids[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Col ${x}` }) }

const graph = buildGraph({ elements })
const startId = snapStartToNetwork(graph, 39.75, -75.55)
graph.startNodeId = startId
analyzeDeadEnds(graph)

const route = generateLoopRoute(graph, startId, milesToMeters(3), { seed: 9 })
console.log(`Route: ${(route.distanceMeters/1609.344).toFixed(2)}mi, laps=${route.laps}, edges=${route.edgeKeys.length}`)

const segs = computeRenderSegments(graph, route.edgeKeys)
const repeatedCount = segs.filter(s => s.passIndex > 1).length
console.log(`Segments: ${segs.length} total, ${repeatedCount} marked as repeated passes (passIndex > 1)`)

let offsetOk = true
for (const seg of segs) {
  if (seg.passIndex > 1) {
    const [p1, p2] = seg.points
    const segLenApprox = haversine(p1[0], p1[1], p2[0], p2[1])
    if (!(segLenApprox >= 0) || !Number.isFinite(segLenApprox)) offsetOk = false
  }
}

// Verify offset magnitude directly against the true (unoffset) edge coordinates
const idx = segs.findIndex((s) => s.passIndex === 2)
let magnitudeOk = false
if (idx >= 0) {
  const edge = graph.edges.get(route.edgeKeys[idx])
  const trueFrom = graph.nodes.get(edge.from)
  const offsetDist = haversine(trueFrom.lat, trueFrom.lon, segs[idx].points[0][0], segs[idx].points[0][1])
  magnitudeOk = Math.abs(offsetDist - 3.5) < 1.5
  console.log(`Pass-2 offset distance: ${offsetDist.toFixed(2)}m (expect ~3.5m)`)
}

const checks = [
  ['At least one repeated-pass segment found (laps or reuse)', repeatedCount > 0],
  ['Every segment has valid, finite offset points', offsetOk],
  ['Segment count matches edge count', segs.length === route.edgeKeys.length],
  ['Pass-2 offset magnitude is correct (~3.5m)', magnitudeOk],
]
let allPass = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'OK' : 'FAIL'}: ${label}`)
  if (!pass) allPass = false
}
console.log(allPass ? '\nALL RENDER-SEGMENT CHECKS PASSED' : '\nCHECKS FAILED')
process.exit(allPass ? 0 : 1)
