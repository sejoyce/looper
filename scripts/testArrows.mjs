import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute, computeDirectionArrows } from '../src/lib/routeGenerator.js'
import { milesToMeters, metersToMiles } from '../src/lib/geo.js'

let nodeId = 1
const elements = []
function addNode(lat, lon) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }
const SIZE = 8, SPACING = 0.001
const ids = {}
for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) ids[`${x},${y}`] = addNode(39.75 + y * SPACING, -75.55 + x * SPACING)
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(ids[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Row ${y}` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(ids[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Col ${x}` }) }

const graph = buildGraph({ elements })
const startId = snapStartToNetwork(graph, 39.75, -75.55)
graph.startNodeId = startId
analyzeDeadEnds(graph)

const route = generateLoopRoute(graph, startId, milesToMeters(3), { seed: 5 })
const arrows = computeDirectionArrows(graph, route.edgeKeys)

console.log(`Route: ${metersToMiles(route.distanceMeters).toFixed(2)}mi, ${route.edgeKeys.length} edges`)
console.log(`Arrows placed: ${arrows.length}`)
console.log('Sample arrows:', arrows.slice(0, 3).map(a => ({ lat: a.lat.toFixed(5), lon: a.lon.toFixed(5), bearing: a.bearing.toFixed(0) })))

const ok = arrows.length > 3 && arrows.every(a => a.bearing >= 0 && a.bearing < 360 && Number.isFinite(a.lat) && Number.isFinite(a.lon))
console.log(ok ? '\nARROW CHECKS PASSED' : '\nARROW CHECKS FAILED')
process.exit(ok ? 0 : 1)
