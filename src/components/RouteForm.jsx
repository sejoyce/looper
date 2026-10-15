import { useState } from 'react'
import AddressField from './AddressField'

export default function RouteForm({
  address, setAddress, onAddressSelect, miles, setMiles,
  minElevation, setMinElevation, maxElevation, setMaxElevation,
  onSubmit, loading, hasRoute,
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)

  function handleSubmit(e) {
    e.preventDefault()
    onSubmit()
  }

  return (
    <form className="route-form" onSubmit={handleSubmit}>
      <label className="field">
        <span className="field-label">Starting address</span>
        <AddressField value={address} onChange={setAddress} onSelect={onAddressSelect} />
      </label>

      <label className="field">
        <span className="field-label">Target distance (miles)</span>
        <input
          type="number"
          value={miles}
          onChange={(e) => setMiles(e.target.value)}
          min="0.5"
          max="26"
          step="0.25"
          placeholder="e.g. 5"
          required
        />
      </label>

      <button
        type="button"
        className="btn-advanced-toggle"
        onClick={() => setShowAdvanced((v) => !v)}
        aria-expanded={showAdvanced}
      >
        {showAdvanced ? '− Hide' : '+ Elevation preferences'}
      </button>

      {showAdvanced && (
        <div className="advanced-fields">
          <label className="field">
            <span className="field-label">Min elevation gain (ft, optional)</span>
            <input
              type="number"
              value={minElevation}
              onChange={(e) => setMinElevation(e.target.value)}
              min="0"
              step="10"
              placeholder="No minimum"
            />
          </label>
          <label className="field">
            <span className="field-label">Max elevation gain (ft, optional)</span>
            <input
              type="number"
              value={maxElevation}
              onChange={(e) => setMaxElevation(e.target.value)}
              min="0"
              step="10"
              placeholder="No maximum"
            />
          </label>
        </div>
      )}

      <button type="submit" className={`btn-primary${hasRoute ? ' is-regenerate' : ''}`} disabled={loading}>
        {loading ? 'Plotting loop…' : hasRoute ? 'Try a different loop' : 'Find my loop'}
      </button>
    </form>
  )
}
