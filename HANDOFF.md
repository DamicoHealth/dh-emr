# DH EMR - current state

Updated 2026-08-12.

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

## Next

1. Core build in flight: domain algorithms + parity tests, per-record
   storage kernel, config model, sync engine (workflow, 4 builders).
2. Fix residual test failures after the build fleet reports; commit green.
3. Then: encounter form + records UI, clinic mode (auth/roles/flow board),
   demo, website.
