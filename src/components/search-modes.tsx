import { useState } from 'react'
import { ArrowDownWideNarrow, ListFilter } from 'lucide-react'
import type { SearchMode } from '../search'
import type { SearchScope } from '../api'

export function SearchModes({ mode, cutoff, scope, onChange }: { mode: SearchMode; cutoff: number; scope: SearchScope; onChange: (mode: SearchMode) => void }) {
  const [tooltip, setTooltip] = useState<SearchMode | null>(null)
  const options = [
    { value: 'sorted' as const, label: 'Ranked', Icon: ArrowDownWideNarrow, description: `Show every searchable ${scope === 'favorites' ? 'favorite' : 'photo'}, ordered from best match to least similar. No cutoff.` },
    { value: 'definitive' as const, label: 'Filtered', Icon: ListFilter, description: `Show only ${scope === 'favorites' ? 'favorites' : 'photos'} with a similarity score of ${cutoff}% or higher, best matches first. Adjust the cutoff below. Percentages measure similarity, not certainty.` },
  ]
  return <div className="search-mode-switch" role="group" aria-label="Search mode">
    {options.map(({ value, label, Icon, description }) => <div className="mode-choice" key={value} onMouseEnter={() => setTooltip(value)} onMouseLeave={() => setTooltip(null)}>
      <button type="button" aria-label={`${label} search`} aria-pressed={mode === value} aria-describedby={tooltip === value ? `mode-help-${value}` : undefined}
        onClick={() => onChange(value)} onFocus={() => setTooltip(value)} onBlur={() => setTooltip(null)}
        onKeyDown={event => { if (event.key === 'Escape') { setTooltip(null); event.preventDefault() } }}>
        <Icon size={18} aria-hidden="true"/><span className="mode-label">{label}</span>
      </button>
      {tooltip === value && <div className="mode-tooltip-position"><div className="mode-tooltip" role="tooltip" id={`mode-help-${value}`}><strong>{label} search</strong>{description}</div></div>}
    </div>)}
  </div>
}
