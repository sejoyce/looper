// Simulates the Rockford Park scenario: a home neighborhood (small local
// grid, enough street to loop locally and "satisfy" a naive search) with a
// much larger, richer trail network (like Alapocas Run / Northern Delaware
// Greenway) reachable but requiring several blocks of plain street travel
// to get there. Verifies the search actually reaches for it instead of
// settling for the local loop.
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { metersToMiles, milesToMeters } from '../src/lib/geo.js'

let nodeId = 1
const elements = []
function addNode(lat, lon, tags) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon, tags }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }

// Home neighborhood: small 6x6 grid (like the Highlands/Forty Acres) - just
// big enough to loop for ~2-3mi locally without ever needing to leave.
const HOME_SIZE = 6
const HOME_SPACING = 0.0009 // ~100m
const homeIds = {}
for (let x = 0; x < HOME_SIZE; x++) for (let y = 0; y < HOME_SIZE; y++) homeIds[`${x},${y}`] = addNode(39.760 + y * HOME_SPACING, -75.570 + x * HOME_SPACING)
for (let y = 0; y < HOME_SIZE; y++) { const row = []; for (let x = 0; x < HOME_SIZE; x++) row.push(homeIds[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Highlands Row ${y}` }) }
for (let x = 0; x < HOME_SIZE; x++) { const col = []; for (let y = 0; y < HOME_SIZE; y++) col.push(homeIds[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Highlands Col ${x}` }) }

// A connector road running ~1.3 miles from the edge of the home grid out to
// a big trail network (like Kentmere Parkway -> Augustine Cut-off).
const connectorStart = homeIds[`${HOME_SIZE - 1},${Math.floor(HOME_SIZE / 2)}`]
const connectorNodes = [connectorStart]
let clat = 39.760 + Math.floor(HOME_SIZE / 2) * HOME_SPACING
let clon = -75.570 + (HOME_SIZE - 1) * HOME_SPACING
for (let s = 0; s < 12; s++) { clon += 0.00018; connectorNodes.push(addNode(clat, clon)) } // ~1.3mi connector
addWay(connectorNodes, { highway: 'tertiary', name: 'Kentmere Pkwy' })
const trailEntranceId = connectorNodes[connectorNodes.length - 1]
const entranceNode = elements.find((e) => e.type === 'node' && e.id === trailEntranceId)

// A rich trail network (like Alapocas Run / Northern Delaware Greenway):
// a grid of trail paths offering lots of mileage.
const TRAIL_SIZE = 8
const TRAIL_SPACING = 0.0008
const trailIds = {}
for (let x = 0; x < TRAIL_SIZE; x++) for (let y = 0; y < TRAIL_SIZE; y++) {
  if (x === 0 && y === 0) { trailIds[`${x},${y}`] = trailEntranceId; continue }
  trailIds[`${x},${y}`] = addNode(entranceNode.lat + y * TRAIL_SPACING, entranceNode.lon + x * TRAIL_SPACING)
}
for (let y = 0; y < TRAIL_SIZE; y++) { const row = []; for (let x = 0; x < TRAIL_SIZE; x++) row.push(trailIds[`${x},${y}`]); addWay(row, { highway: 'path', surface: 'dirt', name: 'Alapocas Run Trail' }) }
for (let x = 0; x < TRAIL_SIZE; x++) { const col = []; for (let y = 0; y < TRAIL_SIZE; y++) col.push(trailIds[`${x},${y}`]); addWay(col, { highway: 'path', surface: 'dirt', name: 'Northern DE Greenway' }) }

const graph = buildGraph({ elements })
const homeAddressLat = 39.760 + 1 * HOME_SPACING
const homeAddressLon = -75.570 + 1 * HOME_SPACING
const startId = snapStartToNetwork(graph, homeAddressLat, homeAddressLon)
graph.startNodeId = startId
analyzeDeadEnds(graph)

console.log(`Graph: ${graph.nodes.size} nodes. Home grid ~${(HOME_SIZE*HOME_SPACING*69).toFixed(2)}mi across. Trail network is ~1.3mi away via Kentmere Pkwy.`)

for (const targetMiles of [3, 6, 8]) {
  const route = generateLoopRoute(graph, startId, milesToMeters(targetMiles), { seed: 500 + targetMiles })
  if (!route) { console.log(`${targetMiles}mi -> FAILED`); continue }
  console.log(
    `${targetMiles}mi target -> got ${metersToMiles(route.distanceMeters).toFixed(2)}mi, ` +
    `trail=${Math.round(route.trailFraction * 100)}%, turns=${route.turnCount}, ` +
    `${route.trailFraction > 0.15 ? 'REACHED THE TRAIL NETWORK' : 'stayed local (no trail reached)'}`
  )
}
