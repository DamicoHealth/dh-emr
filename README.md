# DH EMR

A free, offline-first electronic medical record for global-health clinics,
by [Damico Health](https://damicohealth.com).

One app, two modes chosen per organization:

- **Clinic mode** - connected: named users with roles, realtime sync, and a
  live patient-flow board that tracks each visit through the clinic.
- **Field mode** - offline-first: device identity, everything works with no
  connectivity, sync whenever there is signal.

Organizations make it their own EMR without touching code: their form
templates, their formulary, their lab panel, their sites and providers.
Records belong to the organization, on their own devices and optionally in
their own Supabase project. Damico Health hosts nothing and sees nothing.

DH EMR is not a certified EHR and is not HIPAA-compliant. It is intended for
global-health use outside the US.

## Development

```
npm install
npm test
npm run dev
```

Built and maintained by one physician-developer. The test suite is the
specification: see REBUILD-HANDOFF.md for the invariants behind it.
