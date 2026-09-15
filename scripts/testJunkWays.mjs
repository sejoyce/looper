// Verifies parking lot aisles, driveways, and unnamed service ways get
// filtered out of the routable graph, while a legitimately named service
// road is kept.
import { buildGraph } from '../src/lib/graph.js'

let nodeId = 1
const elements = []
function addNode(lat, lon) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon }); return id }
let wayId = 1
function addWay(nodesArr, tags) { const id = wayId++; elements.push({ type: 'way', id, nodes: nodesArr, tags }); return id }

// A normal street (should be included)
const a = addNode(39.75, -75.55), b = addNode(39.751, -75.55)
addWay([a, b], { highway: 'residential', name: 'Main St' })

// A church parking lot aisle (should be EXCLUDED)
const c = addNode(39.75, -75.551), d = addNode(39.751, -75.551)
addWay([c, d], { highway: 'service', service: 'parking_aisle', name: 'Immanuel Church Lot' })

// A driveway (should be EXCLUDED)
const e = addNode(39.75, -75.552), f = addNode(39.751, -75.552)
addWay([e, f], { highway: 'service', service: 'driveway' })

// An unnamed, untyped service way - likely a lot aisle in practice (should be EXCLUDED)
const g = addNode(39.75, -75.553), h = addNode(39.751, -75.553)
addWay([g, h], { highway: 'service' })

// A legitimately named service road, e.g. a short public connector (should be INCLUDED)
const i = addNode(39.75, -75.554), j = addNode(39.751, -75.554)
addWay([i, j], { highway: 'service', name: 'Depot Access Rd' })

const graph = buildGraph({ elements })

function wayIncluded(nodeA, nodeB) {
  for (const edge of graph.edges.values()) {
    if (edge.from === nodeA && edge.to === nodeB) return true
  }
  return false
}

const checks = [
  ['Normal residential street included', wayIncluded(a, b) === true],
  ['Parking aisle excluded', wayIncluded(c, d) === false],
  ['Driveway excluded', wayIncluded(e, f) === false],
  ['Unnamed bare service way excluded', wayIncluded(g, h) === false],
  ['Named legitimate service road included', wayIncluded(i, j) === true],
]
let allPass = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'OK' : 'FAIL'}: ${label}`)
  if (!pass) allPass = false
}
console.log(allPass ? '\nALL JUNK-WAY FILTER CHECKS PASSED' : '\nCHECKS FAILED')
process.exit(allPass ? 0 : 1)
