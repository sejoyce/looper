import { haversine, projectPointToSegment } from './geo.js'

const TRAIL_HIGHWAYS = new Set(['path', 'track', 'footway', 'pedestrian', 'cycleway'])
const TRAIL_SURFACES = new Set([
  'dirt', 'unpaved', 'ground', 'gravel', 'fine_gravel', 'grass', 'wood',
  'woodchips', 'earth', 'mud', 'sand', 'natural',
])
const AVOID_ACCESS = new Set(['no', 'private'])

// Roads busy/fast enough that crossing them without a real controlled
// crossing point is a genuine safety concern (as opposed to just walking
// along them, which is a separate, milder preference already handled by
// the traffic-signal penalty in the route weighting).
const BUSY_HIGHWAY_TYPES = new Set(['primary', 'secondary', 'trunk', 'primary_link', 'secondary_link', 'trunk_link'])
function isBusyHighway(tags) {
  return !!(tags && BUSY_HIGHWAY_TYPES.has(tags.highway))
}

// A node counts as having a safe, controlled crossing if it's a
// signal/stop-controlled intersection, OR a dedicated pedestrian crossing
// tagged with signals. Anything else (marked or unmarked crosswalk with no
// signal, or just a bare intersection) does not count as safe for crossing
// a busy road, even though it's a normal, legal crossing to walk along.
function hasSafeCrossing(tags) {
  if (!tags) return false
  if (tags.highway === 'traffic_signals' || tags.highway === 'stop') return true
  if (tags.highway === 'crossing' && tags.crossing === 'traffic_signals') return true
  return false
}

// highway=service is used for both legitimate short connector roads AND -
// far more often in practice - parking lot lanes, driveways, and drop-off
// loops that aren't real public streets. Rather than exclude `service`
// entirely (which would also drop the rare legitimate case), we exclude
// specifically the sub-tags that mark clearly private/non-runnable
// pavement, plus any unnamed service way at all (real minor connector
// streets are almost always named; anonymous ones are almost always a lot
// aisle or driveway in practice).
const JUNK_SERVICE_TYPES = new Set(['parking_aisle', 'driveway', 'drive-through', 'bus'])
function isJunkService(tags) {
  if (!tags || tags.highway !== 'service') return false
  if (tags.service && JUNK_SERVICE_TYPES.has(tags.service)) return true
  if (!tags.name) return true
  return false
}

function isTrailWay(tags) {
  if (!tags) return false
  if (tags.highway && TRAIL_HIGHWAYS.has(tags.highway)) {
    // A "footway"/"cycleway" that's really a paved urban sidewalk still
    // counts as pedestrian-friendly, but we reserve the trail bonus for
    // ones that read as genuine trail: track, path, or an unpaved surface.
    if (tags.highway === 'track' || tags.highway === 'path') return true
    if (tags.surface && TRAIL_SURFACES.has(tags.surface)) return true
    return tags.highway === 'footway' || tags.highway === 'pedestrian' || tags.highway === 'cycleway'
  }
  if (tags.surface && TRAIL_SURFACES.has(tags.surface)) return true
  return false
}

function isAccessible(tags) {
  if (!tags) return true
  if (AVOID_ACCESS.has(tags.access) && !tags.foot) return false
  if (AVOID_ACCESS.has(tags.foot)) return false
  return true
}

// edgeKey identifies a directed traversal of a specific street segment.
// Two nodes can be connected by more than one way (e.g. a trail running
// alongside a road), so the key includes the way id, not just node ids.
export function edgeKey(wayId, fromId, toId) {
  return `${wayId}:${fromId}>${toId}`
}
export function reverseEdgeKey(wayId, fromId, toId) {
  return edgeKey(wayId, toId, fromId)
}

// Turns raw Overpass JSON (ways + their nodes, with tags) into a graph:
//   nodes: Map<nodeId, { id, lat, lon, hasSignal, degree }>
//   edges: Map<directedKey, { key, wayId, from, to, distance, name, isTrail, hasStopAtEnd }>
// Each way segment produces two directed edges (there and back) sharing a
// wayId, which is what lets us forbid "reversing" on the exact edge you
// just came from while still allowing the street to be revisited elsewhere.
export function buildGraph(osmData) {
  const nodesRaw = new Map()
  const ways = []

  for (const el of osmData.elements) {
    if (el.type === 'node') {
      nodesRaw.set(el.id, {
        id: el.id,
        lat: el.lat,
        lon: el.lon,
        hasSignal: hasSafeCrossing(el.tags),
      })
    } else if (el.type === 'way') {
      ways.push(el)
    }
  }

  const nodes = new Map()
  const edges = new Map()
  const adjacency = new Map() // nodeId -> [directedEdgeKey, ...]

  function ensureNode(id) {
    if (!nodes.has(id)) {
      const raw = nodesRaw.get(id)
      if (!raw) return null
      nodes.set(id, { ...raw, degree: 0 })
      adjacency.set(id, [])
    }
    return nodes.get(id)
  }

  for (const way of ways) {
    const tags = way.tags || {}
    if (!isAccessible(tags)) continue
    if (isJunkService(tags)) continue
    const trail = isTrailWay(tags)
    const busy = isBusyHighway(tags)
    const name = tags.name || (trail ? 'Unnamed trail' : 'Unnamed road')
    const refs = way.nodes || []

    for (let i = 0; i < refs.length - 1; i++) {
      const aId = refs[i]
      const bId = refs[i + 1]
      const a = ensureNode(aId)
      const b = ensureNode(bId)
      if (!a || !b) continue
      if (a.lat === b.lat && a.lon === b.lon) continue

      const dist = haversine(a.lat, a.lon, b.lat, b.lon)
      if (dist < 0.5) continue // skip zero-length duplicate points

      const forwardKey = edgeKey(way.id, aId, bId)
      const backwardKey = edgeKey(way.id, bId, aId)

      if (!edges.has(forwardKey)) {
        edges.set(forwardKey, {
          key: forwardKey,
          reverseKey: backwardKey,
          wayId: way.id,
          from: aId,
          to: bId,
          distance: dist,
          name,
          isTrail: trail,
          isBusy: busy,
          highway: tags.highway,
        })
        adjacency.get(aId).push(forwardKey)
        a.degree++
      }
      if (!edges.has(backwardKey)) {
        edges.set(backwardKey, {
          key: backwardKey,
          reverseKey: forwardKey,
          wayId: way.id,
          from: bId,
          to: aId,
          distance: dist,
          name,
          isTrail: trail,
          isBusy: busy,
          highway: tags.highway,
        })
        adjacency.get(bId).push(backwardKey)
        b.degree++
      }
    }
  }

  // A node "has a busy road" if any street touching it is one of the fast/
  // major types - used to detect when a route would cross that road at an
  // uncontrolled point, as opposed to walking along it.
  for (const [id, node] of nodes) {
    const outEdges = adjacency.get(id) || []
    node.hasBusyRoad = outEdges.some((k) => edges.get(k).isBusy)
  }

  return { nodes, edges, adjacency }
}

// Snaps (lat, lon) onto the closest point anywhere on the street/trail
// network - not just the closest intersection - by projecting onto every
// edge and, if the closest point falls mid-segment, splitting that edge in
// two around a new synthetic node placed exactly there. This is what lets
// the route's start/finish sit right on the entered address instead of
// wherever the nearest existing intersection happens to be. Mutates graph
// in place and returns the id of the (possibly new) start node.
export function snapStartToNetwork(graph, lat, lon) {
  let best = null
  const seenUndirected = new Set()

  for (const edge of graph.edges.values()) {
    const undirectedKey = edge.key < edge.reverseKey ? edge.key : edge.reverseKey
    if (seenUndirected.has(undirectedKey)) continue
    seenUndirected.add(undirectedKey)

    const a = graph.nodes.get(edge.from)
    const b = graph.nodes.get(edge.to)
    const proj = projectPointToSegment(lat, lon, a.lat, a.lon, b.lat, b.lon)
    if (!best || proj.distMeters < best.proj.distMeters) best = { edge, proj }
  }

  if (!best) return null
  const { edge, proj } = best

  // Snapped essentially onto an existing endpoint - just use that node.
  if (proj.t <= 0.015) return edge.from
  if (proj.t >= 0.985) return edge.to

  const aId = edge.from
  const bId = edge.to
  const { wayId, name, isTrail, isBusy, highway } = edge
  const newId = `snap:${wayId}:${aId}:${bId}`
  if (graph.nodes.has(newId)) return newId // already split here

  const distA = haversine(graph.nodes.get(aId).lat, graph.nodes.get(aId).lon, proj.lat, proj.lon)
  const distB = haversine(proj.lat, proj.lon, graph.nodes.get(bId).lat, graph.nodes.get(bId).lon)

  graph.nodes.set(newId, { id: newId, lat: proj.lat, lon: proj.lon, hasSignal: false, hasBusyRoad: isBusy, degree: 2 })
  graph.adjacency.set(newId, [])

  // Remove the original A<->B edges; replace with A<->new<->B, preserving
  // the way id/name/trail status on both halves so turn-detection still
  // treats this as a straight continuation rather than a fake turn.
  const forwardKey = edge.key
  const backwardKey = edge.reverseKey
  graph.edges.delete(forwardKey)
  graph.edges.delete(backwardKey)
  graph.adjacency.set(aId, (graph.adjacency.get(aId) || []).filter((k) => k !== forwardKey))
  graph.adjacency.set(bId, (graph.adjacency.get(bId) || []).filter((k) => k !== backwardKey))

  function mkEdge(fromId, toId, dist) {
    return {
      key: edgeKey(wayId, fromId, toId),
      reverseKey: edgeKey(wayId, toId, fromId),
      wayId, from: fromId, to: toId, distance: dist, name, isTrail, isBusy, highway,
    }
  }
  const eAtoNew = mkEdge(aId, newId, distA)
  const eNewToA = mkEdge(newId, aId, distA)
  const eNewToB = mkEdge(newId, bId, distB)
  const eBtoNew = mkEdge(bId, newId, distB)

  graph.edges.set(eAtoNew.key, eAtoNew)
  graph.edges.set(eNewToA.key, eNewToA)
  graph.edges.set(eNewToB.key, eNewToB)
  graph.edges.set(eBtoNew.key, eBtoNew)

  graph.adjacency.get(aId).push(eAtoNew.key)
  graph.adjacency.get(newId).push(eNewToA.key, eNewToB.key)
  graph.adjacency.get(bId).push(eBtoNew.key)

  return newId
}

// Identifies every "bridge" in the network - an edge whose removal would
// disconnect part of the graph from the rest - using Tarjan's bridge-finding
// algorithm (iterative, to stay safe on graphs with thousands of nodes).
// Every bridge is classified by whether the far side it leads to contains
// any cycle at all (i.e., any way to get around without retracing your
// steps), not by how long it is:
//   - No cycle on the far side (a cul-de-sac, or a long straight dead-end
//     street with nothing branching off it - length doesn't matter):
//     treated as a genuine dead end, HARD-EXCLUDED from routing. A route
//     can otherwise legally reverse partway down a long dead-end street
//     and call it done, which is exactly the kind of turnaround this is
//     meant to prevent regardless of the street's length.
//   - A cycle on the far side (a real trail network with multiple paths
//     through it, or a whole neighborhood with its own street grid,
//     reachable via a single connector road): kept usable AND reversible.
//     Crossing a single connector to reach a worthwhile network and
//     crossing back is a normal, deliberate part of a route, not the
//     pointless "turn around on a through street" the no-reversal rule
//     exists to prevent.
//
// Call this AFTER snapStartToNetwork, so any edge split at the start point
// is accounted for in the analysis.
export function analyzeDeadEnds(graph) {
  const { nodes, adjacency, edges } = graph
  const disc = new Map()
  const low = new Map()
  const subtreeHasCycle = new Map()
  const parentEdge = new Map() // nodeId -> edge key used to reach it in the DFS tree
  const bridgeEdges = [] // { key, reverseKey, farSideHasCycle }
  let timer = 0

  for (const rootId of nodes.keys()) {
    if (disc.has(rootId)) continue
    disc.set(rootId, timer)
    low.set(rootId, timer)
    timer++
    subtreeHasCycle.set(rootId, false)

    const stack = [{ node: rootId, edgeList: adjacency.get(rootId) || [], idx: 0 }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const { node } = frame

      if (frame.idx < frame.edgeList.length) {
        const key = frame.edgeList[frame.idx++]
        const edge = edges.get(key)
        const child = edge.to
        const arrivedVia = parentEdge.get(node)
        if (arrivedVia && key === edges.get(arrivedVia).reverseKey) continue // skip going straight back the way we came

        if (!disc.has(child)) {
          parentEdge.set(child, key)
          disc.set(child, timer)
          low.set(child, timer)
          timer++
          subtreeHasCycle.set(child, false)
          stack.push({ node: child, edgeList: adjacency.get(child) || [], idx: 0 })
        } else {
          low.set(node, Math.min(low.get(node), disc.get(child)))
        }
      } else {
        stack.pop()
        if (stack.length > 0) {
          const parent = stack[stack.length - 1].node
          low.set(parent, Math.min(low.get(parent), low.get(node)))
          const edgeIntoNode = parentEdge.get(node)
          const edgeIsBridge = low.get(node) > disc.get(parent)
          const childHasCycle = subtreeHasCycle.get(node) || false

          // This tree edge itself carries a cycle up to the parent if
          // either its child's own subtree has one, or the edge isn't a
          // bridge (meaning some back-edge ties it into a cycle directly).
          const carriesCycle = childHasCycle || !edgeIsBridge
          subtreeHasCycle.set(parent, (subtreeHasCycle.get(parent) || false) || carriesCycle)

          if (edgeIsBridge) {
            bridgeEdges.push({
              key: edgeIntoNode,
              reverseKey: edges.get(edgeIntoNode).reverseKey,
              farSideHasCycle: childHasCycle,
            })
          }
        }
      }
    }
  }

  const spurEdges = new Set() // dead ends with no cycle beyond them - excluded outright
  const worthwhileBridges = new Set() // single connectors to real networks - usable and reversible
  for (const b of bridgeEdges) {
    const target = b.farSideHasCycle ? worthwhileBridges : spurEdges
    target.add(b.key)
    target.add(b.reverseKey)
  }

  // If the start itself sits behind a hard-excluded dead end (address is
  // literally on a small cul-de-sac), there's no way to reach it at all
  // without using that connector - walk up the DFS tree from start,
  // exempting every such edge crossed, until reaching non-excluded ground.
  const reversalExempt = new Set(worthwhileBridges)
  if (graph.startNodeId != null) {
    let current = graph.startNodeId
    let guard = 0
    while (guard++ < 10000) {
      const inEdgeKey = parentEdge.get(current)
      if (!inEdgeKey || !spurEdges.has(inEdgeKey)) break
      const edge = edges.get(inEdgeKey)
      reversalExempt.add(edge.key)
      reversalExempt.add(edge.reverseKey)
      current = edge.from
    }
  }

  const hardExcluded = new Set(spurEdges)
  for (const k of reversalExempt) hardExcluded.delete(k)

  graph.spurEdges = spurEdges
  graph.hardExcluded = hardExcluded
  graph.reversalExempt = reversalExempt
  return graph
}

export function nearestNode(graph, lat, lon) {
  let best = null
  let bestDist = Infinity
  for (const node of graph.nodes.values()) {
    const d = haversine(lat, lon, node.lat, node.lon)
    if (d < bestDist) {
      bestDist = d
      best = node
    }
  }
  return best
}
