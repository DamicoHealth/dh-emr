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

## Next

1. Port parity + invariant tests from the reference repo (the executable
   spec) with vendored legacy fixtures.
2. Build domain algorithms and the per-record storage kernel until green.
3. Supabase schema v4: carry v3.0 hardening forward, add users/roles/flow.
