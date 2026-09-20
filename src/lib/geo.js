const EARTH_RADIUS_M = 6371000

export function toRad(deg) {
  return (deg * Math.PI) / 180
}

// Great-circle distance between two lat/lon points, in meters.
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_M * c
}

// Compass bearing from point 1 to point 2, in degrees [0, 360).
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2))
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1))
  const deg = (Math.atan2(y, x) * 180) / Math.PI
  return (deg + 360) % 360
}

// Smallest angle between two bearings, in degrees [0, 180].
export function angleDiff(b1, b2) {
  const diff = Math.abs(b1 - b2) % 360
  return diff > 180 ? 360 - diff : diff
}

// Destination point given a start point, a bearing, and a distance -
// used to nudge a route segment sideways by a small amount so a repeated
// pass over the same street renders as a visibly separate, parallel line
// instead of perfectly overlapping the first pass.
export function offsetPoint(lat, lon, bearingDeg, distMeters) {
  const R = 6371000
  const brng = toRad(bearingDeg)
  const latRad = toRad(lat)
  const angDist = distMeters / R
  const newLatRad = Math.asin(
    Math.sin(latRad) * Math.cos(angDist) + Math.cos(latRad) * Math.sin(angDist) * Math.cos(brng)
  )
  const newLonRad =
    toRad(lon) +
    Math.atan2(
      Math.sin(brng) * Math.sin(angDist) * Math.cos(latRad),
      Math.cos(angDist) - Math.sin(latRad) * Math.sin(newLatRad)
    )
  return { lat: (newLatRad * 180) / Math.PI, lon: (newLonRad * 180) / Math.PI }
}

export function metersToMiles(m) {
  return m / 1609.344
}

// Projects point (lat, lon) onto the segment from (aLat, aLon) to (bLat,
// bLon), returning the closest point on the segment, how far along it
// (t: 0=a, 1=b), and the distance from the original point to that
// projection. Uses a local equirectangular approximation (fine at the
// sub-city scale routes operate at).
export function projectPointToSegment(lat, lon, aLat, aLon, bLat, bLon) {
  const latRad = toRad((aLat + bLat) / 2)
  const cosLat = Math.cos(latRad) || 1e-9
  const toXY = (la, lo) => [lo * cosLat, la]
  const [px, py] = toXY(lat, lon)
  const [ax, ay] = toXY(aLat, aLon)
  const [bx, by] = toXY(bLat, bLon)
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0
  t = Math.max(0, Math.min(1, t))
  const snapLat = aLat + t * (bLat - aLat)
  const snapLon = aLon + t * (bLon - aLon)
  return { lat: snapLat, lon: snapLon, t, distMeters: haversine(lat, lon, snapLat, snapLon) }
}

export function milesToMeters(mi) {
  return mi * 1609.344
}

// Rough bounding-box radius (meters) to request from Overpass, given a
// target loop distance. A loop of length D can wander at most ~D/2 from
// the start in the best case, so pad generously to give the search room
// to find trails / avoid dead ends.
export function radiusForTargetMiles(miles) {
  const meters = milesToMeters(miles)
  const radius = meters * 0.62
  // Cap raised to ~10 miles so longer target distances (8mi+) actually have
  // enough street network queried to find or build a loop that long.
  return Math.min(Math.max(radius, 900), 16000)
}
