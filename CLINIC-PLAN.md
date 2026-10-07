# DH EMR Clinic - build plan after the 2026-10-06 product split

Two products, one shared core. This file is the working plan for the
Clinic product and the website redo. HANDOFF.md holds current state.

## Phase 1 - structural split (in progress)

packages/core (kernel, domain, config, sync, auth, UI kit, all tests),
packages/field (DH EMR Field shell), packages/clinic (DH EMR Clinic
shell). Apps import core via the @dh/core/* alias. packages/app removed.
Clinic production builds use storage suffix "-clinic" so a device with
both products installed never shares a database between them.

## Phase 2 - make the Clinic product real

1. Realtime + auto-sync (what makes the board live)
   - Periodic sync every 20-30 s while online; paused offline.
   - Supabase Realtime channel on records + config feeding the existing
     onRemoteChange trigger (debounced full cycle; payloads never applied).
   - Resubscribe on reconnect and tab wake; catch up via the pull cursor.
   - Expected board latency 1-3 s. Free tier covers a 20-device clinic.

2. Join links + QR onboarding (no typed keys, ever)
   - Admin: Staff or Settings -> "Invite a device" -> link + QR encoding
     project address + publishable key + org name (the key is public by
     design). Opening the link on a device configures it and lands on
     sign-in. Staff self-register, admin approves in the Staff screen.
   - Clinic setup wizard: scan/open link OR typed address + key as the
     fallback. The standalone option does not exist in Clinic.
   - First active admin sign-in writes orgMode=clinic automatically.

3. Role workspaces (Reception, Triage, Provider, Lab, Pharmacy, Admin)
   - Each role lands on its own workspace: Reception -> check-in column +
     short intake form (demographics, visit context); Triage -> triage
     column + vitals/history/chief concern; Provider -> the full visit;
     Lab -> a results-entry page listing visits waiting on labs; Pharmacy
     -> a dispensing list (mark each prescription dispensed with qty, who,
     when; stored on the visit, synced like any edit); Admin -> everything.
   - Section visibility per role is CONFIGURABLE in the template builder:
     each section gets view/edit checkboxes per role, with sensible
     defaults shipped. One shared visit record; each role edits its slice
     as the patient moves across the board.
   - Honest limit (documented in the guides): roles are a workflow layer,
     not a security wall. Any approved staff account can read the org's
     records; the server cannot enforce field-level permissions.

4. Live E2E of the Clinic product against the real Supabase project using
   join links (needs Alec: one staff account + typing its password).

## Phase 3 - website redo (two products)

- Landing: two products side by side. DH EMR Clinic (live, constant
  internet, roles, realtime board). DH EMR Field (offline paper-chart
  entry; standalone or shared-key cloud sync; also the backup app for a
  Clinic org when its backend is down).
- Guides: separate sets. Field: getting started, user guide, admin guide,
  Supabase sync setup. Clinic: org setup (Supabase + first admin + join
  links), per-role user guide, admin guide. Every page carries the
  not-certified / not-HIPAA statement. Fact-check methodology unchanged:
  inventory the real UI, quote only real control names, grep every one.
- Demo hub: "Try the Field demo" (today's seeded demo, reframed) and
  "Try the Clinic demo" (local simulation, no backend: a seeded clinic
  day in progress, a side panel to pick the role you are simulating -
  Triage lands on the triage workspace, Lab on the lab page - and light
  simulated staff activity so the board visibly moves).
- Hero copy slot still awaits Alec's Damico Health story.

## Tabled (keep in mind, do not build yet)

- Field -> Clinic data import (paper-entry backup records merged into the
  live org). MRN-based patient matching is the eventual path; merge rules
  are the hard part.
- Org subdomains (kabale.damicohealth.com) resolving to the same app with
  the join config embedded; needs a small registry. Join links deliver
  the same UX with zero infrastructure first.

## Needs Alec

- `sudo xcodebuild -license accept` (git is blocked; nothing can be
  committed until then).
- One Clinic staff account + typing its password for the live test.
- GitHub repo + Pages + DNS to go public; the pivot story for the hero;
  real iPads for the hardware pass.
