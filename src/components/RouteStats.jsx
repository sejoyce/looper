import { metersToMiles } from '../lib/geo'

function fmtMiles(m) {
  return metersToMiles(m).toFixed(2)
}

function metersToFeet(m) {
  return m * 3.28084
}

export default function RouteStats({ summary, segments, onRegenerate, regenerating, onExportTcx, onExportGpx, elevation }) {
  if (!summary) return null

  const lapsWhole = Math.floor(summary.laps)
  const hasRemainder = summary.hasRemainderLoop

  return (
    <div className="stats-card">
      {summary.laps > 1 && (
        <p className="laps-note">
          This neighborhood doesn't have enough new road within range for one loop that long, so
          this route is your best <strong>{fmtMiles(summary.lapDistanceMeters)} mi</strong> loop
          run <strong>{lapsWhole}×</strong>
          {hasRemainder ? ', plus one shorter closing loop' : ''} to land close to your target
          distance.
        </p>
      )}
      {!summary.withinTolerance && (
        <p className="tolerance-note">
          Closest we could get on this street network: off by{' '}
          {(summary.errorMeters / 1609.344).toFixed(2)} mi from your target.
        </p>
      )}
      {elevation?.elevationNote && <p className="tolerance-note">{elevation.elevationNote}</p>}

      <div className="stats-grid">
        <div className="stat">
          <span className="stat-value">{fmtMiles(summary.distanceMeters)}</span>
          <span className="stat-label">miles</span>
        </div>
        <div className="stat">
          <span className="stat-value">{Math.round(summary.trailFraction * 100)}%</span>
          <span className="stat-label">on trail</span>
        </div>
        <div className="stat">
          <span className="stat-value">{summary.signalCount}</span>
          <span className="stat-label">traffic lights</span>
        </div>
        <div className="stat">
          <span className="stat-value">{summary.turnCount}</span>
          <span className="stat-label">turns{summary.laps > 1 ? ' / lap' : ''}</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {elevation === null ? '…' : elevation.available ? Math.round(metersToFeet(elevation.gainMeters)) : '—'}
          </span>
          <span className="stat-label">ft elevation gain</span>
        </div>
      </div>

      <button className="btn-secondary" onClick={onRegenerate} disabled={regenerating}>
        {regenerating ? 'Re-plotting…' : 'Try a different loop'}
      </button>

      <div className="export-row">
        <button className="btn-export" onClick={onExportTcx}>
          Export for Garmin (.tcx)
        </button>
        <button className="btn-export" onClick={onExportGpx}>
          Export GPX
        </button>
      </div>

      <div className="segments">
        <span className="field-label">Along the way</span>
        <ol className="segments-list">
          {segments.map((seg, i) => (
            <li key={i} className={seg.isTrail ? 'is-trail' : ''}>
              <span className="segment-name">{seg.name}</span>
              <span className="segment-distance">{fmtMiles(seg.distance)} mi</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
