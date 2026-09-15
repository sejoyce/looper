import { classifyTurn } from './routeGenerator.js'

// Builds an ordered list of route points (one per graph node visited, in
// order, including repeated laps) with cumulative distance, used by both
// the GPX and TCX exporters.
function buildPointList(graph, edgeKeys) {
  const points = []
  let cumulative = 0
  edgeKeys.forEach((key, i) => {
    const edge = graph.edges.get(key)
    const from = graph.nodes.get(edge.from)
    const to = graph.nodes.get(edge.to)
    if (i === 0) {
      points.push({ lat: from.lat, lon: from.lon, dist: 0, edge: null })
    }
    cumulative += edge.distance
    points.push({ lat: to.lat, lon: to.lon, dist: cumulative, edge })
  })
  return points
}

// Turn direction (left/right) is determined from the signed bearing
// change, not just the magnitude - classifyTurn gives us magnitude/kind,
// so we compute the signed delta separately here for the L/R label.
function signedTurnDelta(graph, prevEdge, nextEdge) {
  const bearingOf = (e) => {
    const a = graph.nodes.get(e.from)
    const b = graph.nodes.get(e.to)
    return (Math.atan2(
      Math.sin(((b.lon - a.lon) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180),
      Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) -
        Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lon - a.lon) * Math.PI) / 180)
    ) * 180) / Math.PI
  }
  let delta = bearingOf(nextEdge) - bearingOf(prevEdge)
  while (delta > 180) delta -= 360
  while (delta < -180) delta += 360
  return delta
}

// Builds course points (turn cues) at each meaningful turn along the route,
// classified as Left / Right / Straight, plus Start and Finish markers.
// This is the piece Garmin devices read to show "Turn left onto Oak Ave"
// style prompts during course navigation.
function buildCoursePoints(graph, edgeKeys) {
  const cues = []
  let cumulative = 0

  edgeKeys.forEach((key, i) => {
    const edge = graph.edges.get(key)
    const to = graph.nodes.get(edge.to)
    const from = graph.nodes.get(edge.from)

    if (i === 0) {
      cues.push({ lat: from.lat, lon: from.lon, dist: 0, type: 'Generic', name: 'Start' })
    }
    cumulative += edge.distance

    const nextEdge = graph.edges.get(edgeKeys[i + 1])
    if (nextEdge) {
      const { kind } = classifyTurn(graph, edge, nextEdge)
      if (kind === 'turn' || kind === 'sharp') {
        const delta = signedTurnDelta(graph, edge, nextEdge)
        const type = delta < 0 ? 'Left' : 'Right'
        cues.push({
          lat: to.lat,
          lon: to.lon,
          dist: cumulative,
          type,
          name: `${type === 'Left' ? 'Turn left' : 'Turn right'} onto ${nextEdge.name}`,
        })
      }
    } else {
      cues.push({ lat: to.lat, lon: to.lon, dist: cumulative, type: 'Generic', name: 'Finish' })
    }
  })

  return cues
}

function xmlEscape(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]))
}

// TCX "Course" format - the one Garmin Connect / Garmin devices use to
// show turn-by-turn cues (CoursePoints) during navigation, not just a
// breadcrumb track. Upload via Garmin Connect > Training > Courses > Import.
export function buildTcxCourse(graph, edgeKeys, name) {
  const points = buildPointList(graph, edgeKeys)
  const coursePoints = buildCoursePoints(graph, edgeKeys)
  const totalMeters = points[points.length - 1]?.dist ?? 0

  const trackpoints = points
    .map(
      (p) => `      <Trackpoint>
        <Position>
          <LatitudeDegrees>${p.lat.toFixed(6)}</LatitudeDegrees>
          <LongitudeDegrees>${p.lon.toFixed(6)}</LongitudeDegrees>
        </Position>
        <DistanceMeters>${p.dist.toFixed(1)}</DistanceMeters>
      </Trackpoint>`
    )
    .join('\n')

  const coursePointXml = coursePoints
    .map(
      (c) => `    <CoursePoint>
      <Name>${xmlEscape(c.name.slice(0, 25))}</Name>
      <Position>
        <LatitudeDegrees>${c.lat.toFixed(6)}</LatitudeDegrees>
        <LongitudeDegrees>${c.lon.toFixed(6)}</LongitudeDegrees>
      </Position>
      <PointType>${c.type}</PointType>
      <Notes>${xmlEscape(c.name)}</Notes>
    </CoursePoint>`
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Courses>
    <Course>
      <Name>${xmlEscape(name)}</Name>
      <Lap>
        <TotalTimeSeconds>0</TotalTimeSeconds>
        <DistanceMeters>${totalMeters.toFixed(1)}</DistanceMeters>
        <BeginPosition>
          <LatitudeDegrees>${points[0].lat.toFixed(6)}</LatitudeDegrees>
          <LongitudeDegrees>${points[0].lon.toFixed(6)}</LongitudeDegrees>
        </BeginPosition>
        <EndPosition>
          <LatitudeDegrees>${points[points.length - 1].lat.toFixed(6)}</LatitudeDegrees>
          <LongitudeDegrees>${points[points.length - 1].lon.toFixed(6)}</LongitudeDegrees>
        </EndPosition>
      </Lap>
      <Track>
${trackpoints}
      </Track>
${coursePointXml}
    </Course>
  </Courses>
</TrainingCenterDatabase>
`
}

// Plain GPX route (rtept) as a broadly-compatible fallback export - works
// with Garmin Connect's GPX import too, and with Strava/other watches,
// though turn cues aren't part of the standard GPX route point schema the
// way they are in TCX CoursePoints.
export function buildGpx(graph, edgeKeys, name) {
  const points = buildPointList(graph, edgeKeys)
  const rtepts = points
    .map((p) => `    <rtept lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"></rtept>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Looper" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${xmlEscape(name)}</name>
  </metadata>
  <rte>
    <name>${xmlEscape(name)}</name>
${rtepts}
  </rte>
</gpx>
`
}

export function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
