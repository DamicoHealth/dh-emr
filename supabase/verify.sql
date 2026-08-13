-- ============================================================================
-- DH EMR v4.1 verification suite
--
-- Paste the ENTIRE file into the Supabase SQL Editor and click Run AFTER
-- running setup.sql. It seeds throwaway rows, attacks the rules as the
-- anon and authenticated roles, prints a PASS/FAIL table, and ROLLS BACK,
-- so it changes nothing.
--
-- Every row must say PASS. Row 0 is the positive control: if it FAILS,
-- the anon role is missing table grants and every other PASS is
-- meaningless because writes were blocked by permissions, not by policy.
--
-- Section B (rows 9+) seeds rows directly in auth.users to simulate
-- signups. If your Supabase version rejects that insert, row 9 says SKIP
-- (with the database's reason) and the rows after it will show FAIL noise;
-- the section A results above stay valid either way, and the clinic-mode
-- checks can be done by hand per SETUP.md section 5.
--
-- Best run on a project WITHOUT real staff accounts yet (fresh project or
-- field-mode org). On a project with existing active admins, row 14 says
-- SKIP (the sole-admin guard cannot be probed when other admins exist).
-- ============================================================================

BEGIN;

CREATE TEMP TABLE dh_verify (n INT, result TEXT, check_name TEXT, detail TEXT) ON COMMIT DROP;
GRANT INSERT, SELECT ON dh_verify TO anon, authenticated;
CREATE TEMP TABLE dh_env (k TEXT PRIMARY KEY, v TEXT) ON COMMIT DROP;
GRANT SELECT ON dh_env TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed (as the trusted SQL-editor role; triggers bypass on purpose)
-- ---------------------------------------------------------------------------
DELETE FROM config WHERE key = 'orgMode';   -- start in field mode; all rolled back
INSERT INTO devices (id, name, role) VALUES ('dh-verify-admin', 'verify admin device', 'admin');
INSERT INTO devices (id, name, role) VALUES ('dh-verify-std', 'verify standard device', 'standard');
INSERT INTO devices (id, name, role, revoked_at) VALUES ('dh-verify-revoked', 'verify revoked device', 'standard', now());
INSERT INTO records (id, device_id, given_name, mrn)
VALUES ('00000000-0000-4000-8000-00000000d0c1', 'dh-verify-revoked', 'RevokedWrote', 'VERIFY0');

-- ===========================================================================
-- SECTION A: field mode, anon role (v3.0 rules carried forward + v4 gates)
-- ===========================================================================
SET LOCAL ROLE anon;

-- 0. control: an active device can write a record
DO $$ BEGIN
  INSERT INTO records (id, device_id, given_name, mrn)
  VALUES ('00000000-0000-4000-8000-00000000d0c2', 'dh-verify-std', 'Control', 'VERIFY1');
  INSERT INTO dh_verify VALUES (0, 'PASS', 'control: an active device can write a record', '');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (0, 'FAIL', 'control: an active device can write a record', SQLERRM);
END $$;

-- 1. a standard device cannot promote itself to admin
DO $$ BEGIN
  UPDATE devices SET role = 'admin' WHERE id = 'dh-verify-std';
  INSERT INTO dh_verify VALUES (1, 'FAIL', 'a standard device cannot promote itself to admin', 'update was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (1, 'PASS', 'a standard device cannot promote itself to admin', SQLERRM);
END $$;

-- 2. a device id cannot be changed
DO $$ BEGIN
  UPDATE devices SET id = 'dh-verify-std-2' WHERE id = 'dh-verify-std';
  INSERT INTO dh_verify VALUES (2, 'FAIL', 'a device id cannot be changed', 'update was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (2, 'PASS', 'a device id cannot be changed', SQLERRM);
END $$;

-- 3. a record cannot be written for an unregistered device
DO $$ BEGIN
  INSERT INTO records (id, device_id, given_name, mrn)
  VALUES ('00000000-0000-4000-8000-00000000d0c3', 'dh-verify-ghost', 'Ghost', 'VERIFY2');
  INSERT INTO dh_verify VALUES (3, 'FAIL', 'a record cannot be written for an unregistered device', 'insert was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (3, 'PASS', 'a record cannot be written for an unregistered device', SQLERRM);
END $$;

-- 4. a revoked device cannot un-revoke itself
DO $$ BEGIN
  UPDATE devices SET revoked_at = NULL WHERE id = 'dh-verify-revoked';
  INSERT INTO dh_verify VALUES (4, 'FAIL', 'a revoked device cannot un-revoke itself', 'update was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (4, 'PASS', 'a revoked device cannot un-revoke itself', SQLERRM);
END $$;

-- 5. a revoked device cannot write new records
DO $$ BEGIN
  INSERT INTO records (id, device_id, given_name, mrn)
  VALUES ('00000000-0000-4000-8000-00000000d0c4', 'dh-verify-revoked', 'Zombie', 'VERIFY3');
  INSERT INTO dh_verify VALUES (5, 'FAIL', 'a revoked device cannot write new records', 'insert was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (5, 'PASS', 'a revoked device cannot write new records', SQLERRM);
END $$;

-- 6. a revoked device cannot alter records it wrote earlier (silent 0 rows)
DO $$
DECLARE n_updated INT;
BEGIN
  UPDATE records SET notes = 'tampered' WHERE id = '00000000-0000-4000-8000-00000000d0c1';
  GET DIAGNOSTICS n_updated = ROW_COUNT;
  IF n_updated = 0 THEN
    INSERT INTO dh_verify VALUES (6, 'PASS', 'a revoked device cannot alter records it wrote earlier', '0 rows updated');
  ELSE
    INSERT INTO dh_verify VALUES (6, 'FAIL', 'a revoked device cannot alter records it wrote earlier', n_updated || ' rows updated');
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (6, 'PASS', 'a revoked device cannot alter records it wrote earlier', SQLERRM);
END $$;

-- 7. a record id cannot be changed
DO $$ BEGIN
  UPDATE records SET id = '00000000-0000-4000-8000-00000000dead'
  WHERE id = '00000000-0000-4000-8000-00000000d0c2';
  INSERT INTO dh_verify VALUES (7, 'FAIL', 'a record id cannot be changed', 'update was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (7, 'PASS', 'a record id cannot be changed', SQLERRM);
END $$;

-- 8. the shared key cannot switch the org to clinic mode
DO $$ BEGIN
  INSERT INTO config (key, value) VALUES ('orgMode', '{"mode":"clinic"}');
  INSERT INTO dh_verify VALUES (8, 'FAIL', 'the shared key cannot switch the org to clinic mode', 'insert was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (8, 'PASS', 'the shared key cannot switch the org to clinic mode', SQLERRM);
END $$;

RESET ROLE;

-- ===========================================================================
-- SECTION B: staff accounts and clinic mode
-- ===========================================================================

-- Remember whether this project already has active admin accounts (used
-- to SKIP the sole-admin probe rather than report false alarms).
INSERT INTO dh_env
SELECT 'preexisting_admins', count(*)::text
FROM users_profiles
WHERE is_admin AND activated_at IS NOT NULL AND revoked_at IS NULL;

-- Simulate two signups (fires the same trigger a real signup does).
-- Wrapped so a version-sensitive auth.users shape cannot abort the whole
-- transaction and hide section A's results.
DO $$ BEGIN
  INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          confirmation_token, recovery_token,
                          email_change_token_new, email_change)
  VALUES ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000a1',
          'authenticated', 'authenticated', 'dh-verify-lead@example.org', '',
          now(), now(), now(), '', '', '', ''),
         ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000a2',
          'authenticated', 'authenticated', 'dh-verify-staff@example.org', '',
          now(), now(), now(), '', '', '', '');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (9, 'SKIP', 'section B skipped: auth.users seeding rejected on this Supabase version', SQLERRM);
END $$;

-- 9. signing up grants nothing: both profiles pending, neither admin
DO $$
DECLARE bad INT;
BEGIN
  IF EXISTS (SELECT 1 FROM dh_verify WHERE n = 9 AND result = 'SKIP') THEN
    NULL;  -- seeding failed; the SKIP row already explains why
  ELSE
    SELECT count(*) INTO bad FROM users_profiles
    WHERE id IN ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2')
      AND (is_admin OR activated_at IS NOT NULL);
    IF bad = 0 AND (SELECT count(*) FROM users_profiles
                    WHERE id IN ('00000000-0000-4000-8000-0000000000a1',
                                 '00000000-0000-4000-8000-0000000000a2')) = 2 THEN
      INSERT INTO dh_verify VALUES (9, 'PASS', 'signing up grants nothing (pending, not admin)', '');
    ELSE
      INSERT INTO dh_verify VALUES (9, 'FAIL', 'signing up grants nothing (pending, not admin)', bad || ' profiles had privileges');
    END IF;
  END IF;
END $$;

-- Act as the pending lead account.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);

-- 10. a pending account cannot read records
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM records;
  IF n = 0 THEN
    INSERT INTO dh_verify VALUES (10, 'PASS', 'a pending account cannot read records', '');
  ELSE
    INSERT INTO dh_verify VALUES (10, 'FAIL', 'a pending account cannot read records', n || ' rows visible');
  END IF;
END $$;

-- 11. a pending account cannot approve itself
DO $$ BEGIN
  UPDATE users_profiles SET activated_at = now()
  WHERE id = '00000000-0000-4000-8000-0000000000a1';
  INSERT INTO dh_verify VALUES (11, 'FAIL', 'a pending account cannot approve itself', 'update was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (11, 'PASS', 'a pending account cannot approve itself', SQLERRM);
END $$;

-- 12. a pending account sees only its own profile row
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM users_profiles;
  IF n = 1 THEN
    INSERT INTO dh_verify VALUES (12, 'PASS', 'a pending account sees only its own profile row', '');
  ELSE
    INSERT INTO dh_verify VALUES (12, 'FAIL', 'a pending account sees only its own profile row', n || ' rows visible');
  END IF;
END $$;

RESET ROLE;

-- Bootstrap the first admin exactly as SETUP.md documents.
UPDATE users_profiles SET is_admin = true, activated_at = now()
WHERE id = '00000000-0000-4000-8000-0000000000a1';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);

-- 13. the bootstrapped admin can write config
DO $$ BEGIN
  INSERT INTO config (key, value) VALUES ('dh-verify-key', '{"ok":true}');
  INSERT INTO dh_verify VALUES (13, 'PASS', 'the bootstrapped admin can write config', '');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (13, 'FAIL', 'the bootstrapped admin can write config', SQLERRM);
END $$;

-- 14. the only admin cannot revoke, demote, or deactivate themselves
--     (skipped when the project already has other active admins - the
--     guard correctly allows self-removal in that case)
DO $$ BEGIN
  IF (SELECT v FROM dh_env WHERE k = 'preexisting_admins') <> '0' THEN
    INSERT INTO dh_verify VALUES (14, 'SKIP', 'the only admin cannot disable themselves', 'project already has active admins; guard not probeable');
  ELSE
    BEGIN
      UPDATE users_profiles SET revoked_at = now()
      WHERE id = '00000000-0000-4000-8000-0000000000a1';
      INSERT INTO dh_verify VALUES (14, 'FAIL', 'the only admin cannot disable themselves', 'self-revoke was allowed');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO dh_verify VALUES (14, 'PASS', 'the only admin cannot disable themselves', SQLERRM);
    END;
  END IF;
END $$;

-- 15. an admin can switch the org to clinic mode
DO $$ BEGIN
  INSERT INTO config (key, value) VALUES ('orgMode', '{"mode":"clinic"}')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  INSERT INTO dh_verify VALUES (15, 'PASS', 'an admin can switch the org to clinic mode', '');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (15, 'FAIL', 'an admin can switch the org to clinic mode', SQLERRM);
END $$;

-- 16. an active staff account reads records in clinic mode
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM records;
  IF n >= 2 THEN
    INSERT INTO dh_verify VALUES (16, 'PASS', 'an active staff account reads records in clinic mode', n || ' rows');
  ELSE
    INSERT INTO dh_verify VALUES (16, 'FAIL', 'an active staff account reads records in clinic mode', n || ' rows visible');
  END IF;
END $$;

RESET ROLE;
-- RESET ROLE does not clear GUCs: blank the JWT claims so the anon checks
-- below run as a true key-only caller, not as the admin's leftover
-- identity. Empty string, not NULL: auth.uid() nullif()s '' to NULL.
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE anon;

-- 17. clinic mode: the shared key cannot read records
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM records;
  IF n = 0 THEN
    INSERT INTO dh_verify VALUES (17, 'PASS', 'clinic mode: the shared key cannot read records', '');
  ELSE
    INSERT INTO dh_verify VALUES (17, 'FAIL', 'clinic mode: the shared key cannot read records', n || ' rows visible');
  END IF;
END $$;

-- 18. clinic mode: the shared key cannot write records
DO $$ BEGIN
  INSERT INTO records (id, device_id, given_name, mrn)
  VALUES ('00000000-0000-4000-8000-00000000d0c5', 'dh-verify-std', 'Locked', 'VERIFY4');
  INSERT INTO dh_verify VALUES (18, 'FAIL', 'clinic mode: the shared key cannot write records', 'insert was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (18, 'PASS', 'clinic mode: the shared key cannot write records', SQLERRM);
END $$;

-- 19. clinic mode: the shared key cannot register devices
DO $$ BEGIN
  INSERT INTO devices (id, name) VALUES ('dh-verify-intruder', 'intruder');
  INSERT INTO dh_verify VALUES (19, 'FAIL', 'clinic mode: the shared key cannot register devices', 'insert was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (19, 'PASS', 'clinic mode: the shared key cannot register devices', SQLERRM);
END $$;

-- 20. clinic mode: the shared key sees exactly one config row (orgMode)
DO $$
DECLARE n INT; k TEXT;
BEGIN
  SELECT count(*), min(key) INTO n, k FROM config;
  IF n = 1 AND k = 'orgMode' THEN
    INSERT INTO dh_verify VALUES (20, 'PASS', 'clinic mode: the shared key sees only the orgMode row', '');
  ELSE
    INSERT INTO dh_verify VALUES (20, 'FAIL', 'clinic mode: the shared key sees only the orgMode row', n || ' rows visible');
  END IF;
END $$;

-- 21. clinic mode: the shared key cannot enumerate the device fleet
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM devices;
  IF n = 0 THEN
    INSERT INTO dh_verify VALUES (21, 'PASS', 'clinic mode: the shared key cannot enumerate the device fleet', '');
  ELSE
    INSERT INTO dh_verify VALUES (21, 'FAIL', 'clinic mode: the shared key cannot enumerate the device fleet', n || ' rows visible');
  END IF;
END $$;

RESET ROLE;

-- Revoke the second (still pending) account, then prove stickiness.
UPDATE users_profiles SET revoked_at = now()
WHERE id = '00000000-0000-4000-8000-0000000000a2';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a2', true);

-- 22. a revoked account cannot read records
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM records;
  IF n = 0 THEN
    INSERT INTO dh_verify VALUES (22, 'PASS', 'a revoked account cannot read records', '');
  ELSE
    INSERT INTO dh_verify VALUES (22, 'FAIL', 'a revoked account cannot read records', n || ' rows visible');
  END IF;
END $$;

-- 23. a revoked account cannot un-revoke itself
DO $$ BEGIN
  UPDATE users_profiles SET revoked_at = NULL
  WHERE id = '00000000-0000-4000-8000-0000000000a2';
  INSERT INTO dh_verify VALUES (23, 'FAIL', 'a revoked account cannot un-revoke itself', 'update was allowed');
EXCEPTION WHEN OTHERS THEN
  INSERT INTO dh_verify VALUES (23, 'PASS', 'a revoked account cannot un-revoke itself', SQLERRM);
END $$;

-- 24. a revoked account cannot see the staff roster (only its own row)
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM users_profiles;
  IF n <= 1 THEN
    INSERT INTO dh_verify VALUES (24, 'PASS', 'a revoked account sees at most its own profile row', '');
  ELSE
    INSERT INTO dh_verify VALUES (24, 'FAIL', 'a revoked account sees at most its own profile row', n || ' rows visible');
  END IF;
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- Results, then roll everything back.
-- ---------------------------------------------------------------------------
SELECT n, result, check_name, left(detail, 80) AS detail
FROM dh_verify ORDER BY n;

ROLLBACK;
