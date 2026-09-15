// Verifies the Alders Lane bug: a LONG straight dead-end street (no
// branches, no cycles) must be fully excluded from routing regardless of
// its length - not just its short tip. Previously, length-based
// classification wrongly treated the near-entrance segments as "worthwhile"
// (since a lot of street length sat beyond them), letting the route go
// partway down and turn around.
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { metersToMiles, milesToMeters } from '../src/lib/geo.js'

let nodeId = 1
const elements = []
function addNode(lat, lon, tags) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon, tags }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }

// A small core grid (through streets)
const SIZE = 8, SPACING = 0.0009
const ids = {}
for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) ids[`${x},${y}`] = addNode(39.75 + y * SPACING, -75.55 + x * SPACING)
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(ids[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Row ${y}` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(ids[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Col ${x}` }) }

// "Alders Lane" - a LONG straight dead end (600m, well past any old length
// threshold), broken into several segments (like real OSM way-splitting at
// minor curve vertices), with NOTHING at the far end - no branches, no
// trail, no loop back. Pure dead end, just long.
const aldersStart = ids['4,4']
const aldersChain = [aldersStart]
const startNode = elements.find(e => e.type === 'node' && e.id === aldersStart)
let lat = startNode.lat, lon = startNode.lon
for (let s = 0; s < 6; s++) { lon += 0.0009; aldersChain.push(addNode(lat, lon)) } // ~600m total, 6 segments
// Split into 3 separate ways (as OSM often does at minor vertices) to mimic
// a realistic multi-segment dead-end street, all sharing the name.
addWay(aldersChain.slice(0, 3), { highway: 'residential', name: 'Alders Ln' })
addWay(aldersChain.slice(2, 5), { highway: 'residential', name: 'Alders Ln' })
addWay(aldersChain.slice(4, 7), { highway: 'residential', name: 'Alders Ln' })

const graph = buildGraph({ elements })
const startId = snapStartToNetwork(graph, 39.75, -75.55)
graph.startNodeId = startId
analyzeDeadEnds(graph)

// Every edge belonging to Alders Ln should be hard-excluded (since it's a
// pure dead end with no cycle at the far end), none should be reversal-exempt.
let anyAldersEdgeUsable = false
let anyAldersEdgeExempt = false
for (const edge of graph.edges.values()) {
  if (edge.name === 'Alders Ln') {
    if (!graph.hardExcluded.has(edge.key)) anyAldersEdgeUsable = true
    if (graph.reversalExempt.has(edge.key)) anyAldersEdgeExempt = true
  }
}
console.log(anyAldersEdgeUsable ? 'FAIL: some Alders Ln edge is NOT hard-excluded' : 'OK: every Alders Ln edge is hard-excluded')
console.log(anyAldersEdgeExempt ? 'FAIL: some Alders Ln edge is reversal-exempt (would allow partial-then-turnaround)' : 'OK: no Alders Ln edge is reversal-exempt')

// Also confirm a generated route never touches Alders Ln at all.
const route = generateLoopRoute(graph, startId, milesToMeters(3), { seed: 12 })
let routeTouchesAlders = false
if (route) {
  for (const key of route.edgeKeys) {
    if (graph.edges.get(key).name === 'Alders Ln') { routeTouchesAlders = true; break }
  }
}
console.log(routeTouchesAlders ? 'FAIL: generated route used Alders Ln' : 'OK: generated route avoided Alders Ln entirely')

const allPass = !anyAldersEdgeUsable && !anyAldersEdgeExempt && !routeTouchesAlders
console.log(allPass ? '\nALL CHECKS PASSED' : '\nCHECKS FAILED')
process.exit(allPass ? 0 : 1)
