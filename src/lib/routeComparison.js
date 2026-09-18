// Negative if a is the better route, positive if b is, ~0 if roughly a wash.
// "Better" means: within tolerance beats not, then closer to target, then
// fewer turns.
export function compareRoutes(a, b) {
  if (a.withinTolerance !== b.withinTolerance) return a.withinTolerance ? -1 : 1
  if (Math.abs(a.errorMeters - b.errorMeters) > 40) return a.errorMeters - b.errorMeters
  return a.turnCount - b.turnCount
}

// A regenerated result only replaces what's on screen if it's not
// meaningfully worse - otherwise "try a different loop" could silently
// hand back something worse than what the person already has.
export function isMeaningfullyWorse(candidate, current) {
  if (current.withinTolerance && !candidate.withinTolerance) return true
  if (candidate.errorMeters - current.errorMeters > 150) return true // ~0.09mi worse
  return false
}
