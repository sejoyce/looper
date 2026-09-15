// Verifies: crossing a busy road at an unsignalized intersection is
// hard-blocked (isUnsafeCrossing), while crossing at a signal, or walking
// ALONG the busy road, remain legal.
import { buildGraph } from '../src/lib/graph.js'
import { isUnsafeCrossing } from '../src/lib/routeGenerator.js'

let nodeId = 1
const elements = []
function addNode(lat, lon, tags) { const id = nodeId++; elements.push({ type: 'node', id, lat, lon, tags }); return id }
let wayId = 1
function addWay(nodesArr, tags) { elements.push({ type: 'way', id: wayId++, nodes: nodesArr, tags }) }

const paveIds = []
for (let x = 0; x < 3; x++) {
  const tags = x === 1 ? { highway: 'traffic_signals' } : undefined
  paveIds.push(addNode(39.75, -75.55 + x * 0.0012, tags))
}
addWay(paveIds, { highway: 'primary', name: 'Pennsylvania Ave' })

const northUnsig = addNode(39.751, -75.55) // north of the UNsignalized crossing (index 0)
const southUnsig = addNode(39.749, -75.55)
addWay([paveIds[0], northUnsig], { highway: 'residential', name: 'North St' })
addWay([paveIds[0], southUnsig], { highway: 'residential', name: 'South St' })

const northSig = addNode(39.751, -75.55 + 0.0012) // north/south of the SIGNALIZED crossing
const southSig = addNode(39.749, -75.55 + 0.0012)
addWay([paveIds[1], northSig], { highway: 'residential', name: 'North St 2' })
addWay([paveIds[1], southSig], { highway: 'residential', name: 'South St 2' })

const graph = buildGraph({ elements })

function edgeBetween(a, b) {
  for (const e of graph.edges.values()) if (e.from === a && e.to === b) return e
  return null
}

// Crossing AT the unsignalized node: arrive via North St, leave via South St
const crossUnsigArrive = edgeBetween(northUnsig, paveIds[0])
const crossUnsigLeave = edgeBetween(paveIds[0], southUnsig)
const unsafe1 = isUnsafeCrossing(graph, crossUnsigArrive, crossUnsigLeave)

// Crossing AT the signalized node
const crossSigArrive = edgeBetween(northSig, paveIds[1])
const crossSigLeave = edgeBetween(paveIds[1], southSig)
const unsafe2 = isUnsafeCrossing(graph, crossSigArrive, crossSigLeave)

// Walking ALONG the avenue itself (arrive via the avenue, continue along it)
const alongArrive = edgeBetween(paveIds[0], paveIds[1])
const alongLeave = edgeBetween(paveIds[1], paveIds[2])
const unsafe3 = isUnsafeCrossing(graph, alongArrive, alongLeave)

console.log(`Crossing at UNsignalized node -> unsafe: ${unsafe1} (expect true)`)
console.log(`Crossing at signalized node -> unsafe: ${unsafe2} (expect false)`)
console.log(`Walking along the avenue itself -> unsafe: ${unsafe3} (expect false)`)

const ok = unsafe1 === true && unsafe2 === false && unsafe3 === false
console.log(ok ? '\nALL BUSY-ROAD CHECKS PASSED' : '\nCHECKS FAILED')
process.exit(ok ? 0 : 1)
