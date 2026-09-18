// Verifies the backbone effect: given a neighborhood with a large, clean
// perimeter loop AND a dense maze of small interior streets offering the
// same total distance, the route should prefer following the perimeter
// (fewer turns) rather than winding through the interior maze.
import { buildGraph, snapStartToNetwork, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { metersToMiles, milesToMeters } from '../src/lib/geo.js'

let nodeId = 1
const elements = []
function addNode(lat, lon) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }

// A dense 14x14 interior maze (small blocks, lots of turns available)
const SIZE = 14, SPACING = 0.0004 // ~44m blocks - a fine-grained maze
const ids = {}
for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) ids[`${x},${y}`] = addNode(39.75 + y * SPACING, -75.55 + x * SPACING)
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(ids[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Maze Row ${y}` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(ids[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Maze Col ${x}` }) }

const graph = buildGraph({ elements })
const centerLat = 39.75 + (SIZE / 2) * SPACING
const centerLon = -75.55 + (SIZE / 2) * SPACING
const startId = snapStartToNetwork(graph, centerLat, centerLon)
graph.startNodeId = startId
analyzeDeadEnds(graph)

// Perimeter length available: 4 sides * (SIZE-1)*SPACING*~111000m/deg ≈
const sideLength = (SIZE - 1) * SPACING * 111000
console.log(`Grid spans ~${(sideLength * 4 / 1609.344).toFixed(2)}mi around the full perimeter`)
console.log(`Backbone edges computed: ${graph.backboneEdges ? 'not yet (lazy)' : 'n/a'}`)

for (const targetMiles of [1.5, 2, 3]) {
  const route = generateLoopRoute(graph, startId, milesToMeters(targetMiles), { seed: 40 + targetMiles })
  if (!route) { console.log(`${targetMiles}mi -> FAILED`); continue }

  // Check how much of the route follows backbone edges
  let backboneMeters = 0
  for (const key of route.edgeKeys) {
    if (graph.backboneEdges.has(key)) backboneMeters += graph.edges.get(key).distance
  }
  const backboneFraction = backboneMeters / route.distanceMeters

  console.log(
    `${targetMiles}mi -> got ${metersToMiles(route.distanceMeters).toFixed(2)}mi, ` +
    `turns=${route.turnCount}, backbone=${Math.round(backboneFraction * 100)}%, ` +
    `turnsPerMile=${(route.turnCount / metersToMiles(route.distanceMeters)).toFixed(1)}`
  )
}

console.log(`\nBackbone edge count: ${graph.backboneEdges.size}`)
console.log(graph.backboneEdges.size > 0 ? 'OK: backbone was computed' : 'FAIL: no backbone found')

console.log('\n--- Multi-seed average for 2mi target ---')
let totalBackboneFrac = 0, totalTurns = 0, n = 0
for (let seed = 100; seed < 110; seed++) {
  const route = generateLoopRoute(graph, startId, milesToMeters(2), { seed })
  if (!route) continue
  let backboneMeters = 0
  for (const key of route.edgeKeys) if (graph.backboneEdges.has(key)) backboneMeters += graph.edges.get(key).distance
  totalBackboneFrac += backboneMeters / route.distanceMeters
  totalTurns += route.turnCount
  n++
}
console.log(`Avg backbone fraction: ${Math.round(100*totalBackboneFrac/n)}%, avg turns: ${(totalTurns/n).toFixed(1)} (n=${n})`)
