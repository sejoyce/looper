import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { findWaypointLoop, generateLoopRoute } from '../src/lib/routeGenerator.js'
import { pickTargetCluster } from '../src/lib/trailSeeking.js'
import { metersToMiles, milesToMeters } from '../src/lib/geo.js'

let nodeId = 1
const elements = []
function addNode(lat, lon) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }

const PARK_RADIUS_DEG = 0.0025
const PARK_POINTS = 16
const parkIds = []
for (let i = 0; i < PARK_POINTS; i++) {
  const theta = (i / PARK_POINTS) * 2 * Math.PI
  parkIds.push(addNode(39.75 + Math.sin(theta) * PARK_RADIUS_DEG, -75.57 + Math.cos(theta) * PARK_RADIUS_DEG))
}
addWay([...parkIds, parkIds[0]], { highway: 'path', surface: 'dirt', name: 'Rockford Park Loop' })
const homeId = addNode(39.75, -75.5735)
addWay([homeId, parkIds[0]], { highway: 'residential', name: 'Kentmere Pkwy' })
const SIZE = 20, SPACING = 0.001
const gridIds = {}
for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) gridIds[`${x},${y}`] = addNode(39.76 + y * SPACING, -75.58 + x * SPACING)
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(gridIds[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Grid Row ${y}` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(gridIds[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Grid Col ${x}` }) }
addWay([homeId, gridIds['0,0']], { highway: 'residential', name: 'Connector St' })

const graph = buildGraph({ elements })
const startId = snapStartToNetwork(graph, 39.75, -75.5735)
graph.startNodeId = startId
analyzeDeadEnds(graph)

const target = pickTargetCluster(graph, startId, milesToMeters(8) * 0.4)
console.log('pickTargetCluster result:', target ? { distMi: metersToMiles(target.distanceMeters).toFixed(2), trailMi: metersToMiles(target.trailMeters).toFixed(2) } : null)

let worstMaxPasses = 0
for (const seed of [1, 2, 3, 4, 5]) {
  const wp = findWaypointLoop(graph, startId, milesToMeters(8), { seed })
  if (!wp) { console.log(`seed ${seed}: waypoint FAILED`); continue }
  const parkCounts = new Map()
  for (const key of wp.edgeKeys) {
    const edge = graph.edges.get(key)
    if (edge.name === 'Rockford Park Loop') {
      const canon = edge.key < edge.reverseKey ? edge.key : edge.reverseKey
      parkCounts.set(canon, (parkCounts.get(canon) || 0) + 1)
    }
  }
  const maxPasses = Math.max(0, ...parkCounts.values())
  worstMaxPasses = Math.max(worstMaxPasses, maxPasses)
  console.log(`seed ${seed}: dist=${metersToMiles(wp.distanceMeters).toFixed(2)}mi trail=${Math.round(wp.trailFraction*100)}% newStreet=${Math.round(wp.newStreetFraction*100)}% maxParkPasses=${maxPasses}`)
}

// Originally reproduced up to 7 passes on a single park segment before the
// escalating reuse penalty + hard MAX_EDGE_REUSE cap fix.
const ok = worstMaxPasses <= 2
console.log(ok ? `\nOK: no segment reused more than ${worstMaxPasses} times (cap working)` : `\nFAIL: a segment was reused ${worstMaxPasses} times - reuse cap not effective`)
process.exit(ok ? 0 : 1)
