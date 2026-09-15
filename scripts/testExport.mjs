import { buildGraph, nearestNode, analyzeDeadEnds } from '../src/lib/graph.js'
import { generateLoopRoute } from '../src/lib/routeGenerator.js'
import { buildTcxCourse, buildGpx } from '../src/lib/exportCourse.js'

// Reuse the same synthetic grid builder as testGrid.mjs
const SIZE = 12
const SPACING_DEG = 0.0012
let nodeId = 1
const nodeIds = {}
const elements = []
for (let x = 0; x < SIZE; x++) {
  for (let y = 0; y < SIZE; y++) {
    const id = nodeId++
    nodeIds[`${x},${y}`] = id
    const hasSignal = (x + y) % 5 === 0 && x > 0 && y > 0
    elements.push({ type: 'node', id, lat: 39.95 + y * SPACING_DEG, lon: -75.16 + x * SPACING_DEG, tags: hasSignal ? { highway: 'traffic_signals' } : undefined })
  }
}
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }
for (let y = 0; y < SIZE; y++) { const row = []; for (let x = 0; x < SIZE; x++) row.push(nodeIds[`${x},${y}`]); addWay(row, { highway: 'residential', name: `Row ${y} St` }) }
for (let x = 0; x < SIZE; x++) { const col = []; for (let y = 0; y < SIZE; y++) col.push(nodeIds[`${x},${y}`]); addWay(col, { highway: 'residential', name: `Col ${x} Ave` }) }
const trailNodes = []
for (let i = 0; i < SIZE; i++) trailNodes.push(nodeIds[`${i},${i}`])
addWay(trailNodes, { highway: 'path', surface: 'dirt', name: 'Ridge Trail' })

const graph = buildGraph({ elements })
const start = nearestNode(graph, 39.95, -75.16)
graph.startNodeId = start.id
analyzeDeadEnds(graph)
const route = generateLoopRoute(graph, start.id, 3 * 1609.344, { seed: 7 })

const tcx = buildTcxCourse(graph, route.edgeKeys, 'Test Loop 3mi')
const gpx = buildGpx(graph, route.edgeKeys, 'Test Loop 3mi')

// Basic structural sanity checks
const checks = [
  ['TCX has XML declaration', tcx.startsWith('<?xml')],
  ['TCX has Course', tcx.includes('<Course>')],
  ['TCX has Trackpoints', (tcx.match(/<Trackpoint>/g) || []).length > 5],
  ['TCX has CoursePoints', (tcx.match(/<CoursePoint>/g) || []).length > 0],
  ['TCX has Start cue', tcx.includes('>Start<')],
  ['TCX has Finish cue', tcx.includes('>Finish<')],
  ['TCX PointType is Left/Right/Generic only', !/<PointType>(?!Left|Right|Generic)/.test(tcx)],
  ['GPX has XML declaration', gpx.startsWith('<?xml')],
  ['GPX has rtept points', (gpx.match(/<rtept/g) || []).length > 5],
]
let allPass = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'OK' : 'FAIL'}: ${label}`)
  if (!pass) allPass = false
}
console.log(`\nCoursePoint count: ${(tcx.match(/<CoursePoint>/g) || []).length}, matches turnCount+2 (start/finish) = ${route.turnCount + 2}`)
console.log(allPass ? '\nALL EXPORT CHECKS PASSED' : '\nEXPORT CHECKS FAILED')
process.exit(allPass ? 0 : 1)
