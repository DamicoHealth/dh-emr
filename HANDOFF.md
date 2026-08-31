# DH EMR - current state

Updated 2026-08-12 (end of day).

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

## Next

1. Live clinic-mode E2E once a Supabase project exists (Alec runs
   SETUP.md; a scratch project is fine).
2. Deploy step with Alec: GitHub repo + Pages + damicohealth.com DNS
   (see packages/site/DEPLOY.md), then guides written against the real
   UI. Needs the Damico Health pivot story for the hero copy.
3. Remaining: analytics screen, service worker wiring (user-gated app /
   auto demo), supabase-js bundle split (575 kB warning), device tests
   on real hardware, PGlite SQL tests.
