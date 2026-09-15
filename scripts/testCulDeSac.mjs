// Simulates a realistic suburb: a sparse core grid (through streets) with
// MANY cul-de-sac branches hanging off it (dead ends) - this is exactly the
// topology that broke the old "never reverse any edge" rule, since cul-de-sacs
// are literally impossible to visit without a forced U-turn.
import { buildGraph, nearestNode, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { metersToMiles, milesToMeters } from '../src/lib/geo.js'

const CORE = 10 // 10x10 sparse core grid
const SPACING = 0.0011 // ~120m
let nodeId = 1
const nodeIds = {}
const elements = []

function addNode(lat, lon, tags) {
  const id = nodeId++
  elements.push({ type: 'node', id, lat, lon, tags })
  return id
}

// Core grid (through streets) - only every other row/col connects, to keep
// it sparse like a real subdivision's collector roads.
for (let x = 0; x < CORE; x++) {
  for (let y = 0; y < CORE; y++) {
    nodeIds[`${x},${y}`] = addNode(39.95 + y * SPACING, -75.16 + x * SPACING)
  }
}
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }
for (let y = 0; y < CORE; y++) { const row = []; for (let x = 0; x < CORE; x++) row.push(nodeIds[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Core Row ${y}` }) }
for (let x = 0; x < CORE; x++) { const col = []; for (let y = 0; y < CORE; y++) col.push(nodeIds[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Core Col ${x}` }) }

// Hang a cul-de-sac branch (3-5 segment dead-end chain) off MOST core nodes,
// pointing outward. This means most of the "extra" street mileage in this
// suburb is only reachable via a forced U-turn.
let culId = 0
for (let x = 1; x < CORE - 1; x++) {
  for (let y = 1; y < CORE - 1; y++) {
    if ((x + y) % 2 !== 0) continue // hang off every other node
    culId++
    const baseId = nodeIds[`${x},${y}`]
    const baseNode = elements.find((e) => e.type === 'node' && e.id === baseId)
    const chain = [baseId]
    const dirLat = ((culId % 4) - 1.5) * 0.0003
    const dirLon = (((culId * 3) % 4) - 1.5) * 0.0003
    const segments = 2 + (culId % 3) // 2-4 segments deep
    let lat = baseNode.lat
    let lon = baseNode.lon
    for (let s = 0; s < segments; s++) {
      lat += dirLat * (0.6 + 0.4 * Math.sin(s))
      lon += dirLon * (0.6 + 0.4 * Math.cos(s))
      chain.push(addNode(lat, lon))
    }
    addWay(chain, { highway: 'residential', name: `Cul-de-sac ${culId}` })
  }
}

const graph = buildGraph({ elements })
const start = nearestNode(graph, 39.95 + 5 * SPACING, -75.16 + 5 * SPACING)
graph.startNodeId = start.id
analyzeDeadEnds(graph)
console.log(`Graph: ${graph.nodes.size} nodes, ${graph.edges.size} directed edges, ${graph.spurEdges.size} spur (dead-end) edges, ${graph.hardExcluded.size} hard-excluded`)

for (const targetMiles of [3, 5, 8]) {
  const targetMeters = milesToMeters(targetMiles)
  const t0 = performance.now()
  const route = generateLoopRoute(graph, start.id, targetMeters, { seed: 77 + targetMiles })
  const elapsed = performance.now() - t0

  if (!route) {
    console.log(`target ${targetMiles}mi -> FAILED, no route at all`)
    continue
  }
  const actualMiles = metersToMiles(route.distanceMeters)
  const errMiles = Math.abs(actualMiles - targetMiles)

  // Validate: no illegal reversal (spur edges exempted)
  const used = new Set()
  let violation = null
  for (const key of route.edgeKeys) {
    const edge = graph.edges.get(key)
    if (used.has(edge.reverseKey) && !graph.reversalExempt.has(edge.key)) { violation = key; break }
    if (graph.hardExcluded.has(key)) { violation = `${key} (hard-excluded dead-end used!)`; break }
    used.add(key)
  }

  console.log(
    `target ${targetMiles}mi -> got ${actualMiles.toFixed(3)}mi (err ${(errMiles*5280).toFixed(0)}ft) ` +
    `laps=${route.laps} withinTol=${route.withinTolerance} turns=${route.turnCount} time=${elapsed.toFixed(0)}ms ` +
    `${violation ? 'REVERSAL VIOLATION!' : 'OK'}`
  )
}
