// All calls here run in the user's browser at request time (no server
// involved), which is what lets this app live as a static site on GitHub
// Pages. Both Nominatim and Overpass are free public OSM services and ask
// that you not hammer them - keep requests to one-at-a-time, user-triggered.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'

// Public Overpass endpoints, tried in order in case one is overloaded.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

export async function geocodeAddress(address) {
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(address)}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error('Geocoding request failed. Please try again.')
  const data = await res.json()
  if (!data || data.length === 0) {
    throw new Error(`Couldn't find "${address}". Try adding a city and state.`)
  }
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    displayName: data[0].display_name,
  }
}

// Highway types we consider runnable. Motorways/trunks and their links are
// excluded outright - not safe or legal to run a loop along.
const RUNNABLE_HIGHWAYS = [
  'residential',
  'living_street',
  'unclassified',
  'tertiary',
  'tertiary_link',
  'secondary',
  'secondary_link',
  'primary',
  'primary_link',
  'pedestrian',
  'footway',
  'path',
  'track',
  'cycleway',
  'service',
  'steps',
]

function buildOverpassQuery(lat, lon, radiusMeters) {
  const highwayFilter = RUNNABLE_HIGHWAYS.join('|')
  return `
    [out:json][timeout:30];
    (
      way["highway"~"^(${highwayFilter})$"]["area"!~"yes"](around:${Math.round(radiusMeters)},${lat},${lon});
    );
    (._;>;);
    out body;
  `.trim()
}

export async function fetchStreetGraph(lat, lon, radiusMeters) {
  const query = buildOverpassQuery(lat, lon, radiusMeters)
  let lastError
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      })
      if (!res.ok) throw new Error(`Overpass returned ${res.status}`)
      const data = await res.json()
      return data
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `Couldn't fetch street data (${lastError?.message ?? 'unknown error'}). The map data service may be busy - try again in a moment.`
  )
}
