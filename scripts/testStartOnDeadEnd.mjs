// Verifies: (1) an address that snaps mid-segment gets an exact synthetic
// node there (not the nearest intersection), and (2) when that start point
// itself sits on a dead-end street, the mandatory connector is usable (and
// reversible) while all OTHER dead ends stay fully excluded.
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { metersToMiles, milesToMeters, haversine } from '../src/lib/geo.js'

const SIZE = 10
const SPACING = 0.0011
let nodeId = 1
const nodeIds = {}
const elements = []
function addNode(lat, lon, tags) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon, tags }); return id }
for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) nodeIds[`${x},${y}`] = addNode(39.95 + y * SPACING, -75.16 + x * SPACING)
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(nodeIds[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Row ${y}` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(nodeIds[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Col ${x}` }) }

// Attach a 3-segment dead-end cul-de-sac off node (5,5), heading away from the grid.
const branchStart = nodeIds['5,5']
const bNode = elements.find(e => e.type === 'node' && e.id === branchStart)
const chain = [branchStart]
let lat = bNode.lat, lon = bNode.lon
for (let s = 0; s < 3; s++) { lat += 0.0004; lon += 0.0003; chain.push(addNode(lat, lon)) }
addWay(chain, { highway: 'residential', name: 'Quiet Court' })
const deadEndTipId = chain[chain.length - 1]
const deadEndTip = elements.find(e => e.type === 'node' && e.id === deadEndTipId)

console.log('--- Test 1: strict mid-segment snapping ---')
const graph1 = buildGraph({ elements })
// Pick a point clearly mid-block on "Row 3" between grid columns 4 and 5.
const midLat = 39.95 + 3 * SPACING
const midLon = -75.16 + 4.5 * SPACING
const startId1 = snapStartToNetwork(graph1, midLat, midLon)
const startNode1 = graph1.nodes.get(startId1)
const snapDist = haversine(midLat, midLon, startNode1.lat, startNode1.lon)
console.log(`Requested point -> snapped ${snapDist.toFixed(2)}m away, node id: ${startId1}`)
console.log(snapDist < 1 ? 'OK: snapped essentially exactly onto the network' : 'UNEXPECTED: snap distance larger than expected')
console.log(`Node degree after split: ${(graph1.adjacency.get(startId1) || []).length} (expect 2, mid-segment)`)

console.log('\n--- Test 2: address literally on a dead-end (cul-de-sac tip) ---')
const graph2 = buildGraph({ elements })
const startId2 = snapStartToNetwork(graph2, deadEndTip.lat, deadEndTip.lon)
graph2.startNodeId = startId2
analyzeDeadEnds(graph2)
console.log(`Start snapped to node ${startId2} (should equal original dead-end tip id ${deadEndTipId}: ${startId2 === deadEndTipId})`)
console.log(`Spur edges: ${graph2.spurEdges.size}, hard-excluded: ${graph2.hardExcluded.size}, reversal-exempt: ${graph2.reversalExempt.size}`)

const route = generateLoopRoute(graph2, startId2, milesToMeters(3), { seed: 3 })
if (!route) {
  console.log('FAILED: could not generate a route starting from a dead-end address')
} else {
  console.log(`Route: ${metersToMiles(route.distanceMeters).toFixed(3)}mi, turns=${route.turnCount}`)
  // Validate: first and last edges must be the mandatory connector (reversalExempt), and no OTHER dead end appears anywhere.
  const firstEdge = graph2.edges.get(route.edgeKeys[0])
  const lastEdge = graph2.edges.get(route.edgeKeys[route.edgeKeys.length - 1])
  console.log(`First edge is reversal-exempt connector: ${graph2.reversalExempt.has(firstEdge.key)}`)
  console.log(`Last edge is reversal-exempt connector: ${graph2.reversalExempt.has(lastEdge.key)}`)
  let usedHardExcluded = false
  for (const key of route.edgeKeys) {
    if (graph2.hardExcluded.has(key)) { usedHardExcluded = true; break }
  }
  console.log(usedHardExcluded ? 'VIOLATION: route used a hard-excluded dead end!' : 'OK: no hard-excluded dead end used elsewhere in the route')
}
