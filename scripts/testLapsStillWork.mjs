// Confirms the legitimate "laps" fallback (explicit, controlled repetition
// of a small loop when the area genuinely can't support one bigger loop)
// still works correctly despite the new hard cap on the SEARCH's own
// ability to reuse an edge more than twice - laps bypass that cap since
// they're built by directly repeating an already-found route, not
// discovered via the search re-choosing the same edges.
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { metersToMiles, milesToMeters } from '../src/lib/geo.js'

let nodeId = 1
const elements = []
function addNode(lat, lon) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }

// A genuinely tiny isolated loop - max possible distance is ~0.3mi, but we
// ask for 2mi, which legitimately requires ~6-7 laps.
const SIZE = 3, SPACING = 0.0004
const ids = {}
for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) ids[`${x},${y}`] = addNode(39.75 + y * SPACING, -75.55 + x * SPACING)
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(ids[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Row ${y}` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(ids[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Col ${x}` }) }

const graph = buildGraph({ elements })
const startId = snapStartToNetwork(graph, 39.75, -75.55)
graph.startNodeId = startId
analyzeDeadEnds(graph)

const route = generateLoopRoute(graph, startId, milesToMeters(2), { seed: 3 })
console.log(route ? {
  distMi: metersToMiles(route.distanceMeters).toFixed(2),
  laps: route.laps,
  withinTolerance: route.withinTolerance,
} : 'FAILED')

const ok = route && metersToMiles(route.distanceMeters) > 1.0 // should get reasonably close to 2mi via laps, not just give up at ~0.3mi
console.log(ok ? 'OK: laps fallback still successfully reaches a reasonable total distance' : 'FAIL: laps fallback broke')
process.exit(ok ? 0 : 1)
