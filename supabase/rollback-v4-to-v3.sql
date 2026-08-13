-- ============================================================================
-- Roll a v4.1 project back to v3.0 behavior.
--
-- Use this only if the v4 machinery misbehaves in the field. It restores
-- the exact v3.0 policy surface (shared-key field mode, no mode gate, no
-- staff accounts) and removes every v4 trigger and function.
--
-- Deliberately KEPT, because dropping them destroys data and unused
-- objects cost nothing: the users_profiles table and its rows, the new
-- records columns (user_id, flow_station, flow_updated_at), all indexes,
-- and any orgMode config row (it becomes inert once the functions that
-- read it are gone).
--
-- Safe to re-run. After running this, re-running v3.0 setup.sql is a
-- no-op; re-running v4.1 setup.sql re-applies v4.
-- ============================================================================

-- 1. Restore the v3.0 anon policies (same names, no TO clause, no mode gate).
DROP POLICY IF EXISTS "anon_read_records" ON records;
CREATE POLICY "anon_read_records" ON records
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "anon_insert_records" ON records;
CREATE POLICY "anon_insert_records" ON records
  FOR INSERT WITH CHECK (
    device_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id AND d.revoked_at IS NULL)
  );

DROP POLICY IF EXISTS "anon_update_records" ON records;
CREATE POLICY "anon_update_records" ON records
  FOR UPDATE
  USING (
    device_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id AND d.revoked_at IS NULL)
  )
  WITH CHECK (
    device_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id AND d.revoked_at IS NULL)
  );

DROP POLICY IF EXISTS "anon_read_devices" ON devices;
CREATE POLICY "anon_read_devices" ON devices
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "anon_insert_devices" ON devices;
CREATE POLICY "anon_insert_devices" ON devices
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_devices" ON devices;
CREATE POLICY "anon_update_devices" ON devices
  FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_read_config" ON config;
CREATE POLICY "anon_read_config" ON config
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "anon_write_config" ON config;
CREATE POLICY "anon_write_config" ON config
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_config" ON config;
CREATE POLICY "anon_update_config" ON config
  FOR UPDATE USING (true) WITH CHECK (true);

-- 2. Remove the v4 staff-account policies (the table itself stays).
DROP POLICY IF EXISTS "auth_read_records" ON records;
DROP POLICY IF EXISTS "auth_insert_records" ON records;
DROP POLICY IF EXISTS "auth_update_records" ON records;
DROP POLICY IF EXISTS "auth_read_devices" ON devices;
DROP POLICY IF EXISTS "auth_insert_devices" ON devices;
DROP POLICY IF EXISTS "auth_update_devices" ON devices;
DROP POLICY IF EXISTS "auth_read_config" ON config;
DROP POLICY IF EXISTS "auth_write_config" ON config;
DROP POLICY IF EXISTS "auth_update_config" ON config;
DROP POLICY IF EXISTS "auth_read_profiles" ON users_profiles;
DROP POLICY IF EXISTS "auth_insert_profiles" ON users_profiles;
DROP POLICY IF EXISTS "auth_update_profiles" ON users_profiles;

-- 3. Remove the v4 triggers and functions. The device-rules trigger and
--    update_synced_at stay: they are v3.0 machinery.
DROP TRIGGER IF EXISTS trg_users_rules ON users_profiles;
DROP TRIGGER IF EXISTS trg_config_rules ON config;
DROP TRIGGER IF EXISTS trg_records_rules ON records;
DROP TRIGGER IF EXISTS trg_config_updated_at ON config;

-- The signup trigger lives on auth.users, which the postgres role does
-- not own on every stack; DROP TRIGGER there can fail with 'must be owner
-- of relation users' and abort the whole rollback. Dropping the function
-- with CASCADE removes the dependent trigger without needing ownership.
DROP FUNCTION IF EXISTS dh_handle_new_user() CASCADE;

DROP FUNCTION IF EXISTS dh_enforce_user_rules();
DROP FUNCTION IF EXISTS dh_enforce_config_rules();
DROP FUNCTION IF EXISTS dh_enforce_record_rules();
DROP FUNCTION IF EXISTS dh_touch_config_updated_at();
DROP FUNCTION IF EXISTS dh_org_mode();
DROP FUNCTION IF EXISTS dh_active_profile();
DROP FUNCTION IF EXISTS dh_is_admin();

-- 4. Confirm: this should return no rows. trg_on_auth_user_created is in
--    the list because its drop is the permission-fragile one; if it shows
--    up here, the signup trigger survived and is still creating profile
--    rows.
SELECT tgname FROM pg_trigger
WHERE tgname IN ('trg_users_rules', 'trg_config_rules', 'trg_records_rules',
                 'trg_config_updated_at', 'trg_on_auth_user_created');
