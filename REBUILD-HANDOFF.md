# DH Field EMR - Ground-up rebuild handoff

Written 2026-08-12 for a fresh thread with no prior context. THE LOCAL FOLDER
THIS WAS WRITTEN IN IS BEING DELETED. The canonical copies of this document
are: github.com/DamicoHealth/dh-field-emr (repo root) and the memory vault at
~/Desktop/.devbrain/projects/dh-emr/rebuild-handoff.md. Every reference below
to old code means the GITHUB repo, not a local path - clone it read-only or
browse it on GitHub when you need the reference implementation. Read this
whole document before writing any code. It is the distillation of a multi-week
hardening effort: two adversarial review rounds (60 and 82 agents), 55+ fixed
defects including several data-loss bugs, and a 214-test suite that encodes the
product's contracts. The decision has been made to REBUILD the app, the website
and the demo from scratch. This document is what must survive that rebuild.

---

## 1. What this product is

A free, offline-first electronic medical record for global-health field
medicine. Built and maintained by one person: Alec Damico, an emergency
medicine physician who runs the nonprofit Damico Health.

- Users are nurses, clinical officers and physicians on iPads in field clinics
  in low-resource settings. Excellent clinically, often low software
  familiarity, frequently offline, 40-80 patients a day, sometimes gloved,
  often in direct sun.
- It is NOT a certified EHR and NOT HIPAA-compliant. It is for global-health
  use outside the US. Never claim otherwise anywhere.
- Organizations adopt it because they can make it THEIR clinic's EMR without
  touching code: their drugs, their lab panel, their form, their sites. The
  customization layer is the product's soul (section 6).
- Records belong to the organization, on their own devices and optionally in
  their own Supabase project. Damico Health hosts nothing and sees nothing.

The maintainer constraint shapes everything: every design must be maintainable
by one physician-developer. No ops staff, no QA team, no second engineer.

## 2. The decision, and what is sacred vs disposable

Alec's own organization has pivoted. His 887 production records are exported
and backed up by him personally. The old Supabase project (ref
usgcjcjjahzodjcxdyhq, whose anon key leaked into public git history) is
DISPOSABLE and should be deleted, not migrated. Do not spend effort saving it.

Disposable: both existing codebases as code, the old Supabase project, the
current visual design, the current URL layout.

Sacred (rebuild these behaviors, not necessarily this code):
- The offline-first storage and sync semantics (section 4)
- Every clinical invariant in section 5 - each one exists because its absence
  lost or corrupted data
- The customization model in section 6, config over code
- The safety rules in section 9
- The test-suite-as-spec approach: the parity and invariant tests are the
  closest thing to a written specification this product has

## 3. Where everything lives today

| Thing | Location |
|---|---|
| App repo (public) | github.com/DamicoHealth/dh-field-emr - REFERENCE ONLY, local copy deleted. Clone read-only when needed. |
| Current app (React) | `packages/pwa-react/` - Vite + React 18 + TypeScript strict |
| Legacy app (retired) | `packages/pwa/` - vanilla JS, still the source of the vendored kernel |
| Website repo | github.com/DamicoHealth/damicohealth-com, nested at `packages/damicohealth-com/` and GITIGNORED by the app repo. It is its OWN git repo with its own remote. Editing it and committing the app repo commits nothing on the site. This has bitten twice. |
| Live app | damicohealth.github.io/dh-field-emr/pwa-react/ (all site links point here) |
| Live demo | damicohealth.com/demo/ (the app with a seeded fictional clinic) |
| Guides | damicohealth.com/guides/ (getting-started, user-guide, admin-guide, release-notes) |
| Deploys | GitHub Pages from `main` `/docs` (app) and site repo root (website). Deploy = commit the built output. |
| Supabase schema | `supabase/setup.sql` (canonical, hardened v3.0), `migrate-v3.0.sql`, `rollback-v3.0.sql`, `RUNBOOK-v3.0.md` |
| Tests | `packages/pwa-react/tests/` - 23 files, 214 tests, Vitest + jsdom + fake-indexeddb |
| Device test plan | `packages/pwa-react/DEVICE-TEST.md` - the 8 things only real hardware can prove |
| Memory vault | `~/Desktop/.devbrain` (projects/dh-emr/, global/learnings.md has the transferable gotchas) |

Deps in the current app: react, react-dom, @supabase/supabase-js, recharts
(analytics charts), @dnd-kit/* (form builder drag), vite-plugin-pwa/Workbox.

## 4. The offline-first + cloud-sync architecture

This is the most important section. The rebuild may change the implementation
freely; the SEMANTICS below are the product.

### 4.1 The storage model

Current shape (and its known ceiling, which the rebuild should fix):

- All records live in ONE array under one IndexedDB key (`dhemr_records` in db
  `dh-emr-db`), plus a full JSON mirror of the same array in localStorage as a
  second copy against iOS evicting IndexedDB.
- Every save is a whole-array read-modify-write. Fine at 900 records (~5ms),
  noticeable at 5k, and the localStorage mirror exceeds the ~5MB WebKit quota
  near 2,700 records (~1.9KB JSON per record).
- THE REBUILD SHOULD USE A PER-RECORD IndexedDB OBJECT STORE keyed by record
  id. That removes the ceiling, makes a save O(1), and makes the mirror
  unnecessary or bounded (e.g. mirror only the most recent N records).

Invariants that must survive whatever the storage shape becomes:

1. SINGLE WRITER. Every read-modify-write goes through one mutex. In the
   current app: a per-tab promise mutex PLUS a cross-tab `navigator.locks`
   mutex (`dh-emr-records`) with a BroadcastChannel to invalidate other tabs'
   caches. Without the cross-tab layer, two open tabs silently destroyed each
   other's saves (proven live: 5/5 records lost without it, 12/12 kept with
   it). Sync runs INSIDE the same lock.
2. WIPE GUARD. If the existing records could not be READ, saving is blocked
   with a loud message. "Unreadable" must never be treated as "empty", or the
   first save after a read failure overwrites the whole store.
3. RECOVERY NEVER TRUSTS A STALE COPY. The current kernel writes a
   `records_mirror_stale` flag and a `records_meta` sidecar {count, newest, at}
   on every save. On an empty IndexedDB read, the mirror is adopted ONLY if
   not flagged stale and not short of the sidecar count; otherwise the app
   blocks saving, tells the human both counts, offers restoring a backup file
   FIRST, and only then a deliberate confirmed adoption of the older copy.
   Before this guard, an eviction at 6,000 records silently restored a
   months-old 2,700-record clinic.
4. LOUD SAVE FAILURES. If persistence fails everywhere, saveRecord THROWS and
   the UI says "Your entry was NOT saved". Never a silent success.
5. STORAGE NAMESPACING. `window.DH_STORAGE_SUFFIX` (set at build time)
   suffixes both the localStorage prefix (`dhemr{suffix}_`) and the IndexedDB
   database name (`dh-emr-db{suffix}`). IndexedDB is ORIGIN-scoped, not
   path-scoped: production, staging, preview and demo on one GitHub Pages
   origin WILL share a patient database unless namespaced. This was a live
   incident. Production gets the bare prefix; everything else gets a suffix
   (`-demo`, `-next`, `-react`).
6. CRASH DRAFTS. The encounter form persists a draft to sessionStorage as the
   clinician types (iOS discards background tabs). A draft is scoped to the
   exact form it was typed in (editingId AND seedFromId both match), starts
   the form DIRTY on recovery (or the first Cancel deletes it), and is cleared
   on save and on explicit confirmed discard. sessionStorage on purpose:
   survives reload/discard, does not survive a full close, is per-tab.

### 4.2 The sync engine

Optional sync to the ORG'S OWN Supabase project. Semantics:

- Three tables: `records` (one row per visit, snake_case columns, JSONB for
  labs/urinalysis/medications/diagnosis_codes/custom_fields), `devices`
  (id/name/role/last_sync_at/revoked_at), `config` (key/JSONB value).
- Versioning per record: `sync_version` increments on every local edit;
  `synced_version` records what the cloud has. pending = sync_version >
  synced_version. Push stamps synced_version only if the record was not edited
  again mid-flight (recheck under the lock after the network round trip).
- Order per cycle: pullConfig, pushRecords, pullRecords, pullDeviceRole.
  Pull-before-push on records. Pull uses keyset pagination over
  (synced_at, id); `synced_at` is set by a server trigger because field device
  clocks are unreliable.
- Merge on pull is conflict-aware (`mergeRecords`): a local unsynced edit is
  kept and pushed next cycle; otherwise newer savedAt wins. Deletes are SOFT
  (deleted:true tombstones that sync); nothing hard-deletes, RLS forbids
  DELETE outright.
- Push is an upsert (`resolution=merge-duplicates`). This makes same-record
  concurrent edits last-writer-wins at the server; the client compensates with
  a stale-edit guard (section 5). A future realtime rebuild should replace
  this with real per-field or per-version conflict handling.
- Supabase Realtime is a TRIGGER ONLY: a change notification kicks off the
  full hardened sync cycle. Realtime payloads are never applied directly to
  the store. The tables must be added to the `supabase_realtime` publication
  (setup.sql does this) or devices show "Live" and receive nothing.
- Config push is dirty-key: only keys changed since this device's last push
  are re-pushed, or two admins overwrite each other every 2 minutes.
- Honest reporting: after a manual sync, the app re-reads the unsynced count
  as ground truth. "Sync finished" with records still pending is a lie that
  teaches clinicians to ignore the one alarm that matters. Conversely a pull
  failure after a complete push is NOT "not backed up".

### 4.3 Devices, identity and security

- Every device self-registers with a crypto.randomUUID id, a human name, and
  a role (`standard` | `admin`). Only admin devices can edit org config. The
  CLOUD role is authoritative: pullDeviceRole overwrites local.
- Registration is deliberately open (a new iPad in the field must be able to
  join with just URL + key). Hardening (all in setup.sql, tested against real
  Postgres via PGlite with a mutation control):
  - `devices.revoked_at` kill switch: a revoked device cannot write records,
    cannot un-revoke itself. Only the SQL editor clears it.
  - First-admin-wins: the first device on a virgin project may register as
    admin (self-service setup); after that, promotion is SQL-editor-only,
    enforced by a `dh_enforce_device_rules` trigger (NOT security definer -
    inside SECURITY DEFINER, current_user is the owner and the bypass check
    would never fire).
  - Device ids are immutable; records policies require the device to exist
    and not be revoked, with explicit WITH CHECK.
- THE HONEST LIMIT: all devices share one client key, so Postgres cannot tell
  devices apart and anyone with the key can READ everything. Only per-device
  credentials (Supabase Auth or similar) fix that. The rebuild's realtime
  phase is the right time to add it. Until then, never imply row-level privacy.
- Key handling: support BOTH the legacy `anon` JWT and the newer
  `sb_publishable_...` keys. A publishable key is NOT a JWT and must not be
  sent as `Authorization: Bearer` (PostgREST rejects it); send `apikey` only.
  This matters for incident response: a leaked legacy anon key can only be
  rotated by rotating the JWT secret (killing service_role too); a publishable
  key is deleted individually. Reject `service_role` and `sb_secret_` keys in
  every key-entry UI - they bypass all RLS and must never be on a device.
- First-run setup is mandatory and gated on a `setupComplete` flag ALONE (not
  "flag or device id" - a leftover id bypassed it). Flow: cloud (URL + key,
  VERIFIED against the live tables before acceptance) or offline-only as a
  first-class equal choice; device name; role; then sites and clinicians for
  EVERY device (a brand-new cloud project's config table is empty, so skipping
  this filed every record under the placeholder "Site A" / "Physician A").
- Renaming a device must NOT re-register it (that mints a new UUID and orphans
  the fleet row). Connecting an existing device to a NEW project must
  re-register it there (RLS rejects writes from unknown devices).
- Backup/restore/import invariants: restore re-stamps `deviceId` to the
  restoring device (or nothing it restores can ever upload) and bumps
  sync_version so everything re-uploads; a local tombstone always beats an
  older live copy from a backup (the kernel's delete does not advance savedAt,
  so savedAt comparison alone RESURRECTS deletions); config restore is opt-in
  and separate from records (silently restoring old config onto an admin
  device reverted the whole org's form); the cloud-rows importer
  (`src/lib/importCloud.ts`) accepts a raw Supabase JSON export, converts via
  the same `supabaseRowToRecord` the sync engine uses (never a second
  implementation), rejects rows without ids rather than inventing them, and
  requires the device to be set up first.

## 5. Clinical invariants - the real spec

Each of these was a shipped bug. The rebuild inherits them as requirements.
The current tests encode most of them; port the tests, not just the code.

- MRN / patient number. Generated, never typed: first two letters of given +
  family name + DDMMYYYY of birth. The ASCII strip runs FIRST on the original
  string (so every historical MRN is byte-stable - including odd ones like
  "Ólafur" keying LA because the accent strips); a Unicode fallback (NFD, then
  any-script letters) runs ONLY when the original rule yields nothing, which
  is what lets Amharic/Arabic/Cyrillic/Thai names be filed at all. Same base
  MRN + same full name = same patient (visits group); same base + different
  name gets a B..Z suffix. `tests/mrnParity.test.ts` differential-tests 1,024
  name pairs against the legacy implementation read off disk. Keep that
  pattern for ANY algorithm two implementations share.
  KNOWN GAP: suffix assignment is device-local, so two offline iPads can mint
  the same MRN for different patients and their charts fuse after sync.
  Detection UI (not auto re-suffix - the number may be on paper) is unbuilt.
  A server-authoritative MRN service is the realtime-era fix.
- Dispensing quantity. `calcMedQty(medId, dose, freq, duration)`: countable
  units are tabs/caps/sachet only; dose parses as "N tabs" or mg/g/mcg (NO
  word boundary after the unit - "1 gram" must parse; a stray \b halved
  counts); tablet strength comes from the drug NAME or its `dose` field
  (config-defined formularies keep strength separately); unreadable dose =
  legacy math (assume 1/dose) but FLAGGED on screen as assumed. Frequencies:
  once/q24h=1, q12h=2, q8h=3, q6h=4, qhs=1, prn and bid-topical = no count.
  The quantity previews live on the prescription line as it is entered.
  `tests/medQtyParity.test.ts` covers 448 prescription shapes.
- Dates. An encounter date is a LOCAL calendar date (`todayLocal()`), never
  `toISOString()` (UTC shifted evening clinics to tomorrow).
- The encounter form. Every user-driven state write goes through ONE wrapper
  that marks the form dirty (twelve direct writers once bypassed the discard
  guard); the backdrop is not a close target (gloved-hand brush discarded
  encounters on landscape iPads); Escape routes through the discard confirm;
  Save & next detaches from the edited record BEFORE the next patient (or the
  next patient overwrites the previous record); validation errors scroll
  instantly (not smooth - 3000px of animation reads as "nothing happened") to
  a field that actually carries data-invalid, custom fields included; the
  saved confirmation names the patient; sex=M clears pregnancy fields only on
  user action, never on mount.
- Concurrent edits. Before saving an edit, re-read the stored record INCLUDING
  tombstones: if savedAt moved, warn naming which device; if deleted, warn
  that saving resurrects it fleet-wide.
- New visit vs edit. Edit overwrites the visit being viewed; "+ New visit"
  carries identity + standing history (allergies, PMH, current meds) into a
  NEW record and never becomes an edit target. Both must exist; before they
  did, clinicians overwrote last month's visit to record today's.
- Rendering resilience. Error boundary per tab plus a root backstop; one
  malformed record must degrade to a recoverable message ("your records are
  still on this device", never "clear site data"), not a white screen.
- Accessibility floor. 4.5:1 contrast on all text (the brand orange #f68630
  fails on white at 2.51:1 - a darker filled token #b5560a exists for
  text-bearing surfaces), 44px targets, 16px inputs (iOS zoom), visible focus
  ring (3:1+), aria-modal dialogs with focus trap and focus return, body
  scroll locked behind modals via a COUNTED lock (overlapping panels with
  snapshot-restore locked the app offscreen permanently).
- Terminology. The UI says "visit" and "patient number", one term everywhere.

## 6. Customization - the product's soul (be exhaustive here)

The pitch is: an organization makes this THEIR EMR by data, not by forking
code. Two layers, both syncing org-wide through the config table.

### 6.1 The form template library

Stored under config key `formTemplates` as
`{ version, templates: [{ id, name, enabled, schema: { sections } }] }`,
with `formSchema` mirroring the first template for the legacy app.

- MULTIPLE TEMPLATES per org (e.g. "General Encounter", "Dental Clinic").
  The encounter form shows a selector when more than one is enabled; each
  record stores the templateId/templateName it was filed under, forever.
- 16 BUILT-IN sections in canonical order: encounter, patient, vitals,
  accessToCare, history, chiefConcern, labs, diagnosis, rxPresets,
  medications, procedures, referral, physician, imaging, surgery, notes.
  Stored schema entries for built-ins are sparse OVERRIDES {id, title?,
  hidden?, order?}. encounter and patient are required and cannot be hidden.
  Three (accessToCare, rxPresets, physician) had no rendered body in the
  React app and were excluded from the builder rather than offered as
  arrangeable no-ops - in a rebuild, implement or omit, never list dead ones.
- Admins can REORDER (drag or keyboard), HIDE/SHOW, and RENAME any
  non-required section, per template.
- CUSTOM SECTIONS: add unlimited sections, each with custom fields. Field
  types: text, textarea, select (single choice), multiselect, number,
  range (min..max scale), yesno, date. Fields have {id, label, type,
  options?, required?, min?, max?, placeholder?}.
- Field IDs are IMMUTABLE once created: answers are stored on records as
  `customFields[fieldId]`, so editing a label/type in place keeps old answers
  linked, and deleting a field/section KEEPS saved answers on existing
  records (they simply stop appearing on the form). Every delete confirm
  says exactly that.
- Rules learned the hard way: a required select with an EMPTY options list is
  unanswerable and blocks every save org-wide - the builder must refuse to
  persist an empty options list AND validation must skip optionless selects;
  new sections insert at the END, not mid-form; collapsed-by-default is only
  allowed for sections without required fields; a "synthesized" library (org
  config not yet synced to this device) must be read-only or saving replaces
  the org's real form with a fabricated empty one - but the DEMO must seed a
  real library or the whole builder is dead on the page meant to show it off.
- Editing is admin-device-only. Controls are DISABLED with the reason on the
  control, never enabled-but-silently-ignored (an admin once confirmed
  "Delete Vitals and its 3 questions?" and nothing happened, no message).
- Legacy had template CRUD (create/duplicate/rename/enable/delete). The
  React builder edits existing templates only. The rebuild should restore
  full template CRUD.

### 6.2 The clinic lists

Editable under Form setup > "Medications, labs and lists" (admin only), each
stored under its own config key:

- FORMULARY (`formulary`): array of {id, name, dose (strength, e.g. "500mg"),
  unit (tabs/caps/sachet/ml/vial/ampoule/tube/drops), category, controlled?}.
  Drives the prescription drug dropdown, dose auto-fill on selection (only
  when the dose box is empty, so deliberate non-standard doses survive), and
  the dispensing-quantity math (section 5). Entry IDs are permanent:
  prescriptions store medId, so reassigning an id silently repoints every
  prescription ever written against it. Removing a drug keeps existing
  prescriptions intact and only stops offering it.
- LAB TESTS (`customLabTests`): array of {id, name, type: 'toggle'|'numeric',
  unit?, enabledByDefault?, ranges?}. Toggle records POS/NEG; numeric records
  a value + unit and, via ranges [{label, min?, max?, color}], an
  INTERPRETATION that is snapshotted onto the record AT ENTRY TIME (editing
  ranges later never rewrites recorded results - the record keeps its own
  copy). When empty, the app falls back to its built-in panel (Malaria RDT,
  HIV, Syphilis, Hep B, H. pylori, COVID, TB, HCG, Blood Glucose, Hemoglobin
  etc.); adding any test replaces the built-ins with the org's list. A
  reference-range EDITOR is not yet built in React (legacy had it) - ranges
  currently come from defaults or hand-written config.
- SITES (`sites`) and PROVIDERS (`providers`): plain string lists feeding the
  required Site select and the Provider select. One per line; commas belong
  INSIDE entries ("Grace N., clinical officer" is one person - a comma split
  once turned her into two providers). An empty list must be refused: it
  blocks every save. Collected at first-run setup for every device.
- PRESENTING COMPLAINTS (`complaints`): the tap-to-add pills under Chief
  concern. Pills APPEND to free text (tap again removes that one).
- PROCEDURES (`procedures`) and REFERRAL DESTINATIONS (`referralTypes`):
  string lists feeding their sections.
- DX PRESETS (`customDxPresets`) and RX PRESETS (`rxPresets`): quick-pick
  diagnosis strings and one-tap prescription bundles (an Rx preset carries
  med lines: drug+dose+freq+duration). Legacy had full editors and one-tap
  apply; the React app READS the keys but has no editor and no Rx-preset
  apply UI. The rebuild should restore both - they are the biggest speed
  lever for a 60-patient day.
- HIDDEN PRESETS (`hiddenPresets`): per-category lists of built-in preset
  names an admin suppressed, so removed defaults stay removed after sync.

### 6.3 How customization syncs

`CONFIG_PUSH_KEYS = [sites, providers, formulary, rxPresets, procedures,
referralTypes, customDxPresets, complaints, customLabTests, hiddenPresets,
formSchema, formTemplates]`. Admin devices push dirty keys only; every device
pulls on each sync cycle and the encounter form re-reads. An offline-only org
edits the same lists locally; they simply never leave the device. UI copy
everywhere says: these belong to your organization, a change reaches everyone
on the next sync. NEVER sync the admin password or any credential through
config (the config table is readable by every key holder).

## 7. The demo (the public try-it surface)

The demo at damicohealth.com/demo is the app built with `DH_DEMO=1` and
`DH_STORAGE_SUFFIX=-demo`. Its seeder once wiped a real deployment by
enumerating and deleting `dhemr_*` keys; the safety rules are therefore law:

1. Refuses to run unless the build set DH_DEMO.
2. Always namespaced storage (own IndexedDB db, own key prefix).
3. NEVER enumerates-and-deletes storage keys.
4. Forces standalone mode; null cloud credentials; can never sync.
5. Fictional patients only.

Also learned: the demo must seed EVERYTHING interactive - patients chosen to
show capability (a 3-visit returning patient with a vitals trend, malaria+,
antenatal, paediatric, a referral, a penicillin allergy respected in
prescribing, an Amharic name), an admin device, sites/providers, AND a real
form library with two templates and custom sections (or the form builder is
disabled by the synthesized-library guard and the flagship feature looks
dead). The demo service worker AUTO-updates (skipWaiting+clientsClaim);
returning visitors must never evaluate a stale build. The clinical app's
service worker stays USER-GATED ("Update now") so an update can never reload
mid-encounter. Seeding is idempotent per SEED_VERSION with a Reset Demo
button, and uses stable hashes, no Math.random.

## 8. Website and guides

- Site: damicohealth.com (its own repo, remember). Every "Launch the App"
  link (12 of them: home, guides hub, all guide pages, privacy, terms,
  reference doc) must point at ONE canonical app URL. Consider `/app/`
  instead of an implementation-detail path in the rebuild.
- Guides: getting-started, user-guide, admin-guide, release-notes. The
  methodology that worked: write against a UI inventory quoted literally from
  the rendering code, then FACT-CHECK every named button/tab/label/message by
  grepping the source - a guide naming a button that does not exist is worse
  than no guide. Keep one noun per concept (visit, patient number). Plain
  language, ESL-friendly, no marketing voice. State "not a certified EHR, not
  HIPAA-compliant" on every guide.
- Release notes are written for clinicians ("Dispensing quantities could be
  too low"), never changelog-speak. An unannounced release sits untaken
  because updates are user-gated.
- The old reference PDF/md is retired in place with a notice; do not resurrect.

## 9. Non-negotiable working rules

- NO EM DASHES anywhere: code, UI, docs, commits, SQL. Regular hyphens.
- NO PHI ever enters git or any transcript. `exports/` is gitignored - never
  open it. Tripwire before every commit:
  `git grep -lE '256561427488|Longfield'` must be empty. Claude never runs
  queries that return patient rows; counts and schema only.
- anon/publishable keys only on devices; service_role and sb_secret are
  refused by the UI and never typed anywhere client-side.
- Customization goes through config, not code, whenever possible.
- Every fix ships with a test that FAILS when the fix is removed (verify by
  deleting the guard once). Shared algorithms get differential tests against
  the other implementation read off disk.
- Real-browser verification before "done": drive the shipped artifact, not
  the dev server, with real clicks (dispatch focusout not blur; expand
  collapsed sections before reading them - both produced false alarms).
- Update the Dev Brain vault (`/save`) at the end of significant sessions;
  update HANDOFF.md "Current state" in-repo.

## 10. The road to a realtime connected EMR

The stated future. Sequence it so offline never stops being primary - field
clinics lose connectivity daily and the app must be indistinguishable offline.

1. NOW (rebuild core): per-record IndexedDB store; keep every section 4/5
   invariant; port the parity tests first and build until they pass.
2. Identity: per-device credentials via Supabase Auth (device = user),
   replacing shared-key trust; RLS becomes real ("this device wrote this");
   keep open enrollment via an org join-code flow so field onboarding stays
   self-service. The v3.0 kill switch and role trigger carry forward.
3. Server-authoritative allocation: MRN suffix assignment and duplicate
   detection move server-side (closes the two-offline-iPads collision);
   devices get provisional numbers offline that reconcile on sync.
4. True realtime: per-record subscriptions applying INCREMENTAL, versioned
   changes (today realtime only triggers a full sync cycle); presence ("iPad
   2 is editing this visit") to prevent rather than detect conflicting edits;
   CRDT or field-level merge instead of last-writer-wins upsert.
5. Clinical layer (panel-ranked backlog): allergy-vs-prescription checking
   (pure function over the existing comma-joined allergy string + a
   drug-class table Alec authors; block same-class only), red-flag vitals
   banners (derived, not stored; thresholds are Alec's), weight plausibility
   + require weight for paediatric prescribing, ICD-10 coded diagnosis (the
   legacy icd10.js list exists), printable referral slips and visit summaries
   (window.print + @media print, no PDF lib), a follow-up register (referral
   status setter exists in legacy, unported), pharmacy consumption totals
   (honest about non-countable units).
6. Explicitly rejected for a solo maintainer (panel-vetted, do not revisit
   without new facts): client-side audit trail with its own outbox (use a
   Postgres trigger), wound photos (PHI on unencrypted evictable storage),
   idle PIN lock, AirDrop delta sync, subtherapeutic-dose warnings (the
   parser cannot support them honestly).

## 11. Starting the new thread

The old local folder no longer exists. The old code lives ONLY on GitHub.

### 11.0 FIRST: interview Alec before proposing anything

Do not open with an architecture proposal. Open by asking the questions below,
one short message, grouped. These are decisions only Alec can make, and every
one of them changes what gets built. Get answers, restate the plan in a few
sentences, get a yes, THEN start on structure and tests.

1. SCOPE OF THE FIRST RELEASE. Full parity with everything in sections 5-6
   before anything ships, or a leaner first cut? If leaner, which of these
   wait: Rx/Dx presets, lab reference-range editor, template CRUD, analytics?
2. STACK. Keep React + Vite + TypeScript (the tests and patterns port almost
   directly - recommended) or switch? If switch, to what and why?
3. NAME AND BRANDING. Still "DH Field EMR"? Same logo/orange? The old visual
   design is disposable - fresh look or evolution?
4. THE DAMICO HEALTH PIVOT. What is the organization's new direction, and
   does it change who this product is for or how the website tells its story?
5. REPO LAYOUT. One monorepo for app + site + demo (recommended - the old
   nested-gitignored-site-repo split caused two silent-non-deploy incidents)
   or separate repos again? New repo name?
6. URLS. Canonical app URL (suggest /app/ on damicohealth.com or a dedicated
   subdomain), and does the old GitHub Pages URL need a redirect for anyone
   who bookmarked it?
7. SUPABASE. Stand up the new project now (Alec runs setup.sql in the
   dashboard) or build offline-only first and add the cloud later?
8. ALEC'S 887 RECORDS. Import them into the new app as his working data once
   it is trustworthy, keep them as a test corpus only, or leave them archived?
9. REALTIME TIMELINE. Is phase 2 (per-device auth) wanted in this build, or
   is this build phase 1 only with auth designed-for but deferred?
10. HARDWARE. Which iPads (or other devices) should the DEVICE-TEST pass
    target before anything ships to the download link?

1. Create the new folder and repo; give it a CLAUDE.md that imports the vault
   (`~/Desktop/.devbrain/projects/<new-slug>/active.md`) per the global setup;
   add the slug to the vault table.
2. Read this document, then fetch the executable spec from the old repo:
   `git clone --depth 1 https://github.com/DamicoHealth/dh-field-emr /tmp/dh-ref`
   and read `/tmp/dh-ref/packages/pwa-react/tests/` (mrnParity, medQtyParity,
   mirrorGuard, backup, importCloud, draft, clinicLists, invariants are the
   load-bearing ones). Copy the tests and `supabase/setup.sql` into the new
   repo; they are the spec, not legacy baggage.
3. Decide the storage schema (per-record store) and port the parity tests
   FIRST. Build until green.
4. Alec's 887-record export imports via the importCloud pattern: same
   row-to-record converter as sync, restore-path rules (deviceId re-stamp,
   tombstone protection, sync_version bump).
5. New Supabase project from `supabase/setup.sql` (already hardened);
   delete the old project once the new app imports his data.
6. Nothing ships to the download link before the DEVICE-TEST.md pass on a
   physical iPad. The demo ships freely (namespaced, auto-updating).

Suggested opening prompt for the new thread:

> Read ~/Desktop/.devbrain/projects/dh-emr/rebuild-handoff.md (also at the
> root of github.com/DamicoHealth/dh-field-emr). We are rebuilding DH Field
> EMR from scratch in this new folder: app, website and demo. The old local
> folder is gone; the old repo on GitHub is reference only. Offline-first
> with optional Supabase sync is the core; the customization layer (form
> templates, formulary, labs, clinic lists) is the product's soul; the
> invariants in sections 4-6 are requirements, not suggestions. Start with
> the interview in section 11.0 - ask me those questions and wait for my
> answers before proposing anything. Then propose the repo structure and the
> per-record storage schema, and port the parity tests before writing app
> code.
