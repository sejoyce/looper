import { MinHeap } from './minHeap.js'
import { bearing, angleDiff, haversine, milesToMeters, metersToMiles } from './geo.js'
import { pickTargetCluster } from './trailSeeking.js'

// --- Turn geometry ---------------------------------------------------------

function edgeBearing(graph, edge) {
  const from = graph.nodes.get(edge.from)
  const to = graph.nodes.get(edge.to)
  return bearing(from.lat, from.lon, to.lat, to.lon)
}

function classifyTurn(graph, prevEdge, nextEdge) {
  if (!prevEdge) return { angle: 0, kind: 'straight' }
  if (prevEdge.wayId === nextEdge.wayId) return { angle: 0, kind: 'straight' }
  const a1 = edgeBearing(graph, prevEdge)
  const a2 = edgeBearing(graph, nextEdge)
  const angle = angleDiff(a1, a2)
  let kind
  if (angle < 25) kind = 'straight'
  else if (angle < 45) kind = 'slight'
  else if (angle < 120) kind = 'turn'
  else kind = 'sharp'
  return { angle, kind }
}

// --- Edge weighting (quality, independent of the length-matching logic) ---

function edgeWeight(graph, edge, toNode, prevEdge, usedForward) {
  let w = edge.distance
  if (edge.isTrail) w *= 0.5
  if (toNode?.hasSignal) w *= 1.12
  if (usedForward.has(edge.key)) w *= 1.75

  const { kind } = classifyTurn(graph, prevEdge, edge)
  if (prevEdge && prevEdge.name === edge.name && kind !== 'sharp') w *= 0.8
  switch (kind) {
    case 'straight': break
    case 'slight': w *= 1.15; break
    case 'turn': w *= 1.55; break
    case 'sharp': w *= 2.4; break
  }
  return w
}

// An edge is legal to use if it isn't a dead-end spur (those are excluded
// from routing entirely - a dead end can only be visited by walking in and
// back out the same way, which is exactly the forced U-turn we're avoiding
// now), UNLESS it's the one mandatory connector for a start point that
// itself sits on a dead-end street (reversalExempt) - in that case it's the
// only possible way to leave and return home, so it's allowed both ways.
// Otherwise, normal edges are legal as long as their exact reverse hasn't
// already been used.
function isLegal(edge, usedForward, graph) {
  if (graph.reversalExempt.has(edge.key)) return true
  if (graph.hardExcluded.has(edge.key)) return false
  return !usedForward.has(edge.reverseKey)
}

// A hard safety rule: crossing a busy road (primary/secondary/trunk) at a
// point with no traffic signal or signal-controlled crossing is never
// allowed, regardless of how good the route would otherwise be. Walking
// ALONG a busy road (arriving or leaving via that same road) is a separate,
// milder concern already handled by the ordinary signal-penalty weighting -
// this specifically targets darting across one at an uncontrolled point.
function isUnsafeCrossing(graph, prevEdge, edge) {
  if (!prevEdge) return false // the very first edge from start isn't "crossing" anything
  const node = graph.nodes.get(edge.from) // the intersection this transition happens at
  if (!node || !node.hasBusyRoad || node.hasSignal) return false
  if (prevEdge.isBusy || edge.isBusy) return false // walking along the busy road itself, not crossing it
  return true
}

// After the fact validation that no edge's exact reverse was ever used -
// the search strategies below are designed to respect this, but a
// distance-targeted search can in principle "pad" a path in ways that risk
// it, so every candidate route is checked here before it's ever returned.
function validateNoReversal(edgeKeys, graph) {
  const used = new Set()
  for (const key of edgeKeys) {
    const edge = graph.edges.get(key)
    if (used.has(edge.reverseKey) && !graph.reversalExempt.has(edge.key)) return false
    used.add(key)
  }
  return true
}

function weightedPick(candidates, rng) {
  const total = candidates.reduce((s, c) => s + 1 / c.weight, 0)
  let r = rng() * total
  for (const c of candidates) {
    r -= 1 / c.weight
    if (r <= 0) return c
  }
  return candidates[candidates.length - 1]
}

function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- Outbound leg: weighted random walk -------------------------------------

// Loops shorter than this read as pointless on a map (a little detour into
// a trail cluster or a lot aisle for its own sake) rather than a real part
// of the route, so revisiting a node within this short a distance is
// strongly (not absolutely) discouraged.
const MIN_LOOP_METERS = milesToMeters(0.1)

function randomWalk(graph, startId, targetDistance, rng, maxSteps = 500, externalUsedForward = null) {
  const path = []
  const usedForward = externalUsedForward ? new Set(externalUsedForward) : new Set()
  let current = startId
  let last = null
  let distance = 0
  const visitedAt = new Map([[startId, 0]])

  for (let step = 0; step < maxSteps && distance < targetDistance; step++) {
    const edgeKeys = graph.adjacency.get(current) || []
    const candidates = []
    for (const key of edgeKeys) {
      const edge = graph.edges.get(key)
      if (!isLegal(edge, usedForward, graph)) continue
      if (isUnsafeCrossing(graph, last, edge)) continue
      const toNode = graph.nodes.get(edge.to)
      const prevVisit = visitedAt.get(edge.to)
      // A short edge can still look "cheap" even with a weight multiplier,
      // since its raw distance is tiny to begin with - so a pointless
      // little loop (like a short side-loop off a trail) needs an outright
      // block here, not just a discount, to reliably keep it out.
      if (prevVisit != null && distance + edge.distance - prevVisit < MIN_LOOP_METERS) continue
      const weight = edgeWeight(graph, edge, toNode, last, usedForward)
      candidates.push({ edge, weight })
    }
    if (candidates.length === 0) break

    const choice = weightedPick(candidates, rng).edge
    path.push(choice.key)
    usedForward.add(choice.key)
    distance += choice.distance
    if (!visitedAt.has(choice.to)) visitedAt.set(choice.to, distance)
    last = choice
    current = choice.to
  }

  return { path, usedForward, endNode: current, distance }
}

// --- Return leg, variant 1: plain turn-aware shortest path ------------------
// Used only when we want the cleanest/shortest way home regardless of how
// long it is (the "biggest simple loop" search used for the lap fallback).

function shortestPathBack(graph, fromId, toId, usedForward, opts = {}) {
  const maxIterations = opts.maxIterations ?? 150000
  const deadline = opts.timeBudgetMs ? performance.now() + opts.timeBudgetMs : Infinity
  const startState = `${fromId}|-`
  const dist = new Map([[startState, 0]])
  const prevStep = new Map()
  const visited = new Set()
  const heap = new MinHeap()
  heap.push(0, { node: fromId, lastEdge: null, state: startState })
  let goalState = null
  let iterations = 0

  while (heap.size > 0 && iterations < maxIterations) {
    iterations++
    if ((iterations & 2047) === 0 && performance.now() > deadline) break
    const [d, cur] = heap.pop()
    if (visited.has(cur.state)) continue
    visited.add(cur.state)
    if (cur.node === toId) {
      goalState = cur.state
      break
    }
    const edgeKeys = graph.adjacency.get(cur.node) || []
    for (const key of edgeKeys) {
      const edge = graph.edges.get(key)
      if (!isLegal(edge, usedForward, graph)) continue
      // This Dijkstra-style search doesn't mutate `usedForward` as it
      // explores (unlike the random walk), so it needs its own explicit
      // check against immediately reversing the edge that led here -
      // without it, the search can "pad" distance by wiggling back and
      // forth on the same edge, which is never what we want except at a
      // genuine dead end (already exempted via spurEdges).
      if (cur.lastEdge && key === cur.lastEdge.reverseKey && !graph.reversalExempt.has(key)) continue
      if (isUnsafeCrossing(graph, cur.lastEdge, edge)) continue
      const toNode = graph.nodes.get(edge.to)
      const w = edgeWeight(graph, edge, toNode, cur.lastEdge, usedForward)
      const nd = d + w
      const nextState = `${edge.to}|${key}`
      if (!dist.has(nextState) || nd < dist.get(nextState)) {
        dist.set(nextState, nd)
        prevStep.set(nextState, { key, fromState: cur.state })
        heap.push(nd, { node: edge.to, lastEdge: edge, state: nextState })
      }
    }
  }
  if (!goalState) return null

  const path = []
  let curState = goalState
  let realDistance = 0
  while (curState !== startState) {
    const step = prevStep.get(curState)
    if (!step) return null
    path.push(step.key)
    realDistance += graph.edges.get(step.key).distance
    curState = step.fromState
  }
  path.reverse()
  return { path, distance: realDistance }
}

// --- Return leg, variant 2: distance-targeted (bucketed) search -------------
// This is the piece that actually makes tight mileage precision possible.
// Instead of finding *the* shortest path home, it searches for the
// best-quality path home whose length lands as close as possible to a
// specific target (targetRemaining), by expanding a label-setting search
// over (node, distance-bucket) states rather than just (node). Two paths
// reaching the same intersection after traveling different distances are
// genuinely different states here, which is what lets the search "pad"
// toward an exact remaining distance instead of always taking the
// cheapest route home regardless of length.
// Since this search doesn't track full path history per state (histories
// merge at shared states), it can't know for certain "have I visited this
// node before on this exact path" the way a plain walk can. This walks a
// bounded number of steps back through the state chain instead - enough to
// catch a short loop (which by definition involves only a few edges) while
// staying cheap. This is what stops the search from discovering that
// looping around one cheap, short, trail-discounted cycle repeatedly is an
// efficient way to pad toward an exact target distance.
function createsRecentLoop(stateInfo, fromKey, searchStartNodeId, newDist, targetNode, minLoopMeters, maxLookback = 8) {
  let key = fromKey
  for (let i = 0; i < maxLookback; i++) {
    const info = stateInfo.get(key)
    if (!info) return false
    const nodeHere = info.lastEdge ? info.lastEdge.to : searchStartNodeId
    if (nodeHere === targetNode) return newDist - info.dist < minLoopMeters
    if (info.prevKey == null) return false
    key = info.prevKey
  }
  return false
}

function bucketedReturnPath(graph, fromId, toId, usedForward, targetRemaining, opts = {}) {
  if (targetRemaining <= 0) return null
  // Bucket size scales with the remaining distance so the state space
  // (roughly nodeCount * distance/bucketSize) stays bounded regardless of
  // how long the target loop is - fine-grained for short remainders,
  // coarser (but still well under our tolerance) for long ones.
  const bucketSize = opts.bucketSize ?? Math.min(40, Math.max(12, targetRemaining / 260))
  const slack = opts.slack ?? 220
  const straightLine = haversine(
    graph.nodes.get(fromId).lat, graph.nodes.get(fromId).lon,
    graph.nodes.get(toId).lat, graph.nodes.get(toId).lon
  )
  // Network distance can't be less than straight-line distance, so make
  // sure the search window can't be so tight it's geometrically impossible.
  const maxDistance = Math.max(targetRemaining + slack, straightLine * 1.35)
  const maxIterations = opts.maxIterations ?? 250000
  const earlyExitMeters = opts.earlyExitMeters ?? 10
  const deadline = opts.timeBudgetMs ? performance.now() + opts.timeBudgetMs : Infinity

  const startKey = `${fromId}|0`
  const stateInfo = new Map()
  stateInfo.set(startKey, { cost: 0, dist: 0, lastEdge: null, prevKey: null })
  const heap = new MinHeap()
  heap.push(0, { node: fromId, dist: 0, lastEdge: null, key: startKey })

  let best = null
  let iterations = 0

  while (heap.size > 0 && iterations < maxIterations) {
    iterations++
    if ((iterations & 1023) === 0 && performance.now() > deadline) break
    const [cost, cur] = heap.pop()
    const stored = stateInfo.get(cur.key)
    if (!stored || stored.cost < cost - 1e-9) continue // stale heap entry

    if (cur.node === toId) {
      const err = Math.abs(cur.dist - targetRemaining)
      if (!best || err < best.err || (Math.abs(err - best.err) < 1e-6 && cost < best.cost)) {
        best = { key: cur.key, dist: cur.dist, cost, err }
      }
      if (err <= earlyExitMeters) break
      continue
    }
    if (cur.dist > maxDistance) continue

    const edgeKeys = graph.adjacency.get(cur.node) || []
    for (const key of edgeKeys) {
      const edge = graph.edges.get(key)
      if (!isLegal(edge, usedForward, graph)) continue
      // Same reasoning as shortestPathBack: this search doesn't mutate
      // `usedForward` as it explores, so without this it will happily
      // "pad" toward the exact target distance by wiggling on one edge.
      if (cur.lastEdge && key === cur.lastEdge.reverseKey && !graph.reversalExempt.has(key)) continue
      if (isUnsafeCrossing(graph, cur.lastEdge, edge)) continue
      const newDist = cur.dist + edge.distance
      if (newDist > maxDistance) continue
      if (createsRecentLoop(stateInfo, cur.key, fromId, newDist, edge.to, MIN_LOOP_METERS)) continue
      const bucket = Math.round(newDist / bucketSize)
      const stateKey = `${edge.to}|${bucket}`
      const toNode = graph.nodes.get(edge.to)
      const newCost = cost + edgeWeight(graph, edge, toNode, cur.lastEdge, usedForward)
      const existing = stateInfo.get(stateKey)
      if (!existing || newCost < existing.cost) {
        stateInfo.set(stateKey, { cost: newCost, dist: newDist, lastEdge: edge, prevKey: cur.key })
        heap.push(newCost, { node: edge.to, dist: newDist, lastEdge: edge, key: stateKey })
      }
    }
  }

  if (!best) return null

  const path = []
  let curKey = best.key
  while (curKey !== startKey) {
    const st = stateInfo.get(curKey)
    if (!st || !st.lastEdge) return null
    path.push(st.lastEdge.key)
    curKey = st.prevKey
  }
  path.reverse()
  return { path, distance: best.dist, error: best.err }
}

// --- Shared summary/scoring helpers -----------------------------------------

function countTurns(graph, edgeKeys) {
  let turns = 0
  let sharp = 0
  for (let i = 1; i < edgeKeys.length; i++) {
    const { kind } = classifyTurn(graph, graph.edges.get(edgeKeys[i - 1]), graph.edges.get(edgeKeys[i]))
    if (kind === 'turn' || kind === 'sharp') turns++
    if (kind === 'sharp') sharp++
  }
  return { turns, sharp }
}

function countTinyLoops(graph, edgeKeys, minLoopMeters) {
  const visitedAt = new Map()
  let distance = 0
  let startNode = null
  let count = 0
  edgeKeys.forEach((key, i) => {
    const edge = graph.edges.get(key)
    if (i === 0) {
      visitedAt.set(edge.from, 0)
      startNode = edge.from
    }
    distance += edge.distance
    if (edge.to !== startNode) {
      const prev = visitedAt.get(edge.to)
      if (prev != null && distance - prev < minLoopMeters) count++
    }
    if (!visitedAt.has(edge.to)) visitedAt.set(edge.to, distance)
  })
  return count
}

function summarizeRoute(graph, edgeKeys, targetDistance) {
  let distance = 0
  let trailDistance = 0
  const signalNodes = new Set()
  const seenForwardOnce = new Set()
  let reusedDistance = 0

  for (const key of edgeKeys) {
    const edge = graph.edges.get(key)
    distance += edge.distance
    if (edge.isTrail) trailDistance += edge.distance
    const toNode = graph.nodes.get(edge.to)
    if (toNode?.hasSignal) signalNodes.add(edge.to)
    if (seenForwardOnce.has(key)) reusedDistance += edge.distance
    seenForwardOnce.add(key)
  }

  const { turns, sharp } = countTurns(graph, edgeKeys)
  const tinyLoopCount = countTinyLoops(graph, edgeKeys, MIN_LOOP_METERS)

  return {
    edgeKeys,
    distanceMeters: distance,
    trailMeters: trailDistance,
    trailFraction: distance > 0 ? trailDistance / distance : 0,
    signalCount: signalNodes.size,
    newStreetFraction: distance > 0 ? 1 - reusedDistance / distance : 1,
    errorMeters: targetDistance > 0 ? Math.abs(distance - targetDistance) : 0,
    turnCount: turns,
    sharpTurnCount: sharp,
    tinyLoopCount,
    laps: 1,
  }
}

function scoreOnSize(route) {
  let score = route.distanceMeters * 0.02
  score += route.trailFraction * 25
  score -= route.signalCount * 2
  score -= route.turnCount * 4
  score -= route.sharpTurnCount * 5
  score -= route.tinyLoopCount * 40
  return score
}

// Sweeps several outbound-walk stopping points, and for each one runs the
// distance-targeted return search so the total lands as close as possible
// to `targetMeters`. Returns the closest single-loop match found, or null.
function findPreciseLoop(graph, startId, targetMeters, options = {}) {
  const {
    seed = 1,
    sweeps = 10,
    timeBudgetMs = 5000,
    toleranceMeters = milesToMeters(0.05),
    externalUsedForward = null, // edges already committed elsewhere in the
                                 // final route (e.g. repeated laps) that this
                                 // search must not reverse, even though it
                                 // starts its own fresh walk from scratch.
  } = options

  let best = null
  const searchStart = performance.now()

  for (let i = 0; i < sweeps; i++) {
    if (performance.now() - searchStart > timeBudgetMs) break
    const rng = mulberry32(seed + i * 104729)
    const outboundFraction = 0.32 + (i / Math.max(sweeps - 1, 1)) * 0.4 + (rng() - 0.5) * 0.05
    const walk = randomWalk(graph, startId, targetMeters * outboundFraction, rng, 500, externalUsedForward)
    if (walk.path.length === 0) continue

    const remaining = targetMeters - walk.distance
    if (remaining <= 0) continue

    const ret = bucketedReturnPath(graph, walk.endNode, startId, walk.usedForward, remaining, {
      timeBudgetMs: Math.max(300, timeBudgetMs / sweeps),
    })
    if (!ret) continue

    const edgeKeys = walk.path.concat(ret.path)
    if (!validateNoReversal(edgeKeys, graph)) continue

    const summary = summarizeRoute(graph, edgeKeys, targetMeters)
    if (!best || summary.errorMeters < best.errorMeters) {
      best = summary
      if (summary.errorMeters <= toleranceMeters * 0.4) break // excellent match, stop early
    }
  }

  return best
}

// Finds the biggest, cleanest simple loop available (used as the repeating
// unit when the target distance isn't reachable as one loop).
function findBiggestCleanLoop(graph, startId, targetMeters, options = {}) {
  const { seed = 99, attempts = 12, timeBudgetMs = 1800 } = options
  let best = null
  let bestScore = -Infinity
  const searchStart = performance.now()

  for (let i = 0; i < attempts; i++) {
    if (performance.now() - searchStart > timeBudgetMs) break
    const rng = mulberry32(seed + i * 104729)
    const outboundFraction = 0.4 + rng() * 0.4
    const walk = randomWalk(graph, startId, targetMeters * outboundFraction, rng)
    if (walk.path.length === 0) continue
    const home = shortestPathBack(graph, walk.endNode, startId, walk.usedForward, { timeBudgetMs: 600 })
    if (!home) continue
    const edgeKeys = walk.path.concat(home.path)
    if (!validateNoReversal(edgeKeys, graph)) continue
    const summary = summarizeRoute(graph, edgeKeys, targetMeters)
    const score = scoreOnSize(summary)
    if (score > bestScore) {
      bestScore = score
      best = summary
    }
  }
  return best
}

// Deliberately routes toward the best trail network within reach, instead
// of only ever rewarding trail use opportunistically once the search
// happens to already be standing on one. Three legs: a turn-aware shortest
// path OUT to the trail cluster's nearest access point, a walk that
// wanders on/near the trail for a chunk of the remaining distance, and a
// precisely-sized return leg home. Tries a few different "how much of the
// trail to use" fractions and keeps whichever total lands closest to the
// target distance.
function findWaypointLoop(graph, startId, targetMeters, options = {}) {
  const { seed = 1, toleranceMeters = milesToMeters(0.05), maxReachFraction = 0.4, tries = 3 } = options

  const target = pickTargetCluster(graph, startId, targetMeters * maxReachFraction)
  if (!target) return null

  const toTrail = shortestPathBack(graph, startId, target.accessNodeId, new Set(), { timeBudgetMs: 1000 })
  if (!toTrail || toTrail.distance >= targetMeters) return null

  let best = null
  for (let i = 0; i < tries; i++) {
    const rng = mulberry32(seed + i * 50021)
    const remainingAfterOutbound = targetMeters - toTrail.distance
    const exploreFraction = 0.25 + (i / Math.max(tries - 1, 1)) * 0.4 + (rng() - 0.5) * 0.05
    const usedSoFar = new Set(toTrail.path)

    const exploreWalk = randomWalk(graph, target.accessNodeId, remainingAfterOutbound * exploreFraction, rng, 400, usedSoFar)
    if (exploreWalk.path.length === 0) continue

    const remaining = targetMeters - toTrail.distance - exploreWalk.distance
    if (remaining <= 0) continue

    const home = bucketedReturnPath(graph, exploreWalk.endNode, startId, exploreWalk.usedForward, remaining, {
      timeBudgetMs: 900,
    })
    if (!home) continue

    const edgeKeys = toTrail.path.concat(exploreWalk.path, home.path)
    if (!validateNoReversal(edgeKeys, graph)) continue

    const summary = summarizeRoute(graph, edgeKeys, targetMeters)
    if (!best || summary.errorMeters < best.errorMeters) {
      best = summary
      if (summary.errorMeters <= toleranceMeters * 0.4) break
    }
  }

  return best
}

// --- Public entry point -----------------------------------------------------
// Strategy:
//  1. Try to find a single loop within toleranceMeters of the target by
//     sweeping outbound stopping points paired with a distance-targeted
//     return search (findPreciseLoop). This is the common case and hits
//     tight (~0.05mi) precision on any reasonably-connected street grid.
//  2. Separately, try to find a loop that deliberately routes out to the
//     best trail network within reach (findWaypointLoop) - this is what
//     lets the route reach a worthwhile trail a mile or two away instead
//     of only ever using trails it happens to stumble across nearby.
//  3. If neither lands close to the target (the area genuinely doesn't
//     have enough new road within range for one loop that long), fall back
//     to repeating the biggest clean loop found, PLUS a final
//     precisely-sized "closing" loop to soak up the remainder.
// Combines distance error, turn density, and trail coverage into one
// comparable score (in "mile-equivalents") so a slightly-less-precise but
// much cleaner or much more trail-rich route can beat a technically-exact
// all-street one - important both to avoid pointless zigzagging in small
// areas, and to actually deliver on "prioritize trails" rather than only
// using them incidentally.
const TURN_PENALTY_MI = 0.004
const TRAIL_BONUS_MI = 0.18
const TINY_LOOP_PENALTY_MI = 1.2
function combinedScore(route) {
  const errorMi = route.errorMeters / 1609.344
  return errorMi + route.turnCount * TURN_PENALTY_MI + route.sharpTurnCount * TURN_PENALTY_MI
    - route.trailFraction * TRAIL_BONUS_MI + route.tinyLoopCount * TINY_LOOP_PENALTY_MI
}

export function generateLoopRoute(graph, startNodeId, targetMeters, options = {}) {
  const toleranceMeters = options.toleranceMeters ?? milesToMeters(0.05)
  const seed = options.seed ?? Date.now()

  const precise = findPreciseLoop(graph, startNodeId, targetMeters, {
    seed, toleranceMeters, timeBudgetMs: options.timeBudgetMs ?? 4000,
  })

  // Always try to find a loop that deliberately reaches out to a nearby
  // trail network - this is relatively cheap (a handful of short searches
  // anchored at a known trail access point), so it's worth attempting even
  // when the plain precise search already succeeded, since that search has
  // no way to know a great trail exists a mile away and to go find it.
  const waypoint = findWaypointLoop(graph, startNodeId, targetMeters, { seed: seed + 999, toleranceMeters })

  // If the precise search already landed a clean, on-target loop AND
  // nothing meaningfully more trail-rich turned up nearby, skip the (much
  // more expensive) laps-fallback search entirely - this is the common
  // case on any normally-connected street network, so most requests
  // resolve quickly.
  const REASONABLE_TURNS_PER_MILE = 14
  if (precise && precise.errorMeters <= toleranceMeters) {
    const turnsPerMile = precise.turnCount / Math.max(metersToMiles(precise.distanceMeters), 0.1)
    const preciseIsClean = turnsPerMile <= REASONABLE_TURNS_PER_MILE
    const waypointIsBetter = waypoint && waypoint.errorMeters <= toleranceMeters * 1.5 && combinedScore(waypoint) < combinedScore(precise)
    if (preciseIsClean && !waypointIsBetter) {
      return { ...precise, withinTolerance: true, toleranceMeters }
    }
    if (waypointIsBetter) {
      return { ...waypoint, withinTolerance: waypoint.errorMeters <= toleranceMeters, toleranceMeters }
    }
  }

  const base = findBiggestCleanLoop(graph, startNodeId, targetMeters, { seed: seed + 1 })
  if (!base && !precise && !waypoint) return null

  let lapsCandidate = null
  if (base) {
    const laps = Math.floor(targetMeters / base.distanceMeters)
    let combinedEdgeKeys = []
    for (let lap = 0; lap < laps; lap++) combinedEdgeKeys = combinedEdgeKeys.concat(base.edgeKeys)

    let remainderLoop = null
    const remainder = targetMeters - laps * base.distanceMeters
    if (laps >= 1 && remainder > toleranceMeters) {
      // The remainder loop must not reverse any edge the repeated laps
      // already used forward - it explores fresh from the graph's
      // perspective, but the two pieces share one final route.
      remainderLoop = findPreciseLoop(graph, startNodeId, remainder, {
        seed: seed + 2, toleranceMeters, timeBudgetMs: 2500, sweeps: 8,
        externalUsedForward: new Set(base.edgeKeys),
      })
      if (remainderLoop) combinedEdgeKeys = combinedEdgeKeys.concat(remainderLoop.edgeKeys)
    }

    if (combinedEdgeKeys.length > 0) {
      if (!validateNoReversal(combinedEdgeKeys, graph)) {
        // Rare: a remainder loop happened to reverse a lap edge - fall
        // back to whole laps only rather than returning an invalid route.
        combinedEdgeKeys = []
        for (let lap = 0; lap < laps; lap++) combinedEdgeKeys = combinedEdgeKeys.concat(base.edgeKeys)
        remainderLoop = null
      }
      const combinedSummary = summarizeRoute(graph, combinedEdgeKeys, targetMeters)
      lapsCandidate = {
        ...combinedSummary,
        laps: remainderLoop ? laps + 0.5 : laps, // .5 signals "plus a shorter closing loop" to the UI
        lapDistanceMeters: base.distanceMeters,
        hasRemainderLoop: !!remainderLoop,
      }
    }
  }

  // Pick whichever candidate is genuinely better once distance accuracy,
  // turn count, and trail coverage are all weighed together - not just
  // whichever is closest to the target in isolation.
  const candidates = [precise, waypoint, lapsCandidate, base].filter(Boolean)
  if (candidates.length === 0) return null
  const winner = candidates.reduce((a, b) => (combinedScore(b) < combinedScore(a) ? b : a))

  return { ...winner, withinTolerance: winner.errorMeters <= toleranceMeters, toleranceMeters }
}

export function summarizeSegments(graph, edgeKeys) {
  const segments = []
  for (const key of edgeKeys) {
    const edge = graph.edges.get(key)
    const last = segments[segments.length - 1]
    if (last && last.name === edge.name && last.isTrail === edge.isTrail) {
      last.distance += edge.distance
    } else {
      segments.push({ name: edge.name, distance: edge.distance, isTrail: edge.isTrail })
    }
  }
  return segments
}

export function routeToPolylineRuns(graph, edgeKeys) {
  const runs = []
  for (const key of edgeKeys) {
    const edge = graph.edges.get(key)
    const from = graph.nodes.get(edge.from)
    const to = graph.nodes.get(edge.to)
    const last = runs[runs.length - 1]
    if (last && last.isTrail === edge.isTrail) {
      last.points.push([to.lat, to.lon])
    } else {
      runs.push({ isTrail: edge.isTrail, points: [[from.lat, from.lon], [to.lat, to.lon]] })
    }
  }
  return runs
}

// Places direction-of-travel arrows along the route at roughly even
// spacing, each with the compass bearing of travel at that point - used to
// show which way to run the loop on the map.
export function computeDirectionArrows(graph, edgeKeys, spacingMeters = 220) {
  const arrows = []
  let sinceLast = spacingMeters * 0.5 // place one reasonably early, not just at the very end of the first gap
  edgeKeys.forEach((key) => {
    const edge = graph.edges.get(key)
    const from = graph.nodes.get(edge.from)
    const to = graph.nodes.get(edge.to)
    sinceLast += edge.distance
    if (sinceLast >= spacingMeters && edge.distance > 5) {
      arrows.push({
        lat: (from.lat + to.lat) / 2,
        lon: (from.lon + to.lon) / 2,
        bearing: bearing(from.lat, from.lon, to.lat, to.lon),
      })
      sinceLast = 0
    }
  })
  return arrows
}

export { classifyTurn, edgeBearing, validateNoReversal, findWaypointLoop, isUnsafeCrossing }
