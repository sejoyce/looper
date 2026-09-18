// Verifies the "don't present a worse regenerate result" logic directly:
// the exact scenario the user hit (8mi loop found, regenerate returns
// 6.99mi) should be flagged as meaningfully worse and rejected.
import { compareRoutes, isMeaningfullyWorse } from '../src/lib/routeComparison.js'
import { milesToMeters } from '../src/lib/geo.js'

const eightMileGood = { distanceMeters: milesToMeters(8.01), errorMeters: milesToMeters(0.01), withinTolerance: true, turnCount: 40 }
const sixNineNine = { distanceMeters: milesToMeters(6.99), errorMeters: milesToMeters(1.01), withinTolerance: false, turnCount: 35 }
const eightPointOhTwo = { distanceMeters: milesToMeters(8.02), errorMeters: milesToMeters(0.02), withinTolerance: true, turnCount: 30 }
const sameQualityFewerTurns = { distanceMeters: milesToMeters(8.0), errorMeters: milesToMeters(0.0), withinTolerance: true, turnCount: 25 }

const checks = [
  ['6.99mi result flagged as meaningfully worse than 8.01mi', isMeaningfullyWorse(sixNineNine, eightMileGood) === true],
  ['8.02mi (still within tolerance) NOT flagged as worse than 8.01mi', isMeaningfullyWorse(eightPointOhTwo, eightMileGood) === false],
  ['Same-quality, fewer-turns candidate is preferred (compareRoutes < 0)', compareRoutes(sameQualityFewerTurns, eightMileGood) < 0],
  ['compareRoutes ranks within-tolerance above not-within-tolerance', compareRoutes(eightMileGood, sixNineNine) < 0],
]

let allPass = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'OK' : 'FAIL'}: ${label}`)
  if (!pass) allPass = false
}
console.log(allPass ? '\nALL ROUTE-COMPARISON CHECKS PASSED' : '\nCHECKS FAILED')
process.exit(allPass ? 0 : 1)
