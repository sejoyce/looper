import { useState, useRef, useEffect } from 'react'
import { fetchAddressSuggestions, hasHouseNumber } from '../lib/addressAutocomplete'

const DEBOUNCE_MS = 300

export default function AddressField({ value, onChange, onSelect }) {
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [searching, setSearching] = useState(false)
  const focusedRef = useRef(false)
  const debounceRef = useRef(null)
  const abortRef = useRef(null)
  const blurTimeoutRef = useRef(null)
  const skipNextFetchRef = useRef(false)

  useEffect(() => {
    if (skipNextFetchRef.current) {
      skipNextFetchRef.current = false
      return
    }
    clearTimeout(debounceRef.current)
    if (abortRef.current) abortRef.current.abort()
    setSearching(false)

    // Only look up suggestions while the person is actually typing here;
    // never pop a dropdown open after they've moved on or submitted.
    if (!focusedRef.current) return

    if (!value || value.trim().length < 3 || !hasHouseNumber(value)) {
      setSuggestions([])
      setOpen(false)
      return
    }

    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController()
      abortRef.current = controller
      setSearching(true)
      try {
        const results = await fetchAddressSuggestions(value, controller.signal)
        if (controller.signal.aborted || !focusedRef.current) return
        setSuggestions(results)
        setOpen(results.length > 0)
        setActiveIndex(-1)
        setSearching(false)
      } catch {
        if (!controller.signal.aborted) setSearching(false)
        // A cancelled or failed suggestion lookup just means no dropdown -
        // the person can still type and submit the address manually.
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function selectSuggestion(s) {
    if (abortRef.current) abortRef.current.abort()
    setSearching(false)
    skipNextFetchRef.current = true
    onChange(s.label)
    if (onSelect) onSelect(s)
    setOpen(false)
    setSuggestions([])
  }

  function handleKeyDown(e) {
    handleEnterSubmit(e)
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0) {
        e.preventDefault()
        selectSuggestion(suggestions[activeIndex])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  function handleEnterSubmit(e) {
    if (e.key === 'Enter' && !(open && activeIndex >= 0)) {
      clearTimeout(debounceRef.current)
      if (abortRef.current) abortRef.current.abort()
      setSearching(false)
      setOpen(false)
    }
  }

  function handleBlur() {
    // Delay closing so a click on a suggestion (which also blurs the
    // input) has a chance to register before the list disappears.
    blurTimeoutRef.current = setTimeout(() => setOpen(false), 150)
  }

  return (
    <div className="address-field-wrap">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          focusedRef.current = true
          if (suggestions.length > 0) setOpen(true)
        }}
        onBlur={() => {
          focusedRef.current = false
          clearTimeout(debounceRef.current)
          if (abortRef.current) abortRef.current.abort()
          setSearching(false)
          handleBlur()
        }}
        placeholder="1234 Spruce St, Philadelphia, PA"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        required
      />
      {!searching && !open && focusedRef.current && value.trim().length >= 1 && !hasHouseNumber(value) && (
        <div className="address-hint">Start with a house number, e.g. 2000 Pennsylvania Ave</div>
      )}
      {searching && !open && (
        <div className="address-searching" aria-live="polite">Searching…</div>
      )}
      {open && (
        <ul className="address-suggestions" role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={`${s.lat},${s.lon}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'is-active' : ''}
              onMouseDown={(e) => {
                e.preventDefault() // keep focus/blur timing predictable
                clearTimeout(blurTimeoutRef.current)
                selectSuggestion(s)
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
