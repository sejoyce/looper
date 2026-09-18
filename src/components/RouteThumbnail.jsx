// Renders a route's polyline runs as a small, self-contained SVG shape
// (no map tiles, no Leaflet instance needed) - just enough to recognize
// and compare previously generated loops at a glance.
export default function RouteThumbnail({ polylineRuns, size = 56 }) {
  if (!polylineRuns || polylineRuns.length === 0) return null

  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity
  for (const run of polylineRuns) {
    for (const [lat, lon] of run.points) {
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
    }
  }

  const padding = 5
  const latRange = Math.max(maxLat - minLat, 1e-6)
  const lonRange = Math.max(maxLon - minLon, 1e-6)
  // A single shared scale (not one per axis) keeps the loop's true shape
  // instead of stretching it to fill a square box.
  const scale = Math.min((size - padding * 2) / lonRange, (size - padding * 2) / latRange)
  const offsetX = (size - lonRange * scale) / 2
  const offsetY = (size - latRange * scale) / 2

  const toXY = (lat, lon) => {
    const x = offsetX + (lon - minLon) * scale
    const y = size - (offsetY + (lat - minLat) * scale) // flip: lat increases upward, SVG y increases downward
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="route-thumbnail-svg" aria-hidden="true">
      {polylineRuns.map((run, i) => (
        <polyline
          key={i}
          points={run.points.map(([lat, lon]) => toXY(lat, lon)).join(' ')}
          fill="none"
          stroke={run.isTrail ? '#009E73' : '#0072B2'}
          strokeWidth={run.isTrail ? 2.4 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}
