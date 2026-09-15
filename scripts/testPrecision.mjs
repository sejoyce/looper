import { buildGraph, nearestNode, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { metersToMiles, milesToMeters } from '../src/lib/geo.js'

function buildTestGrid(size, spacingDeg, withTrail = true) {
  let nodeId = 1
  const nodeIds = {}
  const elements = []
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const id = nodeId++
      nodeIds[`${x},${y}`] = id
      const hasSignal = (x + y) % 6 === 0 && x > 0 && y > 0
      elements.push({ type: 'node', id, lat: 39.95 + y * spacingDeg, lon: -75.16 + x * spacingDeg, tags: hasSignal ? { highway: 'traffic_signals' } : undefined })
    }
  }
  let wayId = 1
  function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }
  for (let y = 0; y < size; y++) { const row = []; for (let x = 0; x < size; x++) row.push(nodeIds[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Row ${y} St` }) }
  for (let x = 0; x < size; x++) { const col = []; for (let y = 0; y < size; y++) col.push(nodeIds[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Col ${x} Ave` }) }
  if (withTrail) {
    const trailNodes = []
    for (let i = 0; i < size; i++) trailNodes.push(nodeIds[`${i},${i}`])
    addWay(trailNodes, { highway: 'path', surface: 'dirt', name: 'Ridge Trail' })
  }
  return { elements }
}

function runTest(label, size, spacingDeg, targetMiles, seed) {
  const graph = buildGraph(buildTestGrid(size, spacingDeg))
  const start = nearestNode(graph, 39.95, -75.16)
  graph.startNodeId = start.id
  analyzeDeadEnds(graph)
  const targetMeters = milesToMeters(targetMiles)
  const t0 = performance.now()
  const route = generateLoopRoute(graph, start.id, targetMeters, { seed })
  const elapsed = performance.now() - t0

  if (!route) {
    console.log(`[${label}] target ${targetMiles}mi -> FAILED (no route)`)
    return false
  }
  const actualMiles = metersToMiles(route.distanceMeters)
  const errMiles = Math.abs(actualMiles - targetMiles)
  const usedForward = new Set()
  let reversal = false
  for (const key of route.edgeKeys) {
    const edge = graph.edges.get(key)
    if (usedForward.has(edge.reverseKey)) { reversal = true; break }
    usedForward.add(key)
  }
  console.log(
    `[${label}] target ${targetMiles}mi -> got ${actualMiles.toFixed(3)}mi ` +
    `(err ${errMiles.toFixed(3)}mi, ${(errMiles*5280).toFixed(0)}ft) laps=${route.laps} ` +
    `withinTol=${route.withinTolerance} turns=${route.turnCount} time=${elapsed.toFixed(0)}ms ` +
    `${reversal ? 'REVERSAL VIOLATION!' : 'OK'}`
  )
  return errMiles <= 0.05 + 1e-9 || route.laps > 1 // laps fallback is allowed to be less precise, single loops must hit 0.05
}

console.log('=== Small grid (12x12, ~130m blocks, ~1mi x 1mi area) ===')
runTest('small-3mi', 12, 0.0012, 3, 1)
runTest('small-5mi', 12, 0.0012, 5, 2)
runTest('small-8mi', 12, 0.0012, 8, 3)

console.log('\n=== Medium grid (24x24, ~110m blocks, ~1.8mi x 1.8mi area) ===')
runTest('med-3mi', 24, 0.001, 3, 10)
runTest('med-5mi', 24, 0.001, 5, 11)
runTest('med-8mi', 24, 0.001, 8, 12)
runTest('med-5mi-seed2', 24, 0.001, 5, 20)
runTest('med-5mi-seed3', 24, 0.001, 5, 30)

console.log('\n=== Tiny grid (6x6, ~80m blocks, ~0.3mi x 0.3mi area) - forces laps fallback ===')
runTest('tiny-5mi', 6, 0.0007, 5, 40)
runTest('tiny-8mi', 6, 0.0007, 8, 41)

console.log('\n=== Large grid (60x60, ~100m blocks, ~3.7mi x 3.7mi area) - perf check ===')
runTest('large-5mi', 60, 0.0009, 5, 50)
runTest('large-8mi', 60, 0.0009, 8, 51)
