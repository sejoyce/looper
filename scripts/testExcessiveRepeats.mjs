// Reproduces the reported bug: a small, attractive trail loop (like
// Rockford Park) near home, connected to a much larger street network, but
// the route repeats the small loop 5+ times instead of exploring the
// bigger network that's readily available.
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { metersToMiles, milesToMeters } from '../src/lib/geo.js'

let nodeId = 1
const elements = []
function addNode(lat, lon) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }

// A small park loop (~1.1mi, like Rockford Park) - a trail-tagged cycle.
const PARK_RADIUS_DEG = 0.0025
const PARK_POINTS = 16
const parkIds = []
for (let i = 0; i < PARK_POINTS; i++) {
  const theta = (i / PARK_POINTS) * 2 * Math.PI
  parkIds.push(addNode(39.75 + Math.sin(theta) * PARK_RADIUS_DEG, -75.57 + Math.cos(theta) * PARK_RADIUS_DEG))
}
addWay([...parkIds, parkIds[0]], { highway: 'path', surface: 'dirt', name: 'Rockford Park Loop' })

// A short connector from the park to a home address just outside it.
const homeId = addNode(39.75, -75.5735)
addWay([homeId, parkIds[0]], { highway: 'residential', name: 'Kentmere Pkwy' })

// A LARGE surrounding street grid (plenty of fresh mileage available -
// 20x20 blocks at ~110m spacing = a good ~1.4mi x 1.4mi neighborhood).
const SIZE = 20, SPACING = 0.001
const gridIds = {}
for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) gridIds[`${x},${y}`] = addNode(39.76 + y * SPACING, -75.58 + x * SPACING)
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(gridIds[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Grid Row ${y}` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(gridIds[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Grid Col ${x}` }) }
// Connect the grid to home.
addWay([homeId, gridIds['0,0']], { highway: 'residential', name: 'Connector St' })

const graph = buildGraph({ elements })
const startId = snapStartToNetwork(graph, 39.75, -75.5735)
graph.startNodeId = startId
analyzeDeadEnds(graph)

console.log(`Graph: ${graph.nodes.size} nodes. Park loop ~1.1mi. Grid offers ~${(19*2*SPACING*69).toFixed(1)}mi of perimeter alone, much more total street.`)

for (const targetMiles of [5, 8]) {
  const route = generateLoopRoute(graph, startId, milesToMeters(targetMiles), { seed: 77 })
  if (!route) { console.log(`${targetMiles}mi -> FAILED`); continue }

  // Count how many times the park loop specifically is traversed.
  const parkEdgeTraversals = new Map() // canonical segment -> count
  let parkDistance = 0
  for (const key of route.edgeKeys) {
    const edge = graph.edges.get(key)
    if (edge.name === 'Rockford Park Loop') {
      const canon = edge.key < edge.reverseKey ? edge.key : edge.reverseKey
      parkEdgeTraversals.set(canon, (parkEdgeTraversals.get(canon) || 0) + 1)
      parkDistance += edge.distance
    }
  }
  const maxPassesOnOneSegment = Math.max(0, ...parkEdgeTraversals.values())

  console.log(
    `\n${targetMiles}mi target -> got ${metersToMiles(route.distanceMeters).toFixed(2)}mi, ` +
    `trail=${Math.round(route.trailFraction*100)}%, newStreet=${Math.round(route.newStreetFraction*100)}%, ` +
    `park loop total distance used: ${metersToMiles(parkDistance).toFixed(2)}mi, ` +
    `max passes on any single park segment: ${maxPassesOnOneSegment}`
  )
  console.log(maxPassesOnOneSegment >= 3 ? '  ISSUE REPRODUCED: excessive repetition of the park loop' : '  OK: reasonable repetition')
}
