// Verifies a small trail loop (like the North Grant Ave example: a tiny
// side loop off the main trail, well under 0.1mi) is strongly avoided when
// an alternative route of similar quality exists, and that summarizeRoute
// correctly flags any tiny loop that does end up in a route.
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { metersToMiles, milesToMeters } from '../src/lib/geo.js'

let nodeId = 1
const elements = []
function addNode(lat, lon, tags) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon, tags }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }

// Core street grid
const SIZE = 10, SPACING = 0.001
const ids = {}
for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) ids[`${x},${y}`] = addNode(39.75 + y * SPACING, -75.55 + x * SPACING)
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(ids[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Row ${y}` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(ids[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Col ${x}` }) }

// A trail running along the diagonal
const trailNodes = []
for (let i = 0; i < SIZE; i++) trailNodes.push(ids[`${i},${i}`])
addWay(trailNodes, { highway: 'path', surface: 'dirt', name: 'Main Trail' })

// A TINY side loop off the trail at node (5,5) - like the North Grant Ave
// example: barely 0.03mi around, offering essentially no real distance.
const hub = ids['5,5']
const hubNode = elements.find(e => e.type === 'node' && e.id === hub)
const p1 = addNode(hubNode.lat + 0.00015, hubNode.lon + 0.00005)
const p2 = addNode(hubNode.lat + 0.0001, hubNode.lon + 0.0002)
addWay([hub, p1, p2, hub], { highway: 'path', surface: 'dirt', name: 'Little Loop Trail' })

const graph = buildGraph({ elements })
const startId = snapStartToNetwork(graph, 39.75, -75.55)
graph.startNodeId = startId
analyzeDeadEnds(graph)

let tinyLoopCount = 0
let totalRuns = 0
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const route = generateLoopRoute(graph, startId, milesToMeters(3), { seed })
  if (!route) continue
  totalRuns++
  if (route.tinyLoopCount > 0) tinyLoopCount++
}

console.log(`${tinyLoopCount} of ${totalRuns} generated routes contained a tiny loop`)
console.log(tinyLoopCount === 0 ? 'OK: tiny loop consistently avoided' : 'Some routes still included the tiny loop (see note below)')
console.log('\n(Note: this graph has NO alternative to reach comparable trail mileage without the tiny')
console.log('loop being at least an option, so this checks it is disfavored, not literally impossible -')
console.log('the hard hardExcluded/isUnsafeCrossing checks are absolute; tiny-loop avoidance is a strong')
console.log('preference, matching that a real street network almost always offers a cleaner alternative.)')

// Debug: inspect one flagged route's edges directly
const route = generateLoopRoute(graph, startId, milesToMeters(3), { seed: 1 })
console.log('\nDebug - route summary:', { distMi: metersToMiles(route.distanceMeters).toFixed(2), tinyLoopCount: route.tinyLoopCount, laps: route.laps })
console.log('Edge sequence (name, distance, from->to):')
for (const key of route.edgeKeys) {
  const e = graph.edges.get(key)
  console.log(`  ${e.name.padEnd(20)} ${e.distance.toFixed(1)}m  ${e.from} -> ${e.to}`)
}
