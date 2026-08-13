# DH EMR - repo instructions

Free, offline-first EMR for global-health clinics, built and maintained by one
physician (Alec Damico, Damico Health). One app, two org-level modes:

- Field mode: offline-first, device identity, sync whenever there is signal.
- Clinic mode: per-user auth with roles, realtime sync, patient-flow board.

NOT a certified EHR, NOT HIPAA-compliant. Never claim otherwise anywhere.

## The spec

REBUILD-HANDOFF.md at the repo root. Sections 4 (storage/sync semantics),
5 (clinical invariants) and 6 (customization model) are requirements, not
suggestions. Every invariant there exists because its absence lost or
corrupted data in production. Read it before changing kernel, sync, or
config code. HANDOFF.md tracks current state; update it when state changes.

## Layout

- packages/app - the PWA (Vite + React 18 + TypeScript strict + Vitest)
  - src/domain - pure clinical algorithms (MRN, med quantities, dates)
  - src/kernel - storage engine (per-record IndexedDB, mutex, recovery)
  - src/config - org customization model (templates, formulary, lists)
  - src/sync - cloud sync engine (Supabase)
  - tests/ - the executable spec; parity tests differential-test against
    vendored legacy fixtures in tests/fixtures/legacy/
- packages/site - damicohealth.com (website + guides + demo hosting)
- supabase/ - canonical SQL schema; Alec runs it in the dashboard

Old implementation (reference only): github.com/DamicoHealth/dh-field-emr

## Non-negotiable working rules

- NO EM DASHES anywhere: code, UI text, docs, commits, SQL. Regular hyphens.
- NO PHI ever enters git or any transcript. exports/ is gitignored - never
  open it. Tripwire before every commit (excludes the two docs that quote
  the pattern itself):
  `git grep -lE --cached '256561427488|Longfield' -- ':!CLAUDE.md' ':!REBUILD-HANDOFF.md'`
  must print nothing.
- anon/publishable Supabase keys only on devices. service_role and
  sb_secret_ keys are refused by every key-entry UI and never typed
  anywhere client-side.
- Customization goes through config, not code, whenever possible.
- Every bug fix ships with a test that fails when the fix is removed.
  Shared algorithms get differential tests against the legacy fixtures.
- MRN and dispensing-quantity outputs must stay byte-stable with the legacy
  implementation. The parity tests enforce this; never weaken them.
- Real-browser verification before calling UI work done: drive the built
  artifact, not just the dev server.
- The UI says "visit" and "patient number", one term everywhere.

## Commands

- `npm test` - full suite (Vitest, jsdom, fake-indexeddb)
- `npm run dev` - app dev server
- `npm run build` - typecheck + production build
