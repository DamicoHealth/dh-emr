/**
 * The form template builder - full CRUD over the org's visit-form library.
 *
 * Restores what the previous React port lost: create, duplicate, rename,
 * enable/disable and delete for whole templates, on top of the per-template
 * section and question editor. Every rule in here was a shipped bug:
 *
 *  - Edits persist through saveLibrary ONLY, which mirrors the first enabled
 *    template back to the legacy formSchema key on every save.
 *  - A synthesized library (org config not yet synced to this device) makes
 *    the WHOLE builder read-only: saving one would replace the org's real
 *    form with a fabricated empty one.
 *  - Admin-device-only editing. Controls are DISABLED with the reason on the
 *    control, never enabled-but-silently-ignored: an admin once confirmed
 *    "Delete Vitals and its 3 questions?" and nothing happened, no message.
 *  - Field ids are immutable (answers key on them); deleting a field or a
 *    section keeps saved answers on existing records, and every delete
 *    confirm says exactly that.
 *  - A choices list can never be persisted empty: a required select with no
 *    options is unanswerable and blocks every save org-wide.
 *  - New custom sections always land at the END of the form.
 *  - Collapsed-by-default is only allowed for sections without required
 *    fields; the checkbox is disabled with the reason when one exists.
 *  - Before every write the library is RE-READ, so a config pull that landed
 *    while the builder was open is never silently reverted.
 *
 * Reordering is up/down buttons (keyboard included), not drag: no drag
 * dependency exists in this build, and buttons work on every device.
 */
import { useCallback, useEffect, useState } from 'react'
import { config } from '../../kernel'
import { loadLibraryDetailed, saveLibrary } from '../../config/keys'
import {
  BUILTIN_SECTIONS,
  addCustomSection,
  addField,
  clearSectionRoles,
  deleteSection,
  getEffectiveSchema,
  removeField,
  reorderFields,
  reorderSections,
  setSectionHidden,
  setSectionRoles,
  setSectionTitle,
  updateField,
} from '../../config/sections'
import {
  ROLES,
  ROLE_LABELS,
  materializeRoles,
  roleGridFor,
  toggleGridCell,
} from '../../config/roles'
import { FIELD_TYPES } from '../../config/types'
import type {
  CustomField,
  EffectiveSection,
  FieldType,
  FormTemplateLibrary,
  RawSection,
  SectionRoles,
} from '../../config/types'
import {
  EMPTY_OPTIONS_WARNING,
  commitOptions,
  commitRange,
  fieldTypeDefaults,
} from '../../config/validate'
import { useBodyScrollLock } from '../lib/scrollLock'
import { useDialog } from '../lib/useDialog'
import {
  COLLAPSED_LOCK_REASON,
  FIELD_ID_NOTE,
  GATE_REASON,
  REQUIRED_SECTION_REASON,
  SYNTHESIZED_REASON,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  fieldDeleteConfirm,
  moveId,
  rawSchemaOf,
  renameTemplate,
  resetSectionTitle,
  sectionDeleteConfirm,
  setSectionCollapsed,
  setTemplateEnabled,
  templateDeleteConfirm,
  updateTemplateSchema,
  type LibraryOpResult,
} from './libraryOps'
import './templates.css'

export interface TemplateBuilderProps {
  /**
   * The admin gate: non-admins get the whole builder read-only. Field passes
   * the device role, Clinic the signed-in account's admin flag.
   */
  isAdmin: boolean
  /**
   * Why editing is off when !isAdmin (the Read only banner and every control
   * title). Defaults to the Field device-role copy; Clinic passes its own.
   */
  gateReason?: string
  onClose: () => void
  /** Called after every persisted change so the host screen can refresh. */
  onChanged?: () => void
}

const CANONICAL_TITLES = new Map(BUILTIN_SECTIONS.map((s) => [s.id, s.title]))

type Notice = { tone: 'ok' | 'bad'; text: string } | null

type Op = (base: FormTemplateLibrary) => LibraryOpResult | FormTemplateLibrary

export default function TemplateBuilder({
  isAdmin,
  gateReason = GATE_REASON,
  onClose,
  onChanged,
}: TemplateBuilderProps) {
  const panelRef = useDialog<HTMLElement>(onClose)
  useBodyScrollLock(true)

  const [lib, setLib] = useState<FormTemplateLibrary | null>(null)
  const [synthesized, setSynthesized] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedOnce, setSavedOnce] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const { lib: l, synthesized: syn } = await loadLibraryDetailed(config)
        if (!alive) return
        setLib(l)
        setSynthesized(syn)
        setSelectedId(l.templates[0]?.id ?? null)
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const canEdit = isAdmin && !synthesized
  const lockedReason = !isAdmin ? gateReason : synthesized ? SYNTHESIZED_REASON : ''

  /**
   * Apply one operation and persist it. Re-reads the stored library first so
   * a sync pull that landed while the builder was open is the base, not a
   * mount-time snapshot. The two leading guards are the LAST line of defence
   * behind the disabled controls.
   */
  const apply = useCallback(
    async (op: Op): Promise<void> => {
      if (!isAdmin) return // standard devices are read-only
      if (synthesized) return // never write a fabricated library
      let base = lib
      try {
        const fresh = await loadLibraryDetailed(config)
        if (!fresh.synthesized) base = fresh.lib
      } catch {
        /* keep the in-memory copy */
      }
      if (!base) return
      const raw = op(base)
      const result: LibraryOpResult = 'lib' in raw ? raw : { lib: raw, refusal: null }
      if (result.refusal) {
        setLib(base)
        setNotice({ tone: 'bad', text: result.refusal })
        return
      }
      setLib(result.lib)
      if (result.focusId) setSelectedId(result.focusId)
      setSaving(true)
      setNotice(null)
      try {
        await saveLibrary(config, result.lib)
        setSavedOnce(true)
        if (result.autoEnabled) {
          setNotice({
            tone: 'ok',
            text: `Deleted. "${result.autoEnabled}" was turned on so there is always a visit form.`,
          })
        }
        onChanged?.()
      } catch (e) {
        setNotice({
          tone: 'bad',
          text: `That change was not saved: ${e instanceof Error ? e.message : String(e)}. Your form is unchanged.`,
        })
      } finally {
        setSaving(false)
      }
    },
    [isAdmin, synthesized, lib, onChanged],
  )

  if (loadError) {
    return (
      <div className="panel-backdrop" onClick={onClose}>
        <aside
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Form templates"
          className="panel tb-panel"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="panel-head">
            <h2>Form templates</h2>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </header>
          <div className="panel-body">
            <div className="alert alert-bad" role="alert">
              <strong>Could not load the form library.</strong>
              <p>{loadError}</p>
            </div>
          </div>
        </aside>
      </div>
    )
  }

  if (!lib) {
    return (
      <div className="panel-backdrop" onClick={onClose}>
        <aside
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Form templates"
          className="panel tb-panel"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="panel-head">
            <h2>Form templates</h2>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </header>
          <div className="panel-body">
            <div className="muted">Loading…</div>
          </div>
        </aside>
      </div>
    )
  }

  const selected = lib.templates.find((t) => t.id === selectedId) ?? lib.templates[0] ?? null

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Form templates"
        className="panel tb-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-head">
          <div>
            <h2>Form templates</h2>
            <p className="muted small tb-headnote">
              These belong to your organization. A change here reaches everyone on the next sync.
            </p>
          </div>
          <div className="tb-head-right">
            <span className="muted small" aria-live="polite">
              {saving ? 'Saving…' : savedOnce ? 'Saved' : ''}
            </span>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="panel-body">
          {!isAdmin ? (
            <div className="alert alert-info">
              <strong>Read only</strong>
              <p>{gateReason}</p>
            </div>
          ) : null}
          {synthesized ? (
            <div className="alert alert-info">
              <strong>Form settings have not reached this device yet</strong>
              <p>{SYNTHESIZED_REASON} Sync this device, then come back.</p>
            </div>
          ) : null}
          {notice ? (
            <div
              className={notice.tone === 'ok' ? 'alert alert-info' : 'alert alert-bad'}
              role={notice.tone === 'ok' ? 'status' : 'alert'}
            >
              {notice.text}
            </div>
          ) : null}

          <TemplateList
            lib={lib}
            selectedId={selected?.id ?? null}
            canEdit={canEdit}
            lockedReason={lockedReason}
            onSelect={setSelectedId}
            onApply={(op) => {
              void apply(op)
            }}
          />

          {selected ? (
            <SectionEditor
              key={selected.id}
              templateName={selected.name}
              raw={rawSchemaOf(lib, selected.id)}
              canEdit={canEdit}
              lockedReason={lockedReason}
              onSchemaOf={(fn) => {
                // Compute against the FRESH base inside apply, not against the
                // render-time raw: a sync pull must not be reverted.
                void apply((base) => updateTemplateSchema(base, selected.id, fn(rawSchemaOf(base, selected.id))))
              }}
            />
          ) : null}
        </div>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------- template list ---

function TemplateList({
  lib,
  selectedId,
  canEdit,
  lockedReason,
  onSelect,
  onApply,
}: {
  lib: FormTemplateLibrary
  selectedId: string | null
  canEdit: boolean
  lockedReason: string
  onSelect: (id: string) => void
  onApply: (op: Op) => void
}) {
  const [newName, setNewName] = useState('')
  const lock = lockedReason || undefined

  return (
    <section className="card tb-card">
      <h3>Forms</h3>
      <p className="muted small">
        Turn a form on to offer it for new visits; with more than one on, the visit form shows a
        selector. Every visit keeps the name of the form it was filed under.
      </p>
      <ul className="tb-template-list">
        {lib.templates.map((t, i) => {
          const enabled = t.enabled !== false
          const isSelected = t.id === selectedId
          return (
            <li key={t.id} className={isSelected ? 'tb-template selected' : 'tb-template'}>
              <TemplateName
                name={t.name}
                index={i}
                canEdit={canEdit}
                lockedReason={lockedReason}
                onRename={(name) => onApply((base) => renameTemplate(base, t.id, name))}
              />
              <label className="check tb-on" title={lock}>
                <input
                  type="checkbox"
                  aria-label={`Form ${i + 1} on`}
                  checked={enabled}
                  disabled={!canEdit}
                  onChange={(e) => {
                    // Read the checkbox NOW: the op runs after an async
                    // re-read, by which time React has re-synced the control.
                    const next = e.target.checked
                    onApply((base) => setTemplateEnabled(base, t.id, next))
                  }}
                />
                <span>On</span>
              </label>
              <button
                type="button"
                className={isSelected ? 'btn tb-small' : 'btn btn-ghost tb-small'}
                aria-label={`Edit the sections of form ${i + 1}`}
                aria-pressed={isSelected}
                onClick={() => onSelect(t.id)}
              >
                Sections
              </button>
              <button
                type="button"
                className="btn btn-ghost tb-small"
                aria-label={`Duplicate form ${i + 1}`}
                disabled={!canEdit}
                title={lock}
                onClick={() => onApply((base) => duplicateTemplate(base, t.id))}
              >
                Duplicate
              </button>
              <button
                type="button"
                className="btn btn-ghost tb-small tb-danger"
                aria-label={`Delete form ${i + 1}`}
                disabled={!canEdit}
                title={lock}
                onClick={() => {
                  // Never ask a question whose answer will be thrown away.
                  if (!canEdit) return
                  if (window.confirm(templateDeleteConfirm(t.name))) {
                    onApply((base) => deleteTemplate(base, t.id))
                  }
                }}
              >
                Delete
              </button>
            </li>
          )
        })}
      </ul>
      <div className="tb-add-row">
        <input
          type="text"
          aria-label="New form name"
          placeholder="New form name"
          value={newName}
          disabled={!canEdit}
          title={lock}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={!canEdit || !newName.trim()}
          title={lock}
          onClick={() => {
            onApply((base) => createTemplate(base, newName))
            setNewName('')
          }}
        >
          Add form
        </button>
      </div>
    </section>
  )
}

/** Inline rename with a local buffer, committed on blur or Enter. */
function TemplateName({
  name,
  index,
  canEdit,
  lockedReason,
  onRename,
}: {
  name: string
  index: number
  canEdit: boolean
  lockedReason: string
  onRename: (name: string) => void
}) {
  const [value, setValue] = useState(name)
  useEffect(() => setValue(name), [name])
  return (
    <input
      className="tb-name"
      type="text"
      aria-label={`Form ${index + 1} name`}
      value={value}
      disabled={!canEdit}
      title={lockedReason || undefined}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value.trim() && value.trim() !== name) onRename(value)
        else setValue(name)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
    />
  )
}

// --------------------------------------------------------- section editor ---

function SectionEditor({
  templateName,
  raw,
  canEdit,
  lockedReason,
  onSchemaOf,
}: {
  templateName: string
  raw: { sections: RawSection[] }
  canEdit: boolean
  lockedReason: string
  onSchemaOf: (fn: (raw: { sections: RawSection[] }) => { sections: RawSection[] }) => void
}) {
  const effective = getEffectiveSchema(raw).sections
  // Access to Care, Rx Presets and Provider have no body on the visit form;
  // offering them as arrangeable would be a dead control.
  const arrangeable = effective.filter((s) => !s.notOnForm)
  const notOnForm = effective.filter((s) => s.notOnForm)
  const fullIds = effective.map((s) => s.id)
  const movableIds = arrangeable.map((s) => s.id)
  const lock = lockedReason || undefined

  return (
    <section className="card tb-card">
      <h3>Sections of "{templateName}"</h3>
      <p className="muted small">
        Reorder with the arrows, hide sections you do not use, rename them, and add your own
        sections with questions. The lists the built-in sections offer, like medications and lab
        tests, are edited on the Settings screen.
      </p>
      <ul className="tb-section-list">
        {arrangeable.map((sec, i) => (
          <SectionRow
            key={sec.id}
            section={sec}
            canEdit={canEdit}
            lockedReason={lockedReason}
            isFirst={i === 0}
            isLast={i === arrangeable.length - 1}
            onMove={(dir) => {
              const next = moveId(fullIds, movableIds, sec.id, dir)
              if (next) onSchemaOf((base) => reorderSections(base, next))
            }}
            onToggleHidden={() => onSchemaOf((base) => setSectionHidden(base, sec.id, !sec.hidden))}
            onRename={(title) => onSchemaOf((base) => setSectionTitle(base, sec.id, title))}
            onResetTitle={() => onSchemaOf((base) => resetSectionTitle(base, sec.id))}
            onSetCollapsed={(v) => onSchemaOf((base) => setSectionCollapsed(base, sec.id, v))}
            onSetRoles={(roles) => onSchemaOf((base) => setSectionRoles(base, sec.id, roles))}
            onResetRoles={() => onSchemaOf((base) => clearSectionRoles(base, sec.id))}
            onDelete={() => onSchemaOf((base) => deleteSection(base, sec.id))}
            onAddField={(f) => onSchemaOf((base) => addField(base, sec.id, f))}
            onUpdateField={(fid, patch) => onSchemaOf((base) => updateField(base, sec.id, fid, patch))}
            onRemoveField={(fid) => onSchemaOf((base) => removeField(base, sec.id, fid))}
            onReorderFields={(ids) => onSchemaOf((base) => reorderFields(base, sec.id, ids))}
          />
        ))}
      </ul>
      <div className="btn-row">
        <button
          type="button"
          className="btn"
          disabled={!canEdit}
          title={lock}
          onClick={() => onSchemaOf((base) => addCustomSection(base, 'New section'))}
        >
          Add a section
        </button>
      </div>
      {notOnForm.length > 0 ? (
        <p className="muted small">
          {notOnForm.map((s) => s.title).join(', ')} {notOnForm.length === 1 ? 'is' : 'are'} kept
          for compatibility with the older app but {notOnForm.length === 1 ? 'does' : 'do'} not
          appear on the visit form, so {notOnForm.length === 1 ? 'it is' : 'they are'} not listed
          above.
        </p>
      ) : null}
    </section>
  )
}

function SectionRow({
  section,
  canEdit,
  lockedReason,
  isFirst,
  isLast,
  onMove,
  onToggleHidden,
  onRename,
  onResetTitle,
  onSetCollapsed,
  onSetRoles,
  onResetRoles,
  onDelete,
  onAddField,
  onUpdateField,
  onRemoveField,
  onReorderFields,
}: {
  section: EffectiveSection
  canEdit: boolean
  lockedReason: string
  isFirst: boolean
  isLast: boolean
  onMove: (dir: -1 | 1) => void
  onToggleHidden: () => void
  onRename: (title: string) => void
  onResetTitle: () => void
  onSetCollapsed: (collapsed: boolean) => void
  onSetRoles: (roles: SectionRoles) => void
  onResetRoles: () => void
  onDelete: () => void
  onAddField: (f: Omit<CustomField, 'id'>) => void
  onUpdateField: (fieldId: string, patch: Partial<CustomField>) => void
  onRemoveField: (fieldId: string) => void
  onReorderFields: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [rolesOpen, setRolesOpen] = useState(false)
  const [title, setTitle] = useState(section.title)
  useEffect(() => setTitle(section.title), [section.title])

  const lock = lockedReason || undefined
  const canonical = CANONICAL_TITLES.get(section.id)
  const renamedBuiltin = section.builtin && !!canonical && section.title !== canonical
  const hasRequiredField = section.fields.some((f) => f.required)
  const collapseLock = !canEdit ? lock : hasRequiredField ? COLLAPSED_LOCK_REASON : undefined
  const rolesOverridden = section.roles !== undefined

  return (
    <li className={section.hidden ? 'tb-section is-hidden' : 'tb-section'}>
      <div className="tb-section-head">
        <span className="tb-updown">
          <button
            type="button"
            className="btn btn-ghost tb-small"
            aria-label={`Move ${section.title} up`}
            disabled={!canEdit || isFirst}
            title={lock}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn-ghost tb-small"
            aria-label={`Move ${section.title} down`}
            disabled={!canEdit || isLast}
            title={lock}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
        </span>
        <input
          className="tb-name"
          type="text"
          aria-label={`Rename the ${section.title} section`}
          value={title}
          disabled={!canEdit}
          title={lock}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() && title.trim() !== section.title) onRename(title.trim())
            else setTitle(section.title)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
        />
        {renamedBuiltin ? (
          <button
            type="button"
            className="btn btn-ghost tb-small"
            aria-label={`Reset the ${section.title} section name to ${canonical}`}
            disabled={!canEdit}
            title={lock ?? `Go back to "${canonical}"`}
            onClick={onResetTitle}
          >
            Reset name
          </button>
        ) : null}
        {section.builtin ? (
          <span className="tb-chip">Built in</span>
        ) : (
          <span className="tb-chip tb-chip-custom">
            {section.fields.length} question{section.fields.length === 1 ? '' : 's'}
          </span>
        )}
        {rolesOverridden ? <span className="tb-chip tb-chip-roles">Roles changed</span> : null}
        <button
          type="button"
          className="btn btn-ghost tb-small"
          aria-label={`Roles for the ${section.title} section`}
          aria-expanded={rolesOpen}
          onClick={() => setRolesOpen((o) => !o)}
        >
          {rolesOpen ? 'Done with roles' : 'Roles'}
        </button>
        {section.required ? (
          <button
            type="button"
            className="btn btn-ghost tb-small"
            aria-label={`Hide the ${section.title} section`}
            disabled
            title={REQUIRED_SECTION_REASON}
          >
            Always shown
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost tb-small"
            aria-label={`${section.hidden ? 'Show' : 'Hide'} the ${section.title} section`}
            disabled={!canEdit}
            title={lock}
            onClick={onToggleHidden}
          >
            {section.hidden ? 'Show' : 'Hide'}
          </button>
        )}
        {!section.builtin ? (
          <>
            <button
              type="button"
              className="btn btn-ghost tb-small"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Done' : 'Questions'}
            </button>
            <button
              type="button"
              className="btn btn-ghost tb-small tb-danger"
              aria-label={`Delete the ${section.title} section`}
              disabled={!canEdit}
              title={lock}
              onClick={() => {
                // Never ask a question whose answer will be thrown away.
                if (!canEdit) return
                if (window.confirm(sectionDeleteConfirm(section.title, section.fields.length))) {
                  onDelete()
                }
              }}
            >
              Delete
            </button>
          </>
        ) : null}
      </div>

      {!section.builtin ? (
        <label className="check tb-collapse" title={collapseLock}>
          <input
            type="checkbox"
            aria-label={`Starts collapsed: ${section.title}`}
            checked={!hasRequiredField && section.collapsed !== false}
            disabled={!canEdit || hasRequiredField}
            onChange={(e) => onSetCollapsed(e.target.checked)}
          />
          <span>Starts collapsed on the visit form</span>
          {hasRequiredField ? <span className="muted small"> {COLLAPSED_LOCK_REASON}</span> : null}
        </label>
      ) : null}

      {rolesOpen ? (
        <RoleGrid
          section={section}
          canEdit={canEdit}
          lockedReason={lockedReason}
          onSetRoles={onSetRoles}
          onResetRoles={onResetRoles}
        />
      ) : null}

      {open && !section.builtin ? (
        <FieldEditor
          canEdit={canEdit}
          lockedReason={lockedReason}
          fields={section.fields}
          onAdd={onAddField}
          onUpdate={onUpdateField}
          onRemove={onRemoveField}
          onReorder={onReorderFields}
        />
      ) : null}
    </li>
  )
}

// -------------------------------------------------------------- role grid ---

/**
 * Who sees this section on the visit form, per role (Clinic product). The
 * grid always shows the EFFECTIVE verdict - the shipped defaults until the
 * org changes something - and every checkbox change stores the full
 * materialized {view, edit} pair (src/config/roles). Edit implies View, so
 * ticking Edit ticks View and clearing View clears Edit. "Reset to default"
 * REMOVES the stored override rather than writing today's defaults into it.
 * Admin-gated like every other control here, disabled with the reason.
 */
function RoleGrid({
  section,
  canEdit,
  lockedReason,
  onSetRoles,
  onResetRoles,
}: {
  section: EffectiveSection
  canEdit: boolean
  lockedReason: string
  onSetRoles: (roles: SectionRoles) => void
  onResetRoles: () => void
}) {
  const grid = roleGridFor(section)
  const overridden = section.roles !== undefined
  const lock = lockedReason || undefined
  return (
    <div className="tb-roles">
      <p className="muted small">
        Who sees the {section.title} section on the visit form. Edit includes View; a role with
        neither does not see the section. Administrators always see and edit every section.
        {overridden ? '' : ' These are the built-in defaults.'}
      </p>
      <table className="tb-role-grid">
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">View</th>
            <th scope="col">Edit</th>
          </tr>
        </thead>
        <tbody>
          {ROLES.map((r) => (
            <tr key={r}>
              <th scope="row">{ROLE_LABELS[r]}</th>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${ROLE_LABELS[r]} can view ${section.title}`}
                  checked={grid[r] !== 'hidden'}
                  disabled={!canEdit}
                  title={lock}
                  onChange={(e) =>
                    onSetRoles(materializeRoles(toggleGridCell(grid, r, 'view', e.target.checked)))
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${ROLE_LABELS[r]} can edit ${section.title}`}
                  checked={grid[r] === 'edit'}
                  disabled={!canEdit}
                  title={lock}
                  onChange={(e) =>
                    onSetRoles(materializeRoles(toggleGridCell(grid, r, 'edit', e.target.checked)))
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {overridden ? (
        <button
          type="button"
          className="btn btn-ghost tb-small"
          aria-label={`Reset the roles of ${section.title} to default`}
          disabled={!canEdit}
          title={lock}
          onClick={onResetRoles}
        >
          Reset to default
        </button>
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------- field editor ---

function FieldEditor({
  canEdit,
  lockedReason,
  fields,
  onAdd,
  onUpdate,
  onRemove,
  onReorder,
}: {
  canEdit: boolean
  lockedReason: string
  fields: CustomField[]
  onAdd: (f: Omit<CustomField, 'id'>) => void
  onUpdate: (id: string, patch: Partial<CustomField>) => void
  onRemove: (id: string) => void
  onReorder: (ids: string[]) => void
}) {
  const [label, setLabel] = useState('')
  const [type, setType] = useState<FieldType>('text')
  const lock = lockedReason || undefined

  const move = (id: string, dir: -1 | 1): void => {
    const ids = fields.map((f) => f.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    const next = [...ids]
    next[i] = ids[j] as string
    next[j] = id
    onReorder(next)
  }

  return (
    <div className="tb-field-editor">
      <ul className="tb-field-list">
        {fields.map((f, i) => (
          <FieldRow
            key={f.id}
            field={f}
            canEdit={canEdit}
            lockedReason={lockedReason}
            isFirst={i === 0}
            isLast={i === fields.length - 1}
            onMove={(dir) => move(f.id, dir)}
            onUpdate={onUpdate}
            onRemove={onRemove}
          />
        ))}
      </ul>
      <div className="tb-add-row">
        <input
          type="text"
          aria-label="New question label"
          placeholder="New question"
          value={label}
          disabled={!canEdit}
          title={lock}
          onChange={(e) => setLabel(e.target.value)}
        />
        <select
          aria-label="New question type"
          value={type}
          disabled={!canEdit}
          title={lock}
          onChange={(e) => setType(e.target.value as FieldType)}
        >
          {FIELD_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={!canEdit || !label.trim()}
          title={lock}
          onClick={() => {
            // Selects start with real choices and ranges with a width, so an
            // unanswerable field never enters the schema.
            onAdd({ label: label.trim(), type, ...fieldTypeDefaults(type) })
            setLabel('')
          }}
        >
          Add question
        </button>
      </div>
    </div>
  )
}

/** One question, edited in place. The id is never touched, so answers stay linked. */
function FieldRow({
  field,
  canEdit,
  lockedReason,
  isFirst,
  isLast,
  onMove,
  onUpdate,
  onRemove,
}: {
  field: CustomField
  canEdit: boolean
  lockedReason: string
  isFirst: boolean
  isLast: boolean
  onMove: (dir: -1 | 1) => void
  onUpdate: (id: string, patch: Partial<CustomField>) => void
  onRemove: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState(field.label)
  const [optionsText, setOptionsText] = useState((field.options || []).join('\n'))
  const [optionWarning, setOptionWarning] = useState<string | null>(null)
  const [minText, setMinText] = useState(String(field.min ?? 0))
  const [maxText, setMaxText] = useState(String(field.max ?? 10))
  useEffect(() => setLabel(field.label), [field.label])
  useEffect(() => setOptionsText((field.options || []).join('\n')), [field.options])
  useEffect(() => {
    setMinText(String(field.min ?? 0))
    setMaxText(String(field.max ?? 10))
  }, [field.min, field.max])

  const lock = lockedReason || undefined
  const hasOptions = field.type === 'select' || field.type === 'multiselect'

  return (
    <li className="tb-field-row">
      <div className="tb-field-head">
        <span className="tb-updown">
          <button
            type="button"
            className="btn btn-ghost tb-small"
            aria-label={`Move ${field.label} up`}
            disabled={!canEdit || isFirst}
            title={lock}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn-ghost tb-small"
            aria-label={`Move ${field.label} down`}
            disabled={!canEdit || isLast}
            title={lock}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
        </span>
        <input
          className="tb-name"
          type="text"
          aria-label={`Question label: ${field.label}`}
          value={label}
          disabled={!canEdit}
          title={lock}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            if (label.trim() && label.trim() !== field.label) {
              onUpdate(field.id, { label: label.trim() })
            } else setLabel(field.label)
          }}
        />
        <select
          aria-label={`Question type: ${field.label}`}
          value={field.type}
          disabled={!canEdit}
          title={lock}
          onChange={(e) => {
            const type = e.target.value as FieldType
            const patch: Partial<CustomField> = { type }
            // Switching into a structured type without structure seeds it.
            if ((type === 'select' || type === 'multiselect') && !field.options?.length) {
              Object.assign(patch, fieldTypeDefaults(type))
            }
            if (type === 'range' && field.min === undefined) {
              Object.assign(patch, fieldTypeDefaults(type))
            }
            onUpdate(field.id, patch)
          }}
        >
          {FIELD_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
        <label className="check tb-required" title={lock}>
          <input
            type="checkbox"
            aria-label={`Required: ${field.label}`}
            checked={!!field.required}
            disabled={!canEdit}
            onChange={(e) => onUpdate(field.id, { required: e.target.checked })}
          />
          <span>Required</span>
        </label>
        {hasOptions || field.type === 'range' ? (
          <button
            type="button"
            className="btn btn-ghost tb-small"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Done' : hasOptions ? 'Choices' : 'Scale'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost tb-small tb-danger"
          aria-label={`Remove the ${field.label} question`}
          disabled={!canEdit}
          title={lock}
          onClick={() => {
            if (!canEdit) return
            if (window.confirm(fieldDeleteConfirm(field.label))) onRemove(field.id)
          }}
        >
          Remove
        </button>
      </div>

      <p className="tb-id muted small">
        Field id: <span className="mono">{field.id}</span>. {FIELD_ID_NOTE}
      </p>

      {open && hasOptions ? (
        <div className="tb-field-detail">
          <label className="field">
            <span className="field-label">Choices, one per line</span>
            {/* Local buffer: normalizing on every keystroke ate spaces and
                newlines, making multi-line choice lists impossible to type. */}
            <textarea
              rows={4}
              aria-label={`Choices for ${field.label}, one per line`}
              value={optionsText}
              disabled={!canEdit}
              title={lock}
              onChange={(e) => {
                setOptionsText(e.target.value)
                setOptionWarning(null)
              }}
              onBlur={() => {
                // An empty choices list is REFUSED: nothing is persisted and
                // the previous choices come back. Committing [] renders a
                // label with no control; if the question is also Required it
                // can never be answered and blocks every save org-wide.
                const r = commitOptions(optionsText, field.options || [])
                if (r.refused) {
                  setOptionWarning(r.warning ?? EMPTY_OPTIONS_WARNING)
                  setOptionsText((field.options || []).join('\n'))
                  return
                }
                setOptionWarning(null)
                onUpdate(field.id, { options: r.value })
              }}
            />
            {optionWarning ? (
              <span className="tb-error" role="alert">
                {optionWarning}
              </span>
            ) : null}
          </label>
        </div>
      ) : null}

      {open && field.type === 'range' ? (
        <div className="tb-field-detail tb-range">
          {/* Buffers committed on blur: writing per keystroke made the boxes
              impossible to retype and could persist a zero-width scale. */}
          <label className="field">
            <span className="field-label">Lowest</span>
            <input
              inputMode="numeric"
              aria-label={`Lowest for ${field.label}`}
              value={minText}
              disabled={!canEdit}
              title={lock}
              onChange={(e) => setMinText(e.target.value)}
              onBlur={() => onUpdate(field.id, commitRange(minText, maxText))}
            />
          </label>
          <label className="field">
            <span className="field-label">Highest</span>
            <input
              inputMode="numeric"
              aria-label={`Highest for ${field.label}`}
              value={maxText}
              disabled={!canEdit}
              title={lock}
              onChange={(e) => setMaxText(e.target.value)}
              onBlur={() => onUpdate(field.id, commitRange(minText, maxText))}
            />
          </label>
        </div>
      ) : null}
    </li>
  )
}
