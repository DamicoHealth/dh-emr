# Standing up a DH EMR cloud project (v4.1)

Fifteen minutes, no command line. This creates the org's own Supabase
project; Damico Health hosts nothing and sees nothing.

Upgrading a live v3.0 org instead of starting fresh? Same file, same steps,
but run it AFTER clinic hours: the run briefly locks the records table, and
any iPad syncing during those seconds shows a sync error, retries, and
succeeds afterward. Nothing is lost either way (offline-first), it is just
alarming to watch mid-clinic.

## 1. Create the project

1. supabase.com -> New project. Any name; pick the region closest to the
   clinic; generate a strong database password and store it in a password
   manager (it is rarely needed again).
2. Wait for the project to finish provisioning.

## 2. Run the schema

1. Left sidebar -> SQL Editor -> New query.
2. Paste the ENTIRE contents of `setup.sql` and click Run.
3. It is safe to run twice; re-running is the documented upgrade path.
4. Recommended: paste and run `verify.sql` next. Every row of its output
   must say PASS. It changes nothing (it ends by rolling itself back).

## 3. Get the app credentials

1. Project URL: Project Settings -> Data API (also shown in the Connect
   dialog at the top of the dashboard).
2. Publishable key (`sb_publishable_...`): Project Settings -> API Keys.
3. Those two values are what every device enters. NEVER put the
   `sb_secret_...` key (or a legacy `service_role` key) on any device, in
   any chat, or in the app. It bypasses every security rule. The app
   refuses keys that look like it, on purpose.

Field mode orgs are DONE after step 3; skip to Verify.

## 4. Clinic mode: enable sign-in and create the first admin

Clinic mode is what DH EMR Clinic (packages/clinic) runs: staff sign-in,
account approval and roles on the Staff screen, join links for the staff
devices, and the patient flow board are all in the app. The dashboard and
SQL routes below are the bootstrap for the very first administrator and the
fallbacks for recovery; they are not the day-to-day path. The organization
lead's guide on the website (guides/clinic/setup.html) walks the same steps
with the app screens.

1. Authentication -> Sign In / Up -> enable the Email provider.
2. Turn OFF "Confirm email". This matters more than it looks: without your
   own SMTP server configured, Supabase's built-in mailer is restricted
   and heavily rate limited, so confirmation emails to clinic staff mostly
   never arrive and accounts strand half-created. Admin approval inside
   the app (built into the schema) replaces what confirmation was for.
   For the same reason, do not rely on email-based password resets; see
   the recovery section below.
3. Create the org lead's account: Authentication -> Users -> Add user ->
   choose "Create new user" and set a password (do NOT use "Send
   invitation" - it depends on the same restricted mailer). Staff signing
   up themselves in the app also works: the Clinic sign-in screen has
   "New here? Create an account".
   Either way, a new account NEVER has access by itself: every account
   starts pending. That is deliberate; anyone in the world who obtains
   the project URL and publishable key can sign up, so signup must carry
   no power.
4. Make that first account the administrator - back in the SQL Editor,
   one line (the editor must show exactly ONE returned row; zero rows
   means the email did not match or the account does not exist yet):

       UPDATE users_profiles
       SET is_admin = true, activated_at = now()
       WHERE id = (SELECT id FROM auth.users WHERE lower(email) = lower('LEAD@EXAMPLE.ORG'))
       RETURNING id, is_admin, activated_at;

5. The admin approves every new staff account from the Staff tab in DH EMR
   Clinic (set the station role, then Approve). The SQL fallback, for an
   admin who cannot reach the app, is this line (one row must return):

       UPDATE users_profiles
       SET activated_at = now()
       WHERE id = (SELECT id FROM auth.users WHERE lower(email) = lower('STAFF@EXAMPLE.ORG'))
       RETURNING id, activated_at;

6. Clinic mode itself needs NO manual step. The first time an approved
   administrator signs in on a DH EMR Clinic device, the app writes the
   orgMode row itself (the same vetted upsert the server trigger checks),
   so the step that older notes had here, setting the mode by hand, is
   gone. Nothing in either app offers a mode switch, in either direction.
   The SQL below is the manual fallback only: to flip an org before any
   admin has signed in, or to flip it back to field (value "field") to
   drain stranded field records:

       INSERT INTO config (key, value) VALUES ('orgMode', '{"mode":"clinic"}')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

   IMPORTANT if the org previously ran field devices: sync every field
   iPad to zero pending records FIRST. The moment the mode flips, the
   shared-key surface closes and stranded field records cannot push. The
   recovery for stranded records is the SQL editor: flip the mode back to
   field with the statement above, drain the fleet, then flip forward
   again (or let the next admin sign-in on a Clinic device set it).

## 5. Verify

1. In the app: enter the URL and publishable key (the setup wizard's cloud
   step on a new device; in DH EMR Field also Settings -> Cloud sync). The
   app verifies the tables exist before accepting.
2. Field mode: save one test visit and sync; Table Editor -> records shows
   one row. Delete the test visit in the APP afterward (it tombstones;
   rows are never hard-deleted, which is by design).
3. Clinic mode, additionally: sign in as the admin (should reach the flow
   board), sign up a second test account (should land on "Waiting for
   approval" and see NO data), approve it from the Staff tab, confirm it
   then sees data. Two minutes, and it exercises the whole access model.
   verify.sql rows 9-24 cover the same rules server-side.

## Recovery playbook (SQL Editor)

The schema has no self-service admin path ON PURPOSE, so these three
situations need the SQL editor and nothing else does:

Sole admin forgot their password (email resets are unreliable without
custom SMTP): create a replacement admin. Authentication -> Users -> Add
user -> "Create new user" with a temporary password, then (one row must
return):

    UPDATE users_profiles SET is_admin = true, activated_at = now(), revoked_at = NULL
    WHERE id = (SELECT id FROM auth.users WHERE lower(email) = lower('NEW@EXAMPLE.ORG'))
    RETURNING id, is_admin, activated_at;

Org is adminless (sole admin revoked or deleted): same one-liner against
any existing trusted account, or a fresh one. The revoked_at = NULL part
matters: promoting a once-revoked account without clearing the revocation
does nothing, silently.

Un-revoke an account or device (the app can never do this):

    UPDATE users_profiles SET revoked_at = NULL WHERE id = '<account id>';
    UPDATE devices SET revoked_at = NULL WHERE id = '<device id>';

## Operator quick reference (SQL Editor)

Device fleet - recognize every row; revoke strangers:

    SELECT id, name, role, created_at, last_sync_at,
           CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'REVOKED' END AS status
    FROM devices ORDER BY last_sync_at DESC NULLS LAST;

Revoke a lost or stolen device (records it already pushed are kept):

    UPDATE devices SET revoked_at = now() WHERE id = '<device id>';

Staff accounts:

    SELECT p.id, p.display_name, p.role, p.is_admin,
           p.activated_at, p.revoked_at, u.email
    FROM users_profiles p JOIN auth.users u ON u.id = p.id
    ORDER BY p.created_at;

Revoke a staff account this instant (also do it in the app; this is the
belt to the app's suspenders):

    UPDATE users_profiles SET revoked_at = now() WHERE id = '<account id>';

Row counts sanity check (run before and after any migration; the numbers
must match):

    SELECT (SELECT count(*) FROM records) AS records,
           (SELECT count(*) FROM records WHERE deleted IS TRUE) AS deleted_records,
           (SELECT count(*) FROM devices) AS devices,
           (SELECT count(*) FROM config) AS config_rows,
           (SELECT max(saved_at) FROM records) AS newest_record;

## Free-tier pausing (read this if the org runs seasonal missions)

Supabase pauses free-tier projects after about a week with no traffic, and
a project paused long enough (around 90 days) can stop being restorable in
place. A clinic that syncs twice a year and never opens the dashboard can
silently lose its cloud copy this way. If the org's usage is episodic:
either upgrade the project to a paid tier, or put a calendar reminder to
open the dashboard monthly and click Restore if prompted, and ALWAYS keep
device backups (the app's backup file is the true archive; the cloud is a
convenience copy for the devices, not the org's only copy).

## Honest limits

- Field mode: every device shares one key. Postgres cannot tell devices
  apart, so anyone holding the key can read everything. The revocation
  switch stops an honest revoked device, not a determined attacker who has
  the key. Clinic mode (per-user accounts) is the fix.
- Clinic mode: nothing in either app can change the org's mode. Flipping
  an org back to field is a SQL-editor operation (section 4, step 6), the
  documented recovery path for stranded field records; it reopens the
  shared-key surface, so do it deliberately, drain the fleet, and flip
  forward again.
- Revoking a device does nothing to data already on a lost iPad, and that
  data is not encrypted at rest.
- DH EMR is not a certified EHR and is not HIPAA-compliant. It is intended
  for global-health use outside the US.
