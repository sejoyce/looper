import { useEffect, useRef } from 'react'
import L from 'leaflet'

// Fix default marker icon paths (Vite doesn't resolve Leaflet's internal
// asset URLs correctly out of the box).
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

// Colorblind-safe palette (Okabe-Ito), chosen so trail vs. street reads
// clearly regardless of color vision, and arrows share the same hue as the
// segment they're on rather than standing out as an unrelated accent color.
const TRAIL_COLOR = '#009E73' // bluish green
const STREET_COLOR = '#0072B2' // blue

export default function MapView({ start, polylineRuns, directionArrows }) {
  const mapRef = useRef(null)
  const containerRef = useRef(null)
  const layerGroupRef = useRef(null)

  // Initialize map once
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return
    const map = L.map(containerRef.current, {
      zoomControl: true,
    }).setView([39.9526, -75.1652], 13)

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      // A muted, mostly-monochrome basemap (Esri Light Gray Canvas) so the
      // route itself is the most visually prominent thing on the map,
      // instead of competing with a busy, colorful default street-map
      // style. Free to use without an API key, unlike CARTO's basemaps.
      attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 16,
    }).addTo(map)

    layerGroupRef.current = L.layerGroup().addTo(map)
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Recenter on the geocoded start point
  useEffect(() => {
    if (!mapRef.current || !start) return
    mapRef.current.setView([start.lat, start.lon], 15)
  }, [start])

  // Draw / redraw the route
  useEffect(() => {
    const map = mapRef.current
    const layerGroup = layerGroupRef.current
    if (!map || !layerGroup) return
    layerGroup.clearLayers()

    if (start) {
      L.circleMarker([start.lat, start.lon], {
        radius: 8,
        color: '#1A2B33',
        weight: 2,
        fillColor: '#E69F00',
        fillOpacity: 1,
      })
        .bindTooltip('Start / Finish', { permanent: false })
        .addTo(layerGroup)
    }

    if (polylineRuns && polylineRuns.length > 0) {
      const bounds = []
      for (const run of polylineRuns) {
        const color = run.isTrail ? TRAIL_COLOR : STREET_COLOR
        L.polyline(run.points, {
          color,
          weight: run.isTrail ? 5 : 4,
          opacity: 0.9,
          dashArray: run.isTrail ? null : undefined,
          lineCap: 'round',
        }).addTo(layerGroup)
        bounds.push(...run.points)
      }
      if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [32, 32] })
      }
    }

    if (directionArrows && directionArrows.length > 0) {
      for (const arrow of directionArrows) {
        const color = arrow.isTrail ? TRAIL_COLOR : STREET_COLOR
        const icon = L.divIcon({
          className: 'direction-arrow-icon',
          html: `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;transform:rotate(${arrow.bearing}deg)">
            <svg width="15" height="15" viewBox="0 0 14 14"><polygon points="7,1 12,12 7,8.5 2,12" fill="${color}" stroke="#ffffff" stroke-width="1"/></svg>
          </div>`,
          iconSize: [15, 15],
          iconAnchor: [7, 7],
        })
        L.marker([arrow.lat, arrow.lon], { icon, interactive: false }).addTo(layerGroup)
      }
    }
  }, [polylineRuns, directionArrows, start])

  return <div ref={containerRef} className="map-canvas" role="img" aria-label="Route map" />
}
