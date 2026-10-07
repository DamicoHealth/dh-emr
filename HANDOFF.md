# DH EMR - current state

Updated 2026-10-06.

## PRODUCT PIVOT (2026-10-06): TWO SEPARATE PRODUCTS over ONE SHARED CORE

Alec's decision after the first live two-device E2E. No mode switching,
no data merging between products.

- DH EMR CLINIC (packages/clinic): live, constant internet, staff
  accounts with roles Reception / Triage / Provider / Lab / Pharmacy /
  Admin, each with its own landing workspace; realtime board; join
  links + QR onboarding (no typed keys). Always the auth gate.
- DH EMR FIELD (packages/field): offline paper-chart entry, no accounts
  (device identity), standalone OR shared-key cloud sync. Also the backup
  app a Clinic org uses when its backend is down (offline -> online data
  import is TABLED; MRN matching is the eventual path).
- packages/core: kernel, domain, config, sync, auth, UI kit, the whole
  test suite. Apps import via the @dh/core/* path alias. Nothing copied.
- Website: two products, separate guide sets, demo hub with a Field demo
  (simple) and a Clinic demo (local simulation with a role-switcher side
  panel).

## Core extraction: DONE (2026-10-06) - 472 tests green in packages/core

- packages/core/src now holds everything shared: types, kernel, domain,
  config, sync, auth, lib, sw, ui, styles (moved with mv, nothing copied).
  packages/core/tests holds the whole suite (31 files, 471 tests plus one
  Clinic wizard case added by the Clinic shell work = 472) plus
  tests/setup.ts and tests/fixtures/legacy. TypeScript strict clean.
- Apps reach core through the path alias "@dh/core/*" -> "../core/src/*"
  (tsconfig "paths" + vite resolve.alias; packages/field is the worked
  example, which typechecks, tests and production-builds through it).
- core's vite.config.ts carries ONLY the vitest block and the two defines
  (__DH_STORAGE_SUFFIX__ '', __DH_DEMO__ false). No PWA plugin: the
  shells own vite-plugin-pwa, the manifest and the build defines.
- Root scripts: test / typecheck -> core; typecheck:all, dev:field,
  dev:clinic, build:field, build:clinic, build:demos point at the
  @dh/field and @dh/clinic workspaces.
- Still in core and shell-relevant: src/auth (sessions, profile state
  machine, orgMode.ts) and staffApi.switchOrgMode (the vetted config
  upsert) stay in core; the Clinic shell calls switchOrgMode automatically
  on the first admin sign-in. The Settings screen's Organization card (the
  only mode-switch UI) is GONE for both products. The Clinic shell gates
  unconditionally, the Field shell never gates.

## Field shell: DONE (2026-10-06) - packages/field, 30 shell tests green

- packages/field (@dh/field) is DH EMR Field: src/App.tsx (tabs Visits /
  New visit / Analytics / Settings; setupComplete-only boot gate; storage
  health banners; adopt-older-copy; multi-tab warning; sync chip), src/
  main.tsx (demo boot branch, device identity, sync engine init - no auth
  session priming, Field has no accounts), src/demo (the Field demo
  seeder, moved verbatim), index.html, public/ (PWA icons), vite.config.ts
  (PWA prompt/autoUpdate by DH_DEMO, @dh/core alias, vitest block with
  setupFiles ../core/tests/setup.ts). Manifest/title say "DH EMR Field".
- Scripts: build (tsc + vite build -> dist), build:demo (DH_DEMO=1,
  DH_STORAGE_SUFFIX=-demo, --base=/demo/field/ -> ../site/public/demo/
  field), preview, test. The Clinic demo must use a DIFFERENT storage
  suffix: both demos live on one origin.
- Tests: tests/demoMode.test.ts (29) and tests/appBootGate.test.ts (1),
  run with the shared harness through the alias. Core 471 + Field 30 =
  the pre-split 501, same assertions.
- core SettingsScreen gained a REQUIRED `product: 'field' | 'clinic'`
  prop (no default, so neither shell can forget). 'field' never renders
  the Account card and labels About "DH EMR Field"; 'clinic' renders the
  Account card when an account is passed and labels "DH EMR Clinic". The
  Organization (mode switch) card was then removed for BOTH products by
  the Clinic shell work: no mode switching UI exists anywhere. Everything
  else on the screen is unchanged.
- packages/app (the transitional husk) is deleted. The husk's post-
  extraction App.tsx (with the clinic gate: evaluateGate = hasCloud AND
  orgMode == 'clinic', tabsFor with Board/Staff, ensureFleetRow on
  activation) is the starting point for the Clinic shell; a copy was
  stashed in the session scratchpad (husk-app/) and the pre-split
  snapshot tgz holds the pre-alias version.
- .claude/launch.json: field-preview (4173), field-preview-device2
  (4174), clinic-preview (4175, @dh/clinic), site-preview (4180).
- Known leftover for the Field Settings screen (NOT changed, structural
  phase): the "Patient flow stations (clinic mode board)" list editor
  still renders in Field although Field has no board. Decide in the
  Clinic phase whether it moves behind product === 'clinic'.
- Stale build output: packages/site/public/demo/ (gitignored) still holds
  the pre-split demo at /demo/; the Field demo now lands at /demo/field/.
  The website redo (CLINIC-PLAN phase 3) repoints the demo hub.

## Clinic shell: DONE, phase 1 (2026-10-06) - packages/clinic, 8 shell tests green

- packages/clinic (@dh/clinic) is DH EMR Clinic: src/App.tsx (ALWAYS the
  account gate once credentials exist - evaluateGate is hasCloud() then
  loadCurrentProfile, NO orgMode check; tabs Board / Visits / New visit /
  Analytics / Staff (admin) / Settings product="clinic"; Board is the
  default tab; storage health banners, adopt-older-copy, multi-tab
  warning, sync chip, ensureFleetRow on activation), src/main.tsx (demo
  boot branch, device identity, auth session priming, sync engine init),
  src/clinicOrgMode.ts, src/demo (stub, see below), index.html and
  manifest "DH EMR Clinic", public/ icons, vite.config.ts.
- First-run: setupComplete ALONE decides, then a set-up device with no
  credentials lands on the wizard too (gate kind 'noCloud'). The shared
  SetupWizard gained a REQUIRED `product: 'field' | 'clinic'` prop:
  'clinic' opens on the cloud step with no "Use this device on its own"
  and no Back. (Internal wizard step 'clinic' was renamed 'lists'.)
  FIELD AGENT: packages/field/src/App.tsx line ~236 must now pass
  product="field" to SetupWizard or the field typecheck fails (left alone
  on purpose: the Clinic agent does not touch packages/field).
- Automatic org mode: on the first ACTIVE ADMIN sign-in,
  ensureClinicOrgMode writes orgMode=clinic through staffApi.switchOrgMode
  when the local mirror does not already say clinic; silent on refusal or
  offline (logged, retried on the next gate evaluation). SETUP.md step 6
  now says so; the SQL stays as the manual fallback.
- STORAGE NAMESPACE: Clinic production builds default DH_STORAGE_SUFFIX
  to '-clinic' (dhemr-clinic_ / dh-emr-db-clinic / dhemr-clinic_auth) so a
  device with both products installed never shares a database; Field keeps
  the bare prefix. Verified in the built bundle. Demo build: '-clinic-demo'.
- Scripts: dev, build (tsc + vite build -> dist), build:demo (DH_DEMO=1,
  --base=/demo/clinic/ -> ../site/public/demo/clinic), preview, test,
  typecheck. Tests: tests/appBootGate.test.ts (3: leftover id does not
  bypass, no-creds lands on cloud step, creds + no session = sign-in with
  no orgMode row) and tests/clinicOrgMode.test.ts (5).
- src/demo is a STUB until CLINIC-PLAN phase 3: bootDemo refuses outside
  DH_DEMO builds and installs a cloud guard (connect/verify/seedConfig
  refused, credential writes no-ops); DemoBanner says fictional and "still
  being built". The demo build therefore opens on the cloud step and can
  go nowhere - correct for now, and nobody can run a real clinic on the
  demo URL. The guard duplicates packages/field/src/demo/cloudGuard.ts;
  hoist into core when the Clinic demo is built.
- Not in phase 1 (CLINIC-PLAN phase 2): join links + QR, realtime/auto-sync
  (both landed since, see their own sections), role workspaces (below).
  Clinic lists / formulary / template gating in Settings is still by DEVICE
  role, as before.

## Role workspaces: DONE (2026-10-06) - core 609 tests, clinic 31

What makes Clinic an EMR rather than a shared form. Roles are FIXED:
reception, triage, provider, lab, pharmacy, plus the admin flag
(users_profiles.role + is_admin). 'nurse' (the pre-split name) resolves to
triage; any other unknown role resolves to provider (the full form; a
stranded account is worse than a wide one). STATION_ROLES in staffApi is
now this list.

- Role visibility model: core/src/config/roles.ts (PURE). Per section:
  'edit' | 'view' | 'hidden' for a role; admins edit everything. Defaults
  ship in DEFAULT_ROLE_ACCESS: reception -> encounter + patient edit, all
  else view; triage -> vitals/history/chiefConcern/labs edit + patient
  view; provider -> all; lab -> labs edit + patient/chiefConcern view;
  pharmacy -> medications edit + patient/diagnosis view. An org overrides
  per section with a sparse `roles: { view, edit }` on the stored section
  (RawSection.roles; ids immutable, same saveLibrary path, formSchema
  mirror still written); a partial override falls back per key; edit
  implies view. Builder: every section row has a "Roles" button opening a
  View/Edit grid per role (defaults shown, "Roles changed" chip when
  overridden, "Reset to default" REMOVES the override), admin-gated like
  the rest. Ops: setSectionRoles / clearSectionRoles in config/sections.
- Visit form: EncounterForm takes optional `role` + `isAdmin` (absent = the
  full form, so Field is untouched). Role mode renders the resolver's
  sections: hidden omitted, view-only inside a disabled <fieldset> with a
  "View only" chip (natively inert; assert with el.matches(':disabled'),
  NOT el.disabled). Saving goes through the SAME buildRecord/merge path:
  only EDIT sections' custom fields are active (mergeCustomFields keeps
  the rest), and preserveUnrenderedSections (core/src/ui/encounter/
  roleSections.ts) copies every unedited built-in section back from the
  FRESHEST stored copy, so a pharmacy save never blanks the vitals and
  keeps vitals triage wrote on another device while the form was open
  (the stale-edit confirm still fires). Validation problems are scoped to
  the role's editable sections. NEW-visit rules: the required sections
  (Visit, Patient) are editable for every role and view-only sections are
  omitted, so reception's registration is the short intake form.
- Lab orders: in role mode every lab tile gets an "Ordered" checkbox that
  stores { ordered: true, result: '' } (toggle) / { ordered: true, value:
  '' } (numeric) - the "ordered, no result yet" state the Lab queue reads.
  Field never shows the control, so it never produces a pending order.
- Dispensing: Medication.dispensed?: { qty, by, at } INSIDE the medications
  JSONB (no schema change), written through records.update by the
  Pharmacy screen (sync_version bumps, syncs like any edit), preserved
  verbatim by buildRecord on every resave, undoable.
- Screens: core/src/ui/lab/LabScreen.tsx (today's visits with a pending
  lab, "Enter results" opens the visit in lab role mode; "resulted today"
  list), core/src/ui/pharmacy/PharmacyScreen.tsx (today's visits with an
  undispensed line; per-line Qty prefilled from the computed quantity,
  "Dispensed", "dispensed today" list with Undo, "Open visit" in pharmacy
  role mode). Pure selection in labModel.ts / pharmacyModel.ts. Board:
  homeStationFor (boardRole.ts) - reception = first station, others by
  name; the home column is highlighted and scrolled into view once per
  mount; Check in is the primary button for reception; every card has an
  "Open" button that opens the visit in the role's view; New patient from
  the board is role mode too.
- Clinic shell tabs (tabsFor, exported from App.tsx with landingFor): the
  role's workspace first (Board for reception/triage/provider/admin, Lab
  for lab, Pharmacy for pharmacy), Visits, New visit (reception, provider,
  admins - the roles that register), Analytics (provider, admins), Staff
  (admins), Settings. A non-admin lab or pharmacy account has NO Board tab
  (per plan); an admin always gets the Board, right after the workspace of
  their own role. The landing tab is the workspace; a role change or
  demotion falls back to it.
- Tests: core/tests/roles.test.ts (42: resolver defaults + overrides +
  persistence, form helpers, role-mode form RTL incl. the two vitals
  cases, lab/pharmacy models + screens RTL, board home column RTL,
  builder role grid RTL), clinic/tests/roleWorkspaces.test.ts (10: tab
  sets per role pure + rendered landings with the real Lab/Pharmacy
  screens). staff.test.ts updated for the five roles.
- HONEST LIMIT (for the guides): roles are a workflow layer, not a security
  wall. Any approved account can read the org's records; the server cannot
  enforce field-level permissions.
- NEEDS THE LIVE TEST (no backend here): the role landing and the Pharmacy
  screen in the built artifact behind a real sign-in, and a two-device
  pharmacy-vs-triage concurrent save. Verified in the browser: the built
  artifact boots and its bundle carries every new screen's copy.

## Live E2E (2026-10-06) against Alec's real Supabase project

Field mode fully verified two-device: wizard cloud path with real table
verification, first-admin-wins, deliberate admin claim demoted by the
live trigger + adopted on pull, push with honest reporting, cross-device
pull, admin-only dirty-key config push (exactly 2 keys), cross-device
edit, tombstone propagation, gated Update now. verify.sql: 25/25 PASS.
Two sync bugs caught and fixed with regression tests (see the commit
"Fix two sync bugs caught by the first live two-device E2E" - PENDING:
git is blocked by the Xcode license until Alec runs
`sudo xcodebuild -license accept`). Pre-split snapshot of the tree is in
the session scratchpad (pre-split-snapshot.tgz).

## Core: BUILT AND GREEN

- 18 test files, 166 tests, all passing; TypeScript strict clean.
- src/domain: MRN + dispensing math, byte-compatible with legacy, proven
  by differential parity suites (tests/fixtures/legacy is scraped by
  regex - NEVER reformat those files).
- src/kernel: per-record IndexedDB store (DB v2, in-place migration from
  the old blob), bounded 500-record mirror with the v3 recovery decision
  table verbatim, single-writer locks, wipe guard, loud failures.
  Integrators: call setCurrentDeviceId(id) after device registration;
  resetStorage() in tests, never deleteDatabase.
- src/config: template library model, builder guards, vendored default
  catalogs (formulary, labs, presets, ICD-10).
- src/sync: engine with injectable transport (createSyncEngine), honest
  reporting, key classification (classifySupabaseKey - every key-entry UI
  must use it); src/lib: backup, importCloud, csv, patients grouping.

## Where things stand

- Ground-up rebuild started. Monorepo scaffolded; reference contracts being
  extracted from the old repo (github.com/DamicoHealth/dh-field-emr).
- Decisions locked: name is DH EMR; one app with two org-level modes
  (clinic = connected, roles, flow board; field = offline-first, device
  identity); one monorepo for app + site + demo; React + Vite + TS strict;
  new Supabase project stands up early with per-user auth for clinic mode.
- Device targets: modern iPads, older iPads, iPhones, desktop browsers.
  Responsive is first-class everywhere.
- The old 887 production records are dead; nothing imports them.
- Old Supabase project is disposable and should be deleted by Alec.

## Open with Alec

- Damico Health pivot story and audience (needed before website work).
- Canonical app URL: damicohealth.com/app/ proposed, no objection yet.

## Supabase v4.1 (supabase/)

- setup.sql: v3.0 hardening carried forward + two-mode layer. Field mode =
  anon policies gated on orgMode (absent = field, so v3 orgs upgrade in
  place). Clinic mode = per-user auth via users_profiles.
- KEY DESIGN DECISION (from a 20-finding adversarial review): signup NEVER
  grants anything; every profile starts pending; the FIRST admin is minted
  by one SQL-editor line (SETUP.md section 4). There is no auto-admin
  path because the publishable key is shared by design and Supabase
  signups default open - any signup-time grant is claimable by strangers.
- Helper functions (dh_org_mode, dh_active_profile, dh_is_admin) are
  SECURITY DEFINER on purpose: they are called from policies on the very
  tables they read; as invoker Postgres aborts with policy recursion. The
  RULES triggers stay SECURITY INVOKER (the current_user bypass needs it).
- Authenticated access deliberately works in BOTH modes so an org drains
  its field fleet before flipping; admin flip-back to field via the app is
  the documented recovery path for stranded records.
- verify.sql: 25-check PASS/FAIL suite (attacks as anon + authenticated,
  rolls back). rollback-v4-to-v3.sql restores v3 behavior.
- NOT yet re-reviewed after the fix round; PGlite-based SQL tests are
  planned for the clinic-mode build phase.

## UI: BUILT, VERIFIED IN A REAL BROWSER

- 23 test files, 223 tests green; production build clean; walked the BUILT
  artifact (vite preview) end to end: setup wizard with empty-list
  refusal, backdrop non-close, Escape discard confirm (instrumented,
  message verified), live patient-number generation (AMNA12041990 case),
  save + reload persistence, pediatric stats, phone layout with bottom
  tab bar.
- Shell: data-driven tabs (Visits / New visit / Settings; clinic Board tab
  adds one entry + one case), storage health banners, adopt-older-copy
  flow, multi-tab warning, honest sync chip.
- Encounter form: every scar-tissue rule from the reference contract.
  IMPORTANT SEAM: the form owns its dialog chrome (backdrop, focus trap,
  Escape-through-discard); never wrap it in another dialog. onSaved
  receives (saved, andNext): plain Save closes, Save & next stays open.

## Deferred consciously (next build cycles)

- Template builder UI (drag/drop editor; library read-only in Settings),
  Rx/Dx preset editors + one-tap apply, lab reference-range editor,
  Analytics screen, service worker / vite-plugin-pwa wiring (user-gated
  updates for the clinical app, auto for demo), PGlite SQL tests.

## Demo + site: BUILT, LAWS VERIFIED LIVE (2026-08-13)

- src/demo: seeder gated on DH_DEMO, deterministic (djb2 ids, no
  Math.random/Date.now), SEED_VERSION idempotent, Reset Demo. All five
  safety laws verified in the BUILT artifact: namespaced storage
  (dh-emr-db-demo / dhemr-demo_ keys), foreign localStorage keys survive
  reset, cloud guard refuses every connect path in-UI, fictional-only
  banner with full disclaimer. Demo code grep-proven out of the clinical
  bundle. build:demo emits into packages/site/public/demo (gitignored;
  regenerate at deploy).
- packages/site: static, zero deps, tokens matched to the app. Preview:
  node packages/site/serve.mjs (or the site-preview launch config). Hero
  copy structured for the pivot-story swap (HTML comment marks it).
- Settings prompt() flows replaced with inline forms; About carries the
  full not-certified/not-HIPAA statement.

## Clinic mode: BUILT (2026-08-13, commit d0a7c76) - 362 tests green

- src/auth: namespaced sessions, profile state machine with offline grace
  (cached ACTIVE profile under settings key 'authProfile'; revocation
  enforced server-side on reconnect - documented honest limit). Access
  token rides every sync request via the provider hook in src/sync/keys.ts.
- Shell gate applies ONLY when orgMode == 'clinic' AND cloud creds exist;
  field mode is byte-identical (browser-verified). Tabs: Board (active
  profile), Staff (admin), via tabsFor() in App.tsx.
- src/domain/flow.ts + src/ui/board: today-scoped columns, unknown
  stations route to offBoard (never vanish), moves via records.update so
  sync_version bumps. src/ui/staff: approve/revoke/role/promote, orgMode
  switch (direct authed config upsert - orgMode is deliberately NOT in
  CONFIG_PUSH_KEYS), stations editor.
- Kernel stamps user_id on NEW records from setCurrentUserId (published
  by loadCurrentProfile, active accounts only); ensureFleetRow() runs
  once per activation from the App gate effect.
- NOT yet done: live E2E against a real Supabase project (needs one to
  exist; the SQL itself is covered by verify.sql), PGlite SQL tests,
  supabase-js bundle split (main chunk 528 kB, warning only).

## Customization editors: BUILT (commit 23a4dd4) - 445 tests green

- src/ui/templates: full template CRUD with every section-6 guard;
  synthesized-library detection lives in loadLibraryDetailed (raw-read
  marker, BEFORE normalizeLibrary fabricates a default). Browser-verified
  enabled in the demo (both seeded templates + custom sections render).
- src/ui/presets + EncounterForm surgical edits: Dx pills + Rx one-tap
  apply (append-only by design; legacy toggle-off could yank manual rows).
  hiddenPresets materializes from defaultHiddenPresets(), never {}.
- src/ui/labs/RangeEditor: ranges persist against a FRESH config read;
  existing interpretation snapshots never rewritten (pinned by test).
- collapsed-by-default now flows type -> sections -> validate -> form.
- saveLibrary mirrors the first ENABLED template to formSchema.

## Analytics + service workers: BUILT (commit d736000) - 498 tests green

- src/lib/analytics.ts single-pass, metric definitions pinned by tests;
  src/ui/analytics with refreshSignal convention; Analytics tab in BOTH
  modes after the Visits pair.
- SW: vite-plugin-pwa, registerType prompt (clinical) / autoUpdate
  (demo); registration via src/sw/register.ts started by UpdateBar;
  clinical reload happens ONLY through Update now; demo skipWaiting+
  clientsClaim baked in. Verified in the built sw.js of both bundles.

## Guides: WRITTEN AND FACT-CHECKED (commit 25e15f9)

- packages/site/public/guides/: getting-started, user-guide, admin-guide
  + hub. ~240 quoted UI strings verified verbatim against src; the
  inventory that fed the writers is regenerable (the methodology, not
  the artifact, is what matters). Section default renamed Surgery.

## EVERYTHING BUILDABLE WITHOUT ALEC IS NOW BUILT.

## Next (each needs Alec)

1. Live clinic-mode E2E: Alec creates a Supabase project per
   supabase/SETUP.md (a scratch one is fine), then drive both modes
   against real Postgres.
2. Deploy: GitHub repo + Pages + damicohealth.com DNS
   (packages/site/DEPLOY.md). Hero copy awaits the pivot story.
3. Device tests on real hardware (DEVICE-TEST checklist to be written
   from the old repo's when hardware is scheduled).

## Nice-to-have backlog (no blocker)

- supabase-js bundle split (594 kB warning, cosmetic), PGlite SQL tests,
  Capacitor/native wrapper if ever wanted.

## Clinic Phase 2 DONE (2026-10-06, uncommitted)

Realtime trigger + 20 s auto-sync (core/src/sync/realtime.ts, engine
startAutoSync), join links + QR (core/src/sync/joinLink.ts, core/src/lib/qr.ts,
Staff InviteCard; clinic boot consumes #join=), six role workspaces (config
SectionRoles + template Roles grid, role-mode EncounterForm, LabScreen,
PharmacyScreen with Medication.dispensed, tabsFor per role). 670 tests
(core 609, clinic 31, field 30); typecheck:all clean. Live E2E of the
channel + join links still needs Alec's staff account.

## Clinic demo DONE (2026-10-06, uncommitted)

packages/clinic/src/demo: local simulation, no backend ever. Seeded clinic
day (15 visits across the default stations), six-seat simulated roster,
"You are simulating" side panel (bottom sheet on phones), scripted
colleague activity every 25-40 s with toasts, Act now / Pause activity /
Reset demo, DemoStaffScreen over a local roster. Five safety laws pinned
by tests/clinicDemo.test.ts (50). build:demo -> site/public/demo/clinic;
build:local bundle has zero demo markers. 723 tests total.

## Clinic polish DONE (2026-10-06, uncommitted) - 754 tests, all green

Clinic Settings now gate on the ACCOUNT (CLINIC_GATE_REASON: "Only an
administrator account can change this. Ask your clinic's admin."), and the
sync engine got setConfigPushPolicy so an admin account on a link-joined
(standard) device actually pushes config (default = old device-role gate,
Field unchanged). Make admin confirm no longer mentions a mode switch;
roles display via ROLE_LABELS; Visits -> Edit opens the role view in
Clinic; wizard/auth screens brand DH EMR Clinic; DEFAULT_FLOW_STATIONS
now Check-in, Triage, Provider, Lab, Pharmacy, Done (demo seed + activity
follow). Lab "On by default": explicit true shows (even if hidden by
name), explicit false hides, absent follows hide-by-name
(tests/labVisibility.test.ts). Restore confirm wording is product-aware.
roles.test.ts flake fixed (waitFor on onRefresh). Docs re-swept and
fact-checked; SETUP.md stale spots fixed; demo hub marks both demos live;
.gitignore now keeps public/demo/index.html tracked and ignores only
demo/field and demo/clinic. Totals: core 636, clinic 88, field 30.

## Clinic guides WRITTEN (2026-10-06)

/guides/clinic/: setup, user guide (per role), admin guide, hub. The
inventory pass surfaced real product defects now being fixed by the
clinic-polish workflow: Clinic Settings gated on DEVICE role instead of
the account admin flag (link-joined admins got read-only Settings); stale
Make admin confirm mentioning a mode switch; Visits -> Edit ignored the
role; lowercase raw roles in Staff/Account; wizard/auth screens branded
plain DH EMR; no Lab default station. Docs re-swept and re-fact-checked
after the fixes; SETUP.md stale spots corrected.

## Settings leftovers FIXED (2026-10-06)

flowStations editor hidden for product=field; visibleLabTests drops tests
with enabledByDefault === false (tests/labVisibility.test.ts).

## Previously noted leftovers (now fixed, kept for history)

- SettingsScreen still renders the "Patient flow stations (clinic mode
  board)" list editor for product='field'; hide it for Field.
- The Lab tests table's "On by default" checkbox is a dead control: the
  stored enabledByDefault is read only by defaultHiddenPresets() over the
  built-in list, nothing on the visit form honors it for org tests. Either
  wire it (hide the test on the form unless enabled) or remove the column.
  Deferred so as not to collide with the Phase 2 agents editing core.
