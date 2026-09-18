# Looper

Generates a runnable **loop route** from an address and a target mileage — favoring trails, avoiding traffic lights and dead ends, and never doubling back on the same street segment. Reports elevation gain, and can optionally target a minimum or maximum amount of climbing.

Everything runs client-side in the browser (geocoding + street data + route search + elevation), so it deploys as a static site with no server or API keys to manage.

## How it works

1. **Geocoding** — your address is turned into coordinates via [Nominatim](https://nominatim.org/) (OpenStreetMap's free geocoder).
2. **Street/trail data** — [Overpass API](https://overpass-api.de/) is queried for every walkable way (residential streets, paths, tracks, footways, etc.) within a radius sized to your target mileage, including which intersections have traffic signals. Parking lot aisles, driveways, and drop-off loops are filtered out at this stage — see "Parking lots and driveways" below.
3. **Graph construction** (`src/lib/graph.js`) — the raw OSM data becomes a directed graph: each street segment is two directed edges (there and back), tagged with distance, street name, whether it's a trail, and whether it's a busy road (primary/secondary/trunk).
4. **Strict start snapping** — your address is snapped onto the *exact closest point anywhere on the network*, not just the nearest intersection. If that point falls in the middle of a block, the app splits that street segment and inserts a synthetic node exactly there, so the route's start/finish sits right on your address rather than drifting to whichever corner happens to be nearby.
5. **Bridge and dead-end analysis** (`analyzeDeadEnds` in `src/lib/graph.js`) — runs Tarjan's bridge-finding algorithm to identify every edge whose removal would cut off part of the network, then classifies each one by whether the far side contains any cycle at all (a way to get around without retracing your steps) — not by how long it is:
   - **No cycle on the far side** (a cul-de-sac, or a long straight dead-end street with nothing branching off it — length doesn't matter) → treated as a genuine dead end and **excluded from routing entirely**, since visiting one always means walking in and back out the same way. Classifying by raw length instead of cycle structure was an earlier bug: a sufficiently long dead-end street would look "substantial" purely because of its own length, letting the route go partway down it and turn around — exactly the kind of turnaround the no-reversal rule is meant to prevent.
   - **A cycle on the far side** (a real trail network with multiple paths through it, or a whole neighborhood with its own street grid, reachable via a single connector road) → kept usable *and* reversible. Crossing a single connector to reach a worthwhile network and crossing back is a normal, deliberate part of a route, not the pointless "turn around on a through street" the no-reversal rule exists to prevent — excluding these too would make any trail network reachable by only one road completely unroutable.
   - The one further exception: if your address itself sits on a small dead-end street, the mandatory path connecting it to the rest of the network is kept usable and reversible too, since there's no other way to leave or return home in that case.
6. **Trail-seeking** (`src/lib/trailSeeking.js`) — the street-network search above is local and myopic: it only rewards trail use once already standing on a trail edge, with no way to know a great trail exists a mile away and deliberately head for it. To fix that, the app separately identifies every connected trail network in range, scores each by total trail mileage discounted by how far away it is, and - when a worthwhile one exists - builds a dedicated candidate route that deliberately travels out to it, wanders on it for a meaningful chunk of the distance, then returns home precisely. This candidate is compared against the others on trail coverage as well as distance and turns, so a route that reaches real trail mileage a mile or two out will beat a marginally-more-precise all-street loop that never leaves the immediate neighborhood.
7. **Route search** (`src/lib/routeGenerator.js`) — three strategies (precise single loop, trail-seeking waypoint, and lap fallback), and it picks whichever result is actually better once distance accuracy, turn count, tiny-loop avoidance, and trail coverage are all weighed together:
   - **Precise single loop**: sweeps several outbound-walk stopping points, and for each one runs a distance-targeted return search — not just the shortest way home, but the best-quality path home whose length lands as close as possible to a specific number of meters. (Technically: a label-setting search over `(node, distance-bucket)` states, so the same intersection reached after different distances counts as a different search state — this is what lets it "aim" for an exact remaining distance instead of just taking the cheapest path back.) This is what gets routes within a few dozen feet of your target on any reasonably-connected street grid.
   - **Lap fallback**: if the area genuinely can't support one clean loop that long, it finds the biggest, cleanest loop available and repeats it enough times to approximate your mileage, then runs the same precise-distance search for a short "closing loop" to soak up the remainder — so even the fallback case lands close to your target instead of jumping in whole-lap increments.
   - **The rule that prevents turnarounds**: an edge can only be used if its *exact reverse* hasn't already been used earlier in the route (checked and validated on every candidate before it's ever returned). Combined with dead-end exclusion, this means the whole route is free of forced U-turns, while still allowing you to cross or rejoin a street you've been on before, from a different block or in a new direction.
   - **No unsafe crossings**: crossing a busy road (primary/secondary/trunk) at a point with no traffic signal (or signal-controlled crossing) is a hard rule, not a preference — the search simply won't consider it, regardless of how good the route would otherwise be. Walking *along* a busy road is a separate, milder concern already handled by the ordinary signal weighting.
   - **No tiny pointless loops**: revisiting a node within about 0.1mi of path-distance is blocked outright during the main search, and any candidate that still ends up with one (which can otherwise happen in the precise-distance return search — looping a short, cheap trail segment repeatedly is an efficient way to pad toward an exact target length) is heavily penalized in the final comparison between candidates.
8. **Elevation** (`src/lib/elevation.js`) — once a route is chosen, its point-by-point elevation is fetched from [Open-Elevation](https://open-elevation.com/) (a free, keyless API) and summed into a total gain figure, shown alongside the other stats. This runs *after* the route is already displayed (not before) unless you've set an elevation preference, since the route itself doesn't depend on it — the elevation figure just fills in a moment later rather than delaying the whole result. If you do set a minimum or maximum elevation-gain preference, the app generates a handful of candidate loops instead of one, checks each one's elevation up front, and picks whichever best satisfies your preference (falling back to the closest option, with a note, if none fully do).
9. **Backbone bias** (`src/lib/backbone.js`) — separately from trail-seeking, the app computes the convex hull of the reachable street network (the geometric "border of the neighborhood") and connects it into a rough perimeter loop back to the start, once per graph. Edges on this backbone get a weight discount in the main search, so it's drawn toward following long perimeter stretches instead of winding through interior side streets when both would work distance-wise - closer to how a runner would naturally prefer the big loop around a neighborhood over a maze of turns through the middle of it.
10. **Multiple attempts, and rejecting worse results**: every generation (initial or "try a different loop") runs a few different random seeds internally and keeps the best one, rather than committing to a single roll of the dice. On top of that, a regenerated result is only shown if it isn't meaningfully worse than what's already on screen (`isMeaningfullyWorse` in `src/lib/routeComparison.js`) — if every attempt comes back worse (e.g. an 8mi loop degrading to 6.99mi), the app says so and keeps showing the better result instead of replacing it.
11. The winning loop is drawn on a Leaflet map (using a muted CARTO Positron basemap so the route stands out) with small arrow markers along it (colored to match trail/street, using a colorblind-safe palette) showing which direction to run it, plus distance, trail %, traffic lights, turn count, and elevation gain, and a turn-by-turn breakdown, in the sidebar. Every generated loop is kept as a small thumbnail in a history strip so you can flip back to compare earlier options within the session.

### How far out does it look?

The Overpass query radius (how much street/trail data gets fetched around your address in the first place) is `target distance × 1609.34 × 0.62` meters, clamped between roughly 0.56mi and 10mi (`radiusForTargetMiles` in `src/lib/geo.js`). For an 8-mile request that's about a 5-mile radius — generally enough to include a trail a mile or two out. If that radius genuinely doesn't reach a trail you know is nearby, raising the `0.62` multiplier or the upper clamp is the direct fix. But radius alone doesn't guarantee a distant trail gets *used* - see trail-seeking above, which is what actually decides whether the search reaches for it.

### Tuning the algorithm

- **Distance precision**: `toleranceMeters` in `generateLoopRoute` (default ~80m / 0.05mi) controls how close a single loop must land to count as "on target." `bucketSize` in `bucketedReturnPath` (default 20m) controls the search's distance resolution — lower is more precise but slower.
- **Trail/signal/turn preference**: all in `edgeWeight()` — `if (edge.isTrail) w *= 0.5` for trail strength, `if (toNode?.hasSignal) w *= 1.12` for the (deliberately mild) signal penalty, and the `classifyTurn` + `switch` block for the turn penalty by angle.
- **Precision vs. cleanliness tradeoff**: `TURN_PENALTY_MI` near the bottom of the file controls how many extra turns the algorithm will tolerate to gain distance accuracy (default: about 0.004mi of "budget" per turn) when comparing the precise-loop candidate against the lap-repeat candidate. Raise it to favor fewer turns more strongly even at the cost of precision.
- `timeBudgetMs` options throughout bound how long the search runs — real street grids from Overpass are much bigger than a testing grid, so expect low-single-digit-second searches on longer routes.

### A note on dead ends and street coverage

Excluding every dead end can noticeably shrink the usable street network in cul-de-sac-heavy suburbs — sometimes a third or more of local streets are dead-end branches. That's an intentional tradeoff for a cleaner run with no forced U-turns, but it does mean the achievable loop size in very cul-de-sac-dense areas may be smaller than the raw street mileage suggests, making the lap fallback more likely to kick in.

### A note on very tightly bounded areas

If your address has only a very small area of connected streets within range (well under what a park-adjacent or suburban neighborhood would offer), hitting both tight distance precision *and* a low turn count stops being possible — there's only so much room to lay out a route, precise or not. In that case the app still prioritizes precision (per your target), and the route may involve more doubling back through the area than a spacious neighborhood would need. This is a physical constraint of the street network, not a bug — a bigger search radius or slightly different target distance is usually the fix.

## Sending a route to a Garmin watch

There's no way for a plain web app to push a route live to a paired watch — that requires Garmin's Connect IQ / Developer Program (a separate OAuth-based partner API with an approval process), which is a real option if you want a one-click "send" button down the road, but isn't something a personal project can do out of the box.

What *does* work today, for free, with no developer account: the **Export for Garmin (.tcx)** button generates a TCX **Course** file with turn cues (`CoursePoint` elements marked Left/Right at each real turn). Garmin Connect and compatible watches read that format specifically to drive on-device "Turn left onto Oak Ave" style prompts during navigation:

1. Click **Export for Garmin (.tcx)** after generating a route.
2. Go to [connect.garmin.com](https://connect.garmin.com) → **Training** → **Courses** → **Import**, and upload the `.tcx` file (or use the same Import option in the Garmin Connect mobile app).
3. Sync your watch with Garmin Connect as usual — the course (with turn prompts) will be available on-device under **Navigation → Courses**.

The plain **Export GPX** button is there as a broader-compatibility fallback (Strava, other GPS watches, etc.) — GPX doesn't have the same standardized turn-cue schema, so it'll show the route shape but not turn-by-turn prompts.

## Run it locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`.

## Deploy to your GitHub account

This repo already includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds and publishes to GitHub Pages automatically on every push to `main`.

1. Create a new repository on GitHub (public or private — Pages works for both on a paid plan; public repos get Pages free).
2. Push this project to it:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages**, and under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Push (or re-run the workflow from the **Actions** tab) — after it finishes, your app will be live at:
   ```
   https://YOUR_USERNAME.github.io/YOUR_REPO/
   ```

No build configuration changes are needed — `vite.config.js` already uses a relative base path so it works under any repo name.

## Notes and limitations

- Nominatim/Overpass are free public services with light rate limits — fine for personal use, but avoid scripting rapid repeated requests against them.
- Very rural addresses (sparse OSM street data) or very short/long target distances may not find a loop within tolerance; the app will tell you if that happens and suggest adjusting the distance.
- "Trail" is inferred from OSM tags (`highway=path`/`track`, or unpaved surface tags) — trail coverage is only as good as OpenStreetMap's data in your area. You can improve this yourself on [openstreetmap.org](https://www.openstreetmap.org) if a local trail is missing tags.
- The route search is a heuristic, not an exact optimizer — click "Try a different loop" to re-roll if the first result isn't great.
- **Parking lots and driveways**: OSM tags these as `highway=service`, same as some legitimate short connector streets. `isJunkService()` in `src/lib/graph.js` filters out anything tagged `service=parking_aisle`/`driveway`/`drive-through`/`bus`, plus any *unnamed* service way (real minor streets are almost always named; anonymous ones are almost always a lot aisle in practice). This catches the common cases well, but an oddly-tagged private road that isn't marked as a service way or with an access tag can still slip through occasionally — OSM data quality varies by area.
- **Performance**: the biggest wins came from not redoing expensive work. Trail-cluster detection and the full-graph distance search it depends on (`src/lib/trailSeeking.js`) are now cached on the graph object rather than recomputed on every candidate route, and a cheap straight-line pre-filter skips that search entirely when no trail is even plausibly in range. `findBiggestCleanLoop`'s fallback search (only used when the direct approach doesn't land cleanly) has lower default attempt counts and hard time budgets per attempt. Elevation is fetched *after* the route is already shown (not before) unless an elevation preference is set, since it doesn't affect route selection otherwise. The safety checks added for busy-road crossings and tiny-loop avoidance do add some per-edge search cost on top of this, so there's a real tradeoff between thoroughness and speed — real OSM data can also be significantly denser than open countryside, so generation time will vary by area regardless of these optimizations.
- **Busy-road crossings**: a node counts as "safe to cross" only if it's signal- or stop-controlled, or a pedestrian crossing explicitly tagged `crossing=traffic_signals`. A marked-but-unsignaled crosswalk doesn't count as safe for crossing a primary/secondary/trunk road, even though it's a normal legal crossing to *walk along* such a road via. This is a hard rule (the search won't consider it at all), not a soft preference.
- **Direction arrows**: placed along the route at roughly even spacing (`computeDirectionArrows` in `src/lib/routeGenerator.js`) using the local compass bearing between consecutive route points — they show which way to run the loop, not turn-by-turn instructions (the sidebar list covers that).
- **Colors**: trail/street/arrows use a colorblind-safe palette (Okabe-Ito: bluish-green `#009E73` for trail, blue `#0072B2` for street), and the basemap is CARTO's Positron style — a muted, mostly-monochrome map — specifically so the route is the most visually prominent thing on screen rather than competing with a busy default street-map style. Using a third-party basemap tile provider means the map now depends on CARTO's tile service being reachable in addition to Nominatim/Overpass/Open-Elevation.
- **Backbone bias is a preference, not a guarantee**: it discounts perimeter-following edges so the search leans toward them, but distance precision still takes priority when they conflict — hitting your exact target mileage sometimes requires deviating from the pure perimeter, which shows up as some turns even on a route that mostly follows the backbone. It also only has a shape to bias toward when the reachable street network actually has an outer boundary worth tracing (a real neighborhood grid); in a very small or oddly-shaped area it won't have much effect.
- **Route history is session-only**: thumbnails live in memory for the current browser session and reset if you refresh or submit a new address/mileage — there's no persistence across visits.
