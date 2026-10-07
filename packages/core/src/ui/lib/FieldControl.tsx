/**
 * The labeled field wrapper that renders every custom field type: text,
 * textarea, select, multiselect, number, range, yesno, date.
 *
 * Screens pass the field definition, the current answer, and whether the
 * answer failed the required check; data-invalid on the wrapper drives the
 * styling hook. missingRequired (src/config/validate) stays the single
 * source of truth for what counts as unanswered - it is re-exported here,
 * with a Set-shaped helper, so form screens import both from one place.
 */
import type { ReactNode } from 'react'
import type { CustomField, CustomValue } from '../../config/types'
import { missingRequired } from '../../config/validate'

export { missingRequired }

/** Ids of required fields left unanswered, for quick data-invalid lookups. */
export function missingRequiredIds(
  fields: CustomField[],
  answers: Record<string, CustomValue>,
): Set<string> {
  return new Set(missingRequired(fields, answers).map((f) => f.id))
}

export interface FieldControlProps {
  field: CustomField
  value: CustomValue | undefined
  onChange: (value: CustomValue) => void
  invalid?: boolean
}

function asText(v: CustomValue | undefined): string {
  if (typeof v === 'number') return String(v)
  return typeof v === 'string' ? v : ''
}

function asList(v: CustomValue | undefined): string[] {
  return Array.isArray(v) ? v : []
}

export function FieldControl({ field, value, onChange, invalid }: FieldControlProps) {
  const inputId = `fc-${field.id}`
  const labelId = `${inputId}-label`
  const options = field.options || []

  let control: ReactNode
  switch (field.type) {
    case 'text':
      control = (
        <input
          id={inputId}
          type="text"
          value={asText(value)}
          placeholder={field.placeholder}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )
      break
    case 'textarea':
      control = (
        <textarea
          id={inputId}
          rows={3}
          value={asText(value)}
          placeholder={field.placeholder}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )
      break
    case 'select':
      control = (
        <select
          id={inputId}
          value={asText(value)}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose...</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
      break
    case 'multiselect': {
      const chosen = asList(value)
      control = (
        <div role="group" aria-labelledby={labelId}>
          {options.map((o) => (
            <label key={o} className="check">
              <input
                type="checkbox"
                checked={chosen.includes(o)}
                onChange={(e) =>
                  onChange(
                    e.target.checked ? [...chosen, o] : chosen.filter((c) => c !== o),
                  )
                }
              />
              <span>{o}</span>
            </label>
          ))}
        </div>
      )
      break
    }
    case 'number':
      control = (
        <input
          id={inputId}
          type="number"
          inputMode="decimal"
          value={asText(value)}
          placeholder={field.placeholder}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )
      break
    case 'range': {
      const min = field.min ?? 0
      const max = field.max ?? 10
      const answered = typeof value === 'number' || (typeof value === 'string' && value !== '')
      const current = answered ? Number(value) : min
      control = (
        <div className="range-row">
          <input
            id={inputId}
            type="range"
            min={min}
            max={max}
            step={1}
            value={current}
            aria-invalid={invalid || undefined}
            aria-valuetext={answered ? String(current) : 'Not answered'}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <span className="range-value" aria-hidden="true">
            {answered ? current : '-'}
          </span>
        </div>
      )
      break
    }
    case 'yesno': {
      const current = asText(value)
      control = (
        <div className="toggle-group" role="group" aria-labelledby={labelId}>
          {(['Yes', 'No'] as const).map((o) => (
            <button
              key={o}
              type="button"
              className={current === o ? 'toggle active' : 'toggle'}
              aria-pressed={current === o}
              onClick={() => onChange(current === o ? '' : o)}
            >
              {o}
            </button>
          ))}
        </div>
      )
      break
    }
    case 'date':
      control = (
        <input
          id={inputId}
          type="date"
          value={asText(value)}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )
      break
  }

  // multiselect/yesno label their group via aria-labelledby; the rest get a
  // real <label for>.
  const usesGroup = field.type === 'multiselect' || field.type === 'yesno'
  return (
    <div className="field" data-invalid={invalid ? 'true' : undefined}>
      {usesGroup ? (
        <span className="field-label" id={labelId}>
          {field.label}
        </span>
      ) : (
        <label className="field-label" htmlFor={inputId} id={labelId}>
          {field.label}
        </label>
      )}
      {control}
    </div>
  )
}
