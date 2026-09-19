// Times the backbone computation specifically on a realistically-sized
// dense graph, to check whether it's a major contributor to first-load time.
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { milesToMeters } from '../src/lib/geo.js'
import { selectHullNodeIds } from '../src/lib/backbone.js'

// A larger, denser, more irregular grid to approximate real city density
// within an 8mi-target query radius (~5mi radius).
let nodeId = 1
const elements = []
function addNode(lat, lon) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }

const SIZE = 70, SPACING = 0.0012 // ~130m blocks, 70x70 = ~5.7mi x 5.7mi span
const ids = {}
for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) ids[`${x},${y}`] = addNode(39.75 + y * SPACING, -75.55 + x * SPACING)
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(ids[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Row ${y}` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(ids[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Col ${x}` }) }

console.log(`Building graph with ${SIZE}x${SIZE} = ${SIZE*SIZE} nodes...`)
let t0 = performance.now()
const graph = buildGraph({ elements })
console.log(`buildGraph: ${(performance.now()-t0).toFixed(0)}ms, ${graph.nodes.size} nodes, ${graph.edges.size} edges`)

t0 = performance.now()
const startId = snapStartToNetwork(graph, 39.75 + 35*SPACING, -75.55 + 35*SPACING)
graph.startNodeId = startId
console.log(`snapStartToNetwork: ${(performance.now()-t0).toFixed(0)}ms`)

t0 = performance.now()
analyzeDeadEnds(graph)
console.log(`analyzeDeadEnds: ${(performance.now()-t0).toFixed(0)}ms`)

t0 = performance.now()
const maxReachMeters = Math.max(500, milesToMeters(8) * 0.5)
const hullIds = selectHullNodeIds(graph, startId, maxReachMeters)
console.log(`selectHullNodeIds: ${(performance.now()-t0).toFixed(0)}ms, hull has ${hullIds.length} points`)

t0 = performance.now()
const route = generateLoopRoute(graph, startId, milesToMeters(8), { seed: 1 })
const totalTime = performance.now()-t0
console.log(`generateLoopRoute (includes backbone computation on first call): ${totalTime.toFixed(0)}ms`)
console.log(`Backbone edges after first call: ${graph.backboneEdges.size}`)

t0 = performance.now()
const route2 = generateLoopRoute(graph, startId, milesToMeters(8), { seed: 2 })
console.log(`generateLoopRoute (2nd call, backbone cached): ${(performance.now()-t0).toFixed(0)}ms`)

console.log(`\nRoute quality check for early-exit condition:`)
console.log({
  withinTolerance: route.withinTolerance,
  tinyLoopCount: route.tinyLoopCount,
  turnsPerMile: (route.turnCount / (route.distanceMeters/1609.344)).toFixed(1),
  wouldEarlyExit: route.withinTolerance && route.tinyLoopCount === 0 && (route.turnCount / (route.distanceMeters/1609.344)) <= 14
})
