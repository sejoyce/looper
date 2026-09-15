import { MinHeap } from './minHeap.js'
import { haversine } from './geo.js'

// Finds connected clusters of trail edges in the graph - ways tagged as
// trail that link up into a real network, as opposed to one isolated
// segment. Each cluster reports its total trail mileage and member nodes,
// which lets the route planner deliberately aim for a worthwhile trail
// network rather than only ever rewarding trail use once already on one.
// Cached on the graph object since the graph itself doesn't change between
// repeated route-generation attempts (regenerate clicks, or the multiple
// candidates an elevation preference requires).
export function findTrailClusters(graph) {
  if (graph._trailClusters) return graph._trailClusters
  const visited = new Set()
  const clusters = []

  for (const node of graph.nodes.values()) {
    if (visited.has(node.id)) continue
    const outEdges = graph.adjacency.get(node.id) || []
    const hasTrailEdge = outEdges.some((k) => graph.edges.get(k).isTrail && !graph.hardExcluded.has(k))
    if (!hasTrailEdge) {
      visited.add(node.id)
      continue
    }

    const clusterNodes = new Set([node.id])
    const queue = [node.id]
    const countedEdges = new Set()
    let trailMeters = 0
    visited.add(node.id)

    let head = 0
    while (head < queue.length) {
      const cur = queue[head++]
      const edges = graph.adjacency.get(cur) || []
      for (const key of edges) {
        const edge = graph.edges.get(key)
        if (!edge.isTrail || graph.hardExcluded.has(key)) continue
        if (!countedEdges.has(edge.reverseKey)) {
          trailMeters += edge.distance
          countedEdges.add(key)
        }
        if (!clusterNodes.has(edge.to)) {
          clusterNodes.add(edge.to)
          visited.add(edge.to)
          queue.push(edge.to)
        }
      }
    }

    if (trailMeters > 0) clusters.push({ nodes: clusterNodes, trailMeters })
  }

  graph._trailClusters = clusters
  return clusters
}

// Plain shortest-distance-from-source over the whole (dead-end-excluded)
// graph - just used to measure how far away each trail cluster actually is,
// so the planner doesn't chase a trail that would eat the entire run just
// to reach it. This is the single most expensive part of trail-seeking (a
// full-graph Dijkstra), so it's cached per start node too.
export function distancesFrom(graph, startId) {
  if (graph._distCache && graph._distCache.startId === startId) return graph._distCache.dist
  const dist = new Map([[startId, 0]])
  const visited = new Set()
  const heap = new MinHeap()
  heap.push(0, startId)
  while (heap.size > 0) {
    const [d, node] = heap.pop()
    if (visited.has(node)) continue
    visited.add(node)
    const edges = graph.adjacency.get(node) || []
    for (const key of edges) {
      const edge = graph.edges.get(key)
      if (graph.hardExcluded.has(key)) continue
      const nd = d + edge.distance
      if (!dist.has(edge.to) || nd < dist.get(edge.to)) {
        dist.set(edge.to, nd)
        heap.push(nd, edge.to)
      }
    }
  }
  graph._distCache = { startId, dist }
  return dist
}

// Picks the best trail cluster to deliberately route toward: must be
// reachable within maxReachMeters of the start, and among qualifying
// clusters, prefers more trail mileage discounted by how far away it is
// (a small nearby trail can beat a huge one that's too far to be worth the
// detour).
export function pickTargetCluster(graph, startId, maxReachMeters) {
  const clusters = findTrailClusters(graph)
  if (clusters.length === 0) return null

  // Cheap geometric pre-filter, straight-line distance: skip the expensive
  // full-graph network-distance search entirely if no cluster is even
  // plausibly within reach (network distance is always >= straight line,
  // so this can only over-include candidates, never wrongly exclude one).
  const startNode = graph.nodes.get(startId)
  const plausible = clusters.filter((cluster) => {
    for (const nodeId of cluster.nodes) {
      const n = graph.nodes.get(nodeId)
      if (haversine(startNode.lat, startNode.lon, n.lat, n.lon) <= maxReachMeters * 1.3) return true
    }
    return false
  })
  if (plausible.length === 0) return null

  const dist = distancesFrom(graph, startId)

  let best = null
  let bestScore = -Infinity
  for (const cluster of plausible) {
    let nearestNodeId = null
    let nearestDist = Infinity
    for (const nodeId of cluster.nodes) {
      const d = dist.get(nodeId)
      if (d != null && d < nearestDist) {
        nearestDist = d
        nearestNodeId = nodeId
      }
    }
    if (nearestNodeId == null || nearestDist > maxReachMeters) continue
    const score = cluster.trailMeters / (1 + nearestDist / 400)
    if (score > bestScore) {
      bestScore = score
      best = { accessNodeId: nearestNodeId, distanceMeters: nearestDist, trailMeters: cluster.trailMeters }
    }
  }
  return best
}
