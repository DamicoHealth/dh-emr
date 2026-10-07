/**
 * Simulated colleagues for the Clinic demo: the board visibly moves while
 * the visitor watches, because "other staff" keep working.
 *
 * The activity is a SCRIPT, not a random walk: a fixed sequence of
 * plausible actions (an arrival checked in, a patient advanced one station,
 * vitals completed, lab results entered, a prescription dispensed, a visit
 * concluded) that a demo-wide cursor walks through one action at a time.
 * Every action is written through the SAME kernel paths the real screens
 * use - records.update for moves, results and dispensing (so sync_version
 * bumps exactly as it would in a real clinic), records.save for arrivals -
 * and attributed to the simulated colleague who did it.
 *
 * Resilient to the visitor: a scripted action that no longer applies
 * (the visitor already moved that patient, or dispensed that line) is
 * skipped, so the script never undoes or contradicts what the visitor did.
 * The cursor lives in the kernel settings KV under one known key and is
 * reset to 0 by the seeder, so a Reset demo replays the day from the top;
 * nothing here reads the clock for identity (ids come from the seed's
 * stable hashes) and the between-action delay is a stable hash of the
 * cursor, so the demo behaves the same for every visitor.
 */
import { config, records, settings } from '@dh/core/kernel'
import { getConfig } from '@dh/core/config/keys'
import { movePatch, resolveStations } from '@dh/core/domain/flow'
import { todayLocal } from '@dh/core/domain/today'
import type { DiagnosisCode, LabEntry, Medication, PatientRecord } from '@dh/core/types/record'
import { displayName } from '@dh/core/types/record'
import { pendingLabs } from '@dh/core/ui/lab/labModel'
import { dispensePatch, suggestedQty, undispensedLines } from '@dh/core/ui/pharmacy/pharmacyModel'
import { demoMemberFor, shortName, type DemoRoleId } from './gate'
import {
  DEMO_ACTIVITY_CURSOR_KEY,
  DEMO_ACTIVITY_PAUSED_KEY,
  demoVisitId,
  djb2,
  med,
  numericLab,
  pendingNumeric,
  rec,
  treatmentText,
  type VisitSeed,
} from './seed'

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type SimulatedKind = 'arrive' | 'move' | 'vitals' | 'labs' | 'dispense' | 'conclude'

/** One thing a colleague just did, for the toast. */
export interface SimulatedAction {
  kind: SimulatedKind
  /** The colleague's seat on the panel. */
  actor: DemoRoleId
  /** "Grace N." */
  actorName: string
  /** The whole sentence: "Grace N. moved Daniel K. to Provider". */
  text: string
}

export interface SimulateOptions {
  /** The action moment; defaults to the clock. Injectable for tests. */
  now?: Date
  /** The clinic day (YYYY-MM-DD); defaults to todayLocal(now). */
  today?: string
}

/** Between-action delay for the step at `cursor`: 25 to 40 s, stable per cursor. */
export function stepDelayMs(cursor: number): number {
  return 25_000 + (djb2('demo-tick-' + cursor) % 15_001)
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

interface Who {
  given: string
  family: string
}

type Step =
  | { kind: 'arrive'; actor: DemoRoleId; patient: Omit<VisitSeed, 'date'> }
  | { kind: 'move'; actor: DemoRoleId; who: Who; to: string }
  | {
      kind: 'vitals'
      actor: DemoRoleId
      who: Who
      vitals: Partial<Pick<PatientRecord, 'temp' | 'bp' | 'weight' | 'pregnant' | 'breastfeeding'>>
    }
  | { kind: 'labs'; actor: DemoRoleId; who: Who; results: Record<string, LabEntry> }
  | { kind: 'dispense'; actor: DemoRoleId; who: Who; countedQty?: number }
  | {
      kind: 'conclude'
      actor: DemoRoleId
      who: Who
      diagnosis: string
      codes?: DiagnosisCode[]
      meds: Medication[]
      procedures?: string[]
      treatmentNotes?: string
      /** Tests the provider orders while concluding (ordered, no result yet). */
      labs?: Record<string, LabEntry>
    }

/**
 * Where a provider sends a concluded visit. Results come back before
 * dispensing: a visit with an ordered, unresulted test goes to the Lab
 * column (when the board has one), otherwise straight to Pharmacy. The lab
 * then sends it on to Pharmacy once the last result is in.
 */
const LAB = 'Lab'
const PHARMACY = 'Pharmacy'

const who = (given: string, family: string): Who => ({ given, family })

const AMHARIC = who('አማራ', 'ንጉሤ')
const JOSEPH = who('Joseph', 'Okello')
const FLORENCE = who('Florence', 'Namukasa')
const DANIEL = who('Daniel', 'Kirya')
const ESTHER = who('Esther', 'Nabirye')
const GRACE = who('Grace', 'Auma')
const AMARA = who('Amara', 'Nakato')
const PETER = who('Peter', 'Ssemakula')
const SAMUEL = who('Samuel', 'Ochieng')
const MIRIAM = who('Miriam', 'Adeke')
const SARAH = who('Sarah', 'Akello')
const ROSE = who('Rose', 'Atuhaire')
const ISAAC = who('Isaac', 'Wandera')
const BETTY = who('Betty', 'Nambi')
const MOSES = who('Moses', 'Kato')

const B54: DiagnosisCode = { code: 'B54', term: 'Malaria, unspecified' }

const toggle = (result: 'POS' | 'NEG'): LabEntry => ({ ordered: true, type: 'toggle', result })

/** Fictional walk-ins the reception colleague checks in during the demo. */
const ARRIVALS: Record<string, Omit<VisitSeed, 'date'>> = {
  rose: { givenName: ROSE.given, familyName: ROSE.family, dob: '1999-03-03', sex: 'F' },
  isaac: { givenName: ISAAC.given, familyName: ISAAC.family, dob: '1985-10-10', sex: 'M' },
  betty: { givenName: BETTY.given, familyName: BETTY.family, dob: '2020-09-14', sex: 'F' },
  moses: { givenName: MOSES.given, familyName: MOSES.family, dob: '1975-04-30', sex: 'M' },
}

/**
 * The day, in order. Station names are the shipped defaults the seeder
 * configures (Check-in, Triage, Provider, Lab, Pharmacy, Done); a step
 * naming a station the org renamed simply does not apply and is skipped.
 * A concluded visit goes to Lab when it has tests waiting on results and
 * to Pharmacy otherwise; the lab's results step moves a visit waiting at
 * Lab on to Pharmacy.
 */
export const SCRIPT: readonly Step[] = [
  { kind: 'vitals', actor: 'triage', who: DANIEL, vitals: { bp: '142/88', weight: '74' } },
  { kind: 'move', actor: 'reception', who: JOSEPH, to: 'Triage' },
  {
    kind: 'labs',
    actor: 'lab',
    who: PETER,
    results: { 'Malaria RDT': toggle('POS'), 'Typhoid (Widal/RDT)': toggle('NEG') },
  },
  { kind: 'dispense', actor: 'pharmacy', who: SAMUEL },
  { kind: 'move', actor: 'triage', who: DANIEL, to: 'Provider' },
  { kind: 'arrive', actor: 'reception', patient: ARRIVALS.rose as Omit<VisitSeed, 'date'> },
  {
    kind: 'conclude',
    actor: 'provider',
    who: GRACE,
    diagnosis: 'Normal antenatal visit',
    meds: [med('grace-today', 'vit-prenatal', '1 tab', 'q24h', 'Ongoing')],
  },
  { kind: 'move', actor: 'pharmacy', who: SAMUEL, to: 'Done' },
  {
    kind: 'labs',
    actor: 'lab',
    who: AMARA,
    results: { 'Malaria RDT': toggle('NEG'), Hemoglobin: numericLab('hemoglobin', '11.2') },
  },
  { kind: 'vitals', actor: 'triage', who: ESTHER, vitals: { weight: '48' } },
  { kind: 'move', actor: 'triage', who: ESTHER, to: 'Provider' },
  { kind: 'dispense', actor: 'pharmacy', who: MIRIAM },
  {
    kind: 'conclude',
    actor: 'provider',
    who: PETER,
    diagnosis: 'Malaria',
    codes: [B54],
    meds: [
      med('peter-today-1', 'am-artefan', '4 tabs', 'q12h', '3d'),
      med('peter-today-2', 'an-para500', '1g', 'q8h', '3d'),
    ],
  },
  { kind: 'move', actor: 'reception', who: AMHARIC, to: 'Triage' },
  { kind: 'arrive', actor: 'reception', patient: ARRIVALS.isaac as Omit<VisitSeed, 'date'> },
  { kind: 'dispense', actor: 'pharmacy', who: SARAH },
  { kind: 'move', actor: 'pharmacy', who: MIRIAM, to: 'Done' },
  { kind: 'vitals', actor: 'triage', who: JOSEPH, vitals: { temp: '36.8', bp: '158/96', weight: '81' } },
  { kind: 'move', actor: 'triage', who: JOSEPH, to: 'Provider' },
  {
    kind: 'conclude',
    actor: 'provider',
    who: AMARA,
    diagnosis: 'Viral illness',
    meds: [med('amara-today', 'an-para500', '1g', 'q8h', '3d')],
    treatmentNotes: 'Malaria test negative. Fluids and rest; return if the fever lasts beyond 3 days.',
  },
  { kind: 'move', actor: 'reception', who: FLORENCE, to: 'Triage' },
  { kind: 'dispense', actor: 'pharmacy', who: GRACE, countedQty: 30 },
  { kind: 'move', actor: 'pharmacy', who: SARAH, to: 'Done' },
  { kind: 'arrive', actor: 'reception', patient: ARRIVALS.betty as Omit<VisitSeed, 'date'> },
  // The diabetic review: the provider orders a glucose while concluding, so
  // the visit goes to Lab (results before dispensing) and the lab sends it
  // on to Pharmacy once the value is in.
  {
    kind: 'conclude',
    actor: 'provider',
    who: DANIEL,
    diagnosis: 'Diabetes',
    meds: [med('daniel-today', 'Metformin 500mg', '500mg', 'q12h', 'Ongoing')],
    treatmentNotes: 'Continue metformin. Diet reviewed. Glucose today before dispensing.',
    labs: { 'Blood Glucose': pendingNumeric('blood_glucose') },
  },
  { kind: 'move', actor: 'pharmacy', who: GRACE, to: 'Done' },
  { kind: 'arrive', actor: 'reception', patient: ARRIVALS.moses as Omit<VisitSeed, 'date'> },
  {
    kind: 'conclude',
    actor: 'provider',
    who: ESTHER,
    diagnosis: 'Laceration, left forearm',
    meds: [med('esther-today', 'an-para500', '500mg', 'q8h', '3d')],
    procedures: ['Wound Closure/Sutures'],
    treatmentNotes: 'Wound cleaned and closed with 4 sutures. Remove in 7 days.',
  },
  { kind: 'labs', actor: 'lab', who: DANIEL, results: { 'Blood Glucose': numericLab('blood_glucose', '168') } },
  { kind: 'dispense', actor: 'pharmacy', who: PETER },
  { kind: 'move', actor: 'pharmacy', who: PETER, to: 'Done' },
  {
    kind: 'conclude',
    actor: 'provider',
    who: JOSEPH,
    diagnosis: 'Hypertension',
    meds: [med('joseph-today', 'Amlodipine 5mg', '5mg', 'q24h', 'Ongoing')],
  },
  { kind: 'dispense', actor: 'pharmacy', who: DANIEL, countedQty: 60 },
  { kind: 'move', actor: 'pharmacy', who: DANIEL, to: 'Done' },
  { kind: 'move', actor: 'triage', who: AMHARIC, to: 'Provider' },
]

// ---------------------------------------------------------------------------
// Running one step
// ---------------------------------------------------------------------------

interface StepContext {
  now: Date
  today: string
  stations: string[]
}

function patientShort(r: Pick<PatientRecord, 'givenName' | 'familyName' | 'name'>): string {
  return shortName(displayName(r))
}

function actorName(id: DemoRoleId): string {
  return shortName(demoMemberFor(id).profile.displayName)
}

function action(kind: SimulatedKind, actor: DemoRoleId, text: string): SimulatedAction {
  return { kind, actor, actorName: actorName(actor), text }
}

/** Today's live visit for a scripted patient, or null. */
async function findVisit(w: Who, ctx: StepContext): Promise<PatientRecord | null> {
  const id = demoVisitId(w.given, w.family, ctx.today)
  const all = await records.getActive()
  const r = all.find((x) => x.id === id)
  return r && r.date === ctx.today ? r : null
}

async function runStep(step: Step, ctx: StepContext): Promise<SimulatedAction | null> {
  const nowIso = ctx.now.toISOString()
  const by = demoMemberFor(step.actor).profile.displayName

  switch (step.kind) {
    case 'arrive': {
      const id = demoVisitId(step.patient.givenName, step.patient.familyName, ctx.today)
      const all = await records.getActive()
      if (all.some((r) => r.id === id)) return null
      const first = ctx.stations[0]
      if (!first) return null
      const row = rec(
        { ...step.patient, date: ctx.today, author: step.actor, station: first, stationMin: 0, arrivedMin: 0 },
        { today: ctx.today, now: ctx.now },
      )
      // A brand-new visit, filed the way the registration form files one:
      // records.save stamps savedAt and the version counters itself and
      // keeps the author already on the row (the reception colleague).
      await records.save(row)
      return action('arrive', step.actor, `${actorName(step.actor)} checked in ${patientShort(row)}`)
    }

    case 'move': {
      const r = await findVisit(step.who, ctx)
      if (!r) return null
      const from = r.flow_station ? ctx.stations.indexOf(r.flow_station) : -1
      const to = ctx.stations.indexOf(step.to)
      // Only ever forward: never drag a patient the visitor advanced back.
      if (to < 0 || from >= to) return null
      const patch = movePatch(step.to, ctx.stations, nowIso)
      if (!patch) return null
      const ok = await records.update(r.id, (x) => ({ ...x, ...patch }))
      if (!ok) return null
      return action('move', step.actor, `${actorName(step.actor)} moved ${patientShort(r)} to ${step.to}`)
    }

    case 'vitals': {
      const r = await findVisit(step.who, ctx)
      if (!r) return null
      const missing = Object.entries(step.vitals).filter(([k]) => !r[k as keyof typeof step.vitals])
      if (missing.length === 0) return null
      const ok = await records.update(r.id, (x) => {
        const next = { ...x }
        for (const [k, v] of missing) {
          ;(next as unknown as Record<string, unknown>)[k] = v
        }
        return next
      })
      if (!ok) return null
      return action('vitals', step.actor, `${actorName(step.actor)} entered vitals for ${patientShort(r)}`)
    }

    case 'labs': {
      const r = await findVisit(step.who, ctx)
      if (!r) return null
      const pending = new Set(pendingLabs(r))
      const fill = Object.entries(step.results).filter(([name]) => pending.has(name))
      if (fill.length === 0) return null
      const labs = { ...(r.labs || {}), ...Object.fromEntries(fill) }
      // The last result is in and the patient is waiting at Lab: on to
      // Pharmacy, the way the lab advances a visit from the board. Anywhere
      // else (the provider kept the patient, or the visitor already moved
      // them) only the results land; forward only, like every move here.
      const from = ctx.stations.indexOf(LAB)
      const to = ctx.stations.indexOf(PHARMACY)
      const patch =
        pendingLabs({ labs }).length === 0 && r.flow_station === LAB && to >= 0 && from < to
          ? movePatch(PHARMACY, ctx.stations, nowIso)
          : null
      // The visit form keeps a top-level copy of a glucose result beside
      // the lab entry (legacy mirror); match it so the chart reads the same.
      const glucose = fill.find(([name]) => name === 'Blood Glucose')?.[1]
      const ok = await records.update(r.id, (x) => ({
        ...x,
        labs: { ...(x.labs || {}), ...Object.fromEntries(fill) },
        bloodGlucose:
          glucose && glucose.type === 'numeric' ? String(glucose.value ?? '') : x.bloodGlucose,
        ...(patch ?? {}),
      }))
      if (!ok) return null
      return action(
        'labs',
        step.actor,
        patch
          ? `${actorName(step.actor)} entered lab results for ${patientShort(r)} and sent them to ${PHARMACY}`
          : `${actorName(step.actor)} entered lab results for ${patientShort(r)}`,
      )
    }

    case 'dispense': {
      const r = await findVisit(step.who, ctx)
      if (!r) return null
      const lines = undispensedLines(r)
      if (lines.length === 0) return null
      const ok = await records.update(r.id, (x) => {
        let next = x
        for (const line of undispensedLines(x)) {
          const qty = suggestedQty(line) ?? step.countedQty ?? null
          next = dispensePatch(next, line.id, { qty, by, at: nowIso })
        }
        return next
      })
      if (!ok) return null
      const n = lines.length
      return action(
        'dispense',
        step.actor,
        `${actorName(step.actor)} dispensed ${n} prescription${n === 1 ? '' : 's'} for ${patientShort(r)}`,
      )
    }

    case 'conclude': {
      const r = await findVisit(step.who, ctx)
      if (!r || r.diagnosis) return null
      // Orders placed while concluding join the visit's labs; a test that is
      // already on the chart (the visitor ordered or resulted it) is kept.
      const labs = { ...(r.labs || {}) }
      for (const [name, entry] of Object.entries(step.labs ?? {})) {
        if (!labs[name]) labs[name] = entry
      }
      // Results before dispensing: waiting on a test means the Lab column
      // (when the board has one), otherwise straight to Pharmacy.
      const target = pendingLabs({ labs }).length > 0 && ctx.stations.includes(LAB) ? LAB : PHARMACY
      const from = r.flow_station ? ctx.stations.indexOf(r.flow_station) : -1
      const to = ctx.stations.indexOf(target)
      const patch = to >= 0 && from < to ? movePatch(target, ctx.stations, nowIso) : null
      const notes = step.treatmentNotes ?? ''
      const ok = await records.update(r.id, (x) => ({
        ...x,
        labs,
        diagnosis: step.diagnosis,
        diagnosisCodes: step.codes ?? [],
        medications: step.meds.map((m) => ({ ...m })),
        procedures: step.procedures ?? x.procedures,
        treatmentNotes: notes,
        treatment: treatmentText(step.meds, notes),
        ...(patch ?? {}),
      }))
      if (!ok) return null
      return action(
        'conclude',
        step.actor,
        patch
          ? `${actorName(step.actor)} finished the visit for ${patientShort(r)} and sent them to ${target}`
          : `${actorName(step.actor)} finished the visit for ${patientShort(r)}`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

export async function activityCursor(): Promise<number> {
  const v = await settings.get<number>(DEMO_ACTIVITY_CURSOR_KEY)
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

/** True once the script has been walked to its end (until the next reset). */
export async function activityFinished(): Promise<boolean> {
  return (await activityCursor()) >= SCRIPT.length
}

/**
 * Perform the next applicable scripted action, exactly one, and advance
 * the cursor past it (skipped steps are consumed too, so the sequence never
 * replays them). Returns null when the script is finished.
 */
export async function simulateStep(opts: SimulateOptions = {}): Promise<SimulatedAction | null> {
  const now = opts.now ?? new Date()
  const today = opts.today ?? todayLocal(now)
  const stations = resolveStations(await getConfig(config, 'flowStations'))
  const ctx: StepContext = { now, today, stations }
  let cursor = await activityCursor()
  while (cursor < SCRIPT.length) {
    const step = SCRIPT[cursor] as Step
    cursor++
    const done = await runStep(step, ctx)
    await settings.set(DEMO_ACTIVITY_CURSOR_KEY, cursor)
    if (done) return done
  }
  return null
}

// ---------------------------------------------------------------------------
// Pause state: in memory for the UI, mirrored to one known settings key so a
// reload keeps a paused demo paused.
// ---------------------------------------------------------------------------

let paused = false
const pauseListeners = new Set<(p: boolean) => void>()

export function isActivityPaused(): boolean {
  return paused
}

export async function loadActivityPaused(): Promise<boolean> {
  paused = (await settings.get<boolean>(DEMO_ACTIVITY_PAUSED_KEY)) === true
  return paused
}

export async function setActivityPaused(p: boolean): Promise<void> {
  paused = p
  pauseListeners.forEach((cb) => {
    try {
      cb(p)
    } catch {
      /* ignore */
    }
  })
  await settings.set(DEMO_ACTIVITY_PAUSED_KEY, p)
}

export function onActivityPaused(cb: (p: boolean) => void): () => void {
  pauseListeners.add(cb)
  return () => {
    pauseListeners.delete(cb)
  }
}
