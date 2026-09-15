// Synthetic 12x12 street grid with a diagonal "trail" cutting through it,
// plus traffic signals at a subset of intersections - used to sanity-check
// the route generator without needing live Overpass access.
import { buildGraph, nearestNode, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute, summarizeSegments } from '../src/lib/routeGenerator.js'
import { metersToMiles } from '../src/lib/geo.js'

const SIZE = 12
const SPACING_DEG = 0.0012 // ~130m per block
let nodeId = 1
const nodeIds = {}
const elements = []

for (let x = 0; x < SIZE; x++) {
  for (let y = 0; y < SIZE; y++) {
    const id = nodeId++
    nodeIds[`${x},${y}`] = id
    const hasSignal = (x + y) % 5 === 0 && x > 0 && y > 0
    elements.push({
      type: 'node',
      id,
      lat: 39.95 + y * SPACING_DEG,
      lon: -75.16 + x * SPACING_DEG,
      tags: hasSignal ? { highway: 'traffic_signals' } : undefined,
    })
  }
}

let wayId = 1
function addWay(nodesArr, tags) {
  elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags })
}

// Horizontal & vertical street grid
for (let y = 0; y < SIZE; y++) {
  const row = []
  for (let x = 0; x < SIZE; x++) row.push(nodeIds[`${x},${y}`])
  addWay(row, { highway: 'residential', name: `Row ${y} St` })
}
for (let x = 0; x < SIZE; x++) {
  const col = []
  for (let y = 0; y < SIZE; y++) col.push(nodeIds[`${x},${y}`])
  addWay(col, { highway: 'residential', name: `Col ${x} Ave` })
}

// A diagonal trail
const trailNodes = []
for (let i = 0; i < SIZE; i++) trailNodes.push(nodeIds[`${i},${i}`])
addWay(trailNodes, { highway: 'path', surface: 'dirt', name: 'Ridge Trail' })

const osmData = { elements }
const graph = buildGraph(osmData)
const start = nearestNode(graph, 39.95, -75.16)
graph.startNodeId = start.id
analyzeDeadEnds(graph)
console.log(`Graph: ${graph.nodes.size} nodes, ${graph.edges.size} directed edges`)

const targetMiles = 3.0
const targetMeters = targetMiles * 1609.344

const route = generateLoopRoute(graph, start.id, targetMeters, { seed: 42 })
if (!route) {
  console.error('FAILED: no route found')
  process.exit(1)
}

console.log(`Route distance: ${metersToMiles(route.distanceMeters).toFixed(2)} mi (target ${targetMiles})`)
console.log(`Trail fraction: ${(route.trailFraction * 100).toFixed(1)}%`)
console.log(`Signal count: ${route.signalCount}`)
console.log(`New street fraction: ${(route.newStreetFraction * 100).toFixed(1)}%`)
console.log(`Turn count: ${route.turnCount} (sharp: ${route.sharpTurnCount})`)
console.log(`Laps: ${route.laps}`)

// --- Validate no-reversal (no U-turn / no "turn around on same street") ---
const usedForward = new Set()
let violation = null
for (const key of route.edgeKeys) {
  const edge = graph.edges.get(key)
  if (usedForward.has(edge.reverseKey)) {
    violation = key
    break
  }
  usedForward.add(key)
}
console.log(violation ? `VIOLATION: reversed edge ${violation}` : 'OK: no edge was ever reversed')

// --- Validate the path is contiguous and closes the loop ---
let contiguous = true
for (let i = 1; i < route.edgeKeys.length; i++) {
  const prevEdge = graph.edges.get(route.edgeKeys[i - 1])
  const curEdge = graph.edges.get(route.edgeKeys[i])
  if (prevEdge.to !== curEdge.from) contiguous = false
}
const firstEdge = graph.edges.get(route.edgeKeys[0])
const lastEdge = graph.edges.get(route.edgeKeys[route.edgeKeys.length - 1])
const closesLoop = firstEdge.from === start.id && lastEdge.to === start.id
console.log(contiguous ? 'OK: path is contiguous' : 'VIOLATION: path is NOT contiguous')
console.log(closesLoop ? 'OK: path starts and ends at the start node' : 'VIOLATION: path does not close the loop')

const segments = summarizeSegments(graph, route.edgeKeys)
console.log(`\nSegments (${segments.length}):`)
for (const s of segments) {
  console.log(`  ${s.isTrail ? '[trail]' : '       '} ${s.name} - ${metersToMiles(s.distance).toFixed(2)} mi`)
}

if (!violation && contiguous && closesLoop) {
  console.log('\nALL CHECKS PASSED')
} else {
  console.log('\nCHECKS FAILED')
  process.exit(1)
}
