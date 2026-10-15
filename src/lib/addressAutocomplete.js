// Nominatim's usage policy explicitly forbids autocomplete/search-as-you-type
// use of its public API. Photon (https://photon.komoot.io), also built on
// OpenStreetMap data, is free, keyless, and specifically designed for this -
// so it's used here for live suggestions, while Nominatim (in osm.js) still
// handles the single, deliberate geocode when the user actually submits.
const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/'

function formatSuggestion(feature) {
  const p = feature.properties || {}
  const parts = []
  if (p.housenumber && p.street) parts.push(`${p.housenumber} ${p.street}`)
  else if (p.street) parts.push(p.street)
  else if (p.name) parts.push(p.name)

  if (p.city && p.city !== parts[0]) parts.push(p.city)
  else if (p.county) parts.push(p.county)

  if (p.state) parts.push(p.state)
  if (!p.city && !p.county && p.country) parts.push(p.country)

  // Street-only results (no house number) are deliberately dropped by the
  // caller: they resolve to an arbitrary point along the street.
  const label = parts.filter(Boolean).join(', ')
  const [lon, lat] = feature.geometry?.coordinates || []
  return label && lat != null && lon != null ? { label, lat, lon, hasNumber: !!p.housenumber } : null
}

export function hasHouseNumber(text) {
  return /^\s*\d+[a-z]?\b/i.test(text || '')
}

const TIMEOUT_MS = 3500
const cache = new Map() // normalized query -> suggestions

function normalize(q) {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

export async function fetchAddressSuggestions(query, signal) {
  if (!query || query.trim().length < 3) return []
  const key = normalize(query)
  if (cache.has(key)) return cache.get(key)

  // Give up on a slow public server instead of leaving the user waiting;
  // the typed address can still be submitted directly.
  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(), TIMEOUT_MS)
  const onOuterAbort = () => timeoutCtl.abort()
  if (signal) signal.addEventListener('abort', onOuterAbort)

  try {
    const url = `${PHOTON_ENDPOINT}?q=${encodeURIComponent(query)}&limit=15&lang=en`
    const res = await fetch(url, { signal: timeoutCtl.signal })
    if (!res.ok) throw new Error(`Suggestion service returned ${res.status}`)
    const data = await res.json()
    const seen = new Set()
    const suggestions = []
    for (const feature of data.features || []) {
      const s = formatSuggestion(feature)
      if (s && s.hasNumber && !seen.has(s.label) && suggestions.length < 5) {
        seen.add(s.label)
        suggestions.push(s)
      }
    }
    cache.set(key, suggestions)
    return suggestions
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuterAbort)
  }
}
