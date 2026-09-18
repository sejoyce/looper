import { haversine } from './geo.js'

// Andrew's monotone chain convex hull algorithm. Points need only {lat, lon}
// (plus whatever else the caller wants to carry through, e.g. an id) - lon
// is treated as the planar x-axis and lat as y, which is an adequate
// approximation at the scale of a single running route.
export function convexHull(points) {
  if (points.length < 3) return points.slice()
  const pts = [...points].sort((a, b) => a.lon - b.lon || a.lat - b.lat)
  const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon)

  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

// Finds the graph nodes forming the outer perimeter (convex hull) of the
// street network within maxReachMeters of the start - the geometric "border
// of the neighborhood" a long, low-turn loop would naturally want to trace.
export function selectHullNodeIds(graph, startId, maxReachMeters) {
  const startNode = graph.nodes.get(startId)
  const candidates = []
  for (const node of graph.nodes.values()) {
    if (haversine(startNode.lat, startNode.lon, node.lat, node.lon) <= maxReachMeters) {
      candidates.push(node)
    }
  }
  if (candidates.length < 3) return []
  const hull = convexHull(candidates)
  return hull.map((n) => n.id)
}
