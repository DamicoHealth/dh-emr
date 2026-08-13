-- ============================================================================
-- DH EMR cloud schema v4.1
--
-- One-shot setup for a new org project. Paste the ENTIRE file into the
-- Supabase SQL Editor and click Run. Safe to re-run: tables and columns use
-- IF NOT EXISTS, policies and triggers are drop-then-create.
--
-- Carries forward every v3.0 hardening rule (device kill switch, first
-- admin wins for DEVICES, immutable ids, soft deletes only, server-side
-- synced_at) and adds what the two-mode product needs:
--
--   FIELD MODE  (offline-first, shared publishable key, device identity)
--     Works exactly like v3.0. The org never creates user accounts.
--
--   CLINIC MODE (connected, per-user Supabase Auth, roles, patient flow)
--     Each staff member signs in with their own account. The shared-key
--     (anon) surface for records, devices and config CLOSES the moment the
--     org switches mode; the single exception is the orgMode config row,
--     which stays readable so a device holding only URL + key can discover
--     that it must show a sign-in screen.
--
-- The mode lives in config under key 'orgMode' ({"mode":"field"} or
-- {"mode":"clinic"}); absent means field, so v3.0 orgs upgrade in place
-- with no behavior change.
--
-- STAFF ACCOUNT BOOTSTRAP (deliberate design, do not "simplify"):
-- signing up NEVER grants anything. Every new account starts pending
-- (not activated, not admin). The FIRST admin is created by the operator
-- with one SQL line (SETUP.md section 4) right after running this file;
-- after that, admins approve accounts inside the app. There is no
-- auto-admin path: the publishable key is shared by design and Supabase
-- signups are open by default, so any signup-time privilege grant would
-- be claimable by anyone holding the key, including exactly during the
-- windows (virgin project, sole admin revoked) when it matters most.
-- The device fleet keeps v3.0's first-admin-wins because device
-- registration is the field-mode enrollment path and carries no
-- cross-user authority; staff accounts DO carry authority, so they get
-- the stricter rule.
--
-- AUTHENTICATED ACCESS WORKS IN BOTH MODES (deliberate): an org moving to
-- clinic mode onboards staff and drains every field iPad's unsynced
-- records BEFORE flipping the mode; the flip then closes the anon surface
-- with nothing stranded. Without SQL-editor bootstrap the authenticated
-- surface is inert (no activated accounts can exist), so leaving the
-- Email provider enabled on a field org exposes nothing.
--
-- HONEST LIMIT (field mode, unchanged from v3.0): every device shares one
-- key, so Postgres cannot tell devices apart and anyone holding the key
-- can read everything. Clinic mode is the fix; field mode documents the
-- limit.
-- ============================================================================


-- ============================================================================
-- 1. TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS records (
  id UUID PRIMARY KEY,                     -- client-generated, no default
  device_id TEXT,
  site TEXT,
  date TEXT,                               -- encounter date as TEXT; client owns formatting
  mrn TEXT,
  given_name TEXT,
  family_name TEXT,
  name TEXT,
  sex TEXT,
  dob TEXT,
  phone TEXT,
  pregnant TEXT,
  breastfeeding TEXT,
  temp TEXT,
  bp TEXT,
  weight TEXT,
  allergies TEXT,
  current_meds TEXT,
  pmh TEXT,
  chief_concern TEXT,
  labs JSONB DEFAULT '{}'::jsonb,
  lab_comments TEXT,
  urinalysis JSONB DEFAULT '{}'::jsonb,
  blood_glucose TEXT,
  diagnosis TEXT,
  diagnosis_codes JSONB DEFAULT '[]'::jsonb,
  medications JSONB DEFAULT '[]'::jsonb,
  treatment_notes TEXT,
  treatment TEXT,
  procedures JSONB DEFAULT '[]'::jsonb,
  transport TEXT,
  travel_time TEXT,
  access_to_care JSONB,
  referral_type TEXT,
  referral_date TEXT,
  referral_status TEXT,
  imaging JSONB,
  surgery JSONB,
  provider TEXT,
  notes TEXT,
  custom_fields JSONB DEFAULT '{}'::jsonb,
  template_id TEXT,
  template_name TEXT,
  age_estimated BOOLEAN DEFAULT false,
  saved_at TIMESTAMPTZ,                    -- client clock; unreliable, display only
  sync_version INTEGER DEFAULT 1,
  deleted BOOLEAN DEFAULT false,           -- soft delete; nothing hard-deletes
  synced_at TIMESTAMPTZ DEFAULT now(),     -- server clock, trigger-maintained
  -- v4 additions
  user_id UUID,                            -- clinic mode: auth.uid() of the creator
  flow_station TEXT,                       -- clinic mode: current station on the flow board
  flow_updated_at TIMESTAMPTZ              -- when the station last changed
);

-- Idempotent upgrades for projects created on older schemas.
ALTER TABLE records ADD COLUMN IF NOT EXISTS diagnosis_codes JSONB DEFAULT '[]'::jsonb;
ALTER TABLE records ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'::jsonb;
ALTER TABLE records ADD COLUMN IF NOT EXISTS template_id TEXT;
ALTER TABLE records ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE records ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE records ADD COLUMN IF NOT EXISTS flow_station TEXT;
ALTER TABLE records ADD COLUMN IF NOT EXISTS flow_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,                     -- client-chosen id; TEXT, not UUID
  name TEXT NOT NULL,
  role TEXT DEFAULT 'standard',            -- 'standard' | 'admin'; trigger-enforced
  org_name TEXT,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ                   -- kill switch: NULL = active
);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
COMMENT ON COLUMN devices.revoked_at IS
  'Set to now() to cut a lost or stolen device off from writing. Records it already pushed are kept. Only the SQL editor can clear this.';

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()     -- trigger-maintained in v4 (v3 was default-only)
);

-- Clinic mode staff accounts. One row per auth user.
-- role is the clinical station role (reception | nurse | provider |
-- pharmacy); admin is a separate flag because a provider can also be the
-- org admin. TEXT without a CHECK on purpose, like devices.role: the org
-- customizes its station list in config and the client enforces it.
CREATE TABLE IF NOT EXISTS users_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT DEFAULT 'provider',
  is_admin BOOLEAN NOT NULL DEFAULT false, -- NOT NULL: a NULL here would slip
                                           -- through boolean guards as
                                           -- "unknown" and dodge the
                                           -- last-admin protection
  activated_at TIMESTAMPTZ,                -- NULL = awaiting admin approval
  created_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ                   -- kill switch, same semantics as devices
);
-- Idempotent hardening for projects that created the table before the
-- NOT NULL constraint existed.
UPDATE users_profiles SET is_admin = false WHERE is_admin IS NULL;
ALTER TABLE users_profiles ALTER COLUMN is_admin SET NOT NULL;
COMMENT ON COLUMN users_profiles.activated_at IS
  'NULL means the account is waiting for approval. The first admin is created from the SQL editor (SETUP.md section 4); after that, admins approve accounts in the app.';
COMMENT ON COLUMN users_profiles.revoked_at IS
  'Set to now() to lock the account out. Only an admin or the SQL editor can clear this.';


-- ============================================================================
-- 2. HELPER FUNCTIONS
--
-- All three are SECURITY DEFINER, and that is REQUIRED, not a convenience:
-- these helpers are called from inside RLS policies on the very tables
-- they read (config policies call dh_org_mode which reads config; profile
-- policies call dh_active_profile which reads users_profiles). As invoker,
-- the inner read would re-enter the same policy and Postgres would abort
-- with infinite recursion. As definer they bypass RLS for a single
-- self-filtered read; none of them contains current_user logic, so the
-- v3.0 "never SECURITY DEFINER" rule (which is about the TRIGGERS below,
-- where current_user distinguishes app callers from the SQL editor) does
-- not apply to them.
--
-- Corollary: never add FORCE ROW LEVEL SECURITY to any of these tables.
-- The definer bypass works because the table owner is exempt from RLS;
-- FORCE removes that exemption and every helper re-enters its own
-- table's policies - all four tables then fail closed with recursion
-- errors.
-- ============================================================================

-- The org's mode. Absent config row means 'field' so v3.0 projects upgrade
-- with no behavior change.
CREATE OR REPLACE FUNCTION dh_org_mode()
RETURNS TEXT
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT value->>'mode' FROM config WHERE key = 'orgMode'), 'field');
$$;

-- Caller has an activated, non-revoked staff account.
CREATE OR REPLACE FUNCTION dh_active_profile()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users_profiles p
    WHERE p.id = auth.uid()
      AND p.activated_at IS NOT NULL
      AND p.revoked_at IS NULL
  );
$$;

-- Caller is an active admin.
CREATE OR REPLACE FUNCTION dh_is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users_profiles p
    WHERE p.id = auth.uid()
      AND p.is_admin
      AND p.activated_at IS NOT NULL
      AND p.revoked_at IS NULL
  );
$$;


-- ============================================================================
-- 3. DEVICE RULES TRIGGER (unchanged semantics from v3.0)
--
-- RLS cannot compare OLD and NEW, so the rules that need that live here.
--
-- Deliberately NOT SECURITY DEFINER: inside a SECURITY DEFINER function
-- current_user is the function OWNER, not the caller, so the bypass check
-- below would match on every call and the trigger would enforce nothing at
-- all. As security invoker, current_user is 'anon' or 'authenticated' for
-- an app caller and 'postgres' or 'service_role' from the SQL editor,
-- which is exactly the distinction needed.
-- ============================================================================

CREATE OR REPLACE FUNCTION dh_enforce_device_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  other_admins INT;
BEGIN
  -- The SQL editor and service_role skip all rules; this is how the
  -- operator promotes, demotes, or clears a revocation.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- First admin wins: a brand-new device may register as admin ONLY when
    -- the project has zero active admin devices (genuine first run, so the
    -- org creator gets an admin device without opening the SQL editor).
    -- Silent demotion, no error. Device admin only means "may edit org
    -- config from this device in field mode"; it grants nothing over
    -- other devices or staff accounts.
    IF COALESCE(NEW.role, 'standard') = 'admin' THEN
      SELECT count(*) INTO other_admins
      FROM devices WHERE role = 'admin' AND revoked_at IS NULL;
      IF other_admins > 0 THEN
        NEW.role := 'standard';
      END IF;
    END IF;
    -- A device cannot register itself pre-revoked, or pre-dated.
    NEW.revoked_at := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE rules.
  -- Rewriting a device id would orphan every record that points at it.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'A device id cannot be changed.';
  END IF;

  -- Revocation is sticky. Without this the kill switch is decorative.
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'This device has been revoked. Only an administrator can restore it.';
  END IF;

  -- Promotion via the app is allowed only when NO other active admin
  -- device exists (recovery path when the admin fleet is empty or
  -- revoked). Demotion is always allowed: it can only reduce access.
  IF NEW.role IS DISTINCT FROM OLD.role AND NEW.role = 'admin' THEN
    SELECT count(*) INTO other_admins
    FROM devices
    WHERE role = 'admin' AND revoked_at IS NULL AND id <> NEW.id;
    IF other_admins > 0 THEN
      RAISE EXCEPTION 'Only an administrator can make another device an admin. Ask whoever set up this project.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_devices_rules ON devices;
CREATE TRIGGER trg_devices_rules
  BEFORE INSERT OR UPDATE ON devices
  FOR EACH ROW
  EXECUTE FUNCTION dh_enforce_device_rules();


-- ============================================================================
-- 4. USER PROFILE RULES TRIGGER (clinic mode)
--
-- Stricter than the device rules, on purpose (see the bootstrap note in
-- the header): app callers can never grant admin, never activate, never
-- revoke or restore except through an admin account, and signing up never
-- yields anything but a pending row. SECURITY INVOKER for the same reason
-- as the device trigger. Note the SQL-editor path (signup trigger runs as
-- definer) bypasses this function entirely; the signup function itself
-- only ever writes pending rows.
-- ============================================================================

CREATE OR REPLACE FUNCTION dh_enforce_user_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  other_admins INT;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- No self-service privileges, ever. There is deliberately NO
    -- first-admin window here (unlike devices): the first admin comes
    -- from the SQL editor.
    NEW.is_admin := false;
    NEW.activated_at := NULL;
    NEW.revoked_at := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE rules.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'An account id cannot be changed.';
  END IF;

  IF NOT dh_is_admin() THEN
    -- Non-admins may edit their own display name and station role only.
    IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
      RAISE EXCEPTION 'Only an administrator can change admin status.';
    END IF;
    IF NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
      RAISE EXCEPTION 'Only an administrator can approve an account.';
    END IF;
    IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'Only an administrator can revoke or restore an account.';
    END IF;
  ELSE
    -- The last active admin cannot remove or disable themselves; the org
    -- would be locked out of its own settings and, because there is no
    -- self-service admin path, only the SQL editor could recover it.
    -- Guard all three ways an admin could vanish: demotion, revocation,
    -- deactivation. The comparison is null-strict (IS DISTINCT FROM true)
    -- and the count runs under an advisory lock so two admins removing
    -- themselves at the same moment cannot both slip through.
    IF OLD.id = auth.uid()
       AND OLD.is_admin AND OLD.activated_at IS NOT NULL AND OLD.revoked_at IS NULL
       AND (NEW.is_admin IS DISTINCT FROM true
            OR NEW.activated_at IS NULL
            OR NEW.revoked_at IS NOT NULL)
    THEN
      PERFORM pg_advisory_xact_lock(hashtext('dh_users_admin_guard'));
      SELECT count(*) INTO other_admins
      FROM users_profiles
      WHERE is_admin AND activated_at IS NOT NULL AND revoked_at IS NULL
        AND id <> OLD.id;
      IF other_admins = 0 THEN
        RAISE EXCEPTION 'You are the only administrator. Make someone else an admin first.';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_rules ON users_profiles;
CREATE TRIGGER trg_users_rules
  BEFORE INSERT OR UPDATE ON users_profiles
  FOR EACH ROW
  EXECUTE FUNCTION dh_enforce_user_rules();


-- ============================================================================
-- 5. PROFILE AUTO-CREATION ON SIGNUP
--
-- Standard Supabase pattern. SECURITY DEFINER is REQUIRED (the trigger
-- fires in auth schema context, which cannot write public tables as the
-- caller), and it is safe ONLY because this function grants nothing: the
-- row it inserts is always pending (is_admin false, activated_at NULL).
-- Do not add privilege logic here; as definer it bypasses the rules
-- trigger's app-caller checks, so anything written here is law.
-- ============================================================================

CREATE OR REPLACE FUNCTION dh_handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO users_profiles (id, display_name, is_admin, activated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1), ''),
    false,
    NULL
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION dh_handle_new_user();


-- ============================================================================
-- 6. RECORD RULES TRIGGER (v4)
--
-- Identity and attribution are immutable through the app, in both modes.
-- v3 had no trigger on records at all; clinic mode makes one necessary
-- because per-user attribution is only worth having if staff cannot
-- rewrite it. SECURITY INVOKER, same reasoning as the device trigger.
-- ============================================================================

CREATE OR REPLACE FUNCTION dh_enforce_record_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A device (anon has no auth.uid) can never claim authorship for a
    -- new row; a signed-in insert is already forced to self-attribute by
    -- the auth_insert_records policy.
    IF auth.uid() IS NULL THEN
      NEW.user_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE rules.
  -- Rewriting a record id would break sync identity on every device.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'A record id cannot be changed.';
  END IF;

  -- Attribution rules. Two failure modes bound this design:
  -- a raise on anon writes would wedge a whole device's sync batch the
  -- first time a field iPad round-trips a clinic-era row whose user_id
  -- it never knew (one poisoned row aborts a PostgREST bulk upsert),
  -- and a naive uuid = auth.uid() comparison is NULL for anon callers,
  -- which plpgsql IF treats as false and the guard silently passes.
  -- So: devices get COERCED (attribution preserved, sync never wedges);
  -- signed-in users may backfill an unattributed row to themselves,
  -- admins may reassign, and everything else raises.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    IF auth.uid() IS NULL THEN
      NEW.user_id := OLD.user_id;
    ELSIF NOT (OLD.user_id IS NULL AND NEW.user_id = auth.uid())
          AND NOT dh_is_admin() THEN
      RAISE EXCEPTION 'The author of a visit cannot be changed.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_records_rules ON records;
CREATE TRIGGER trg_records_rules
  BEFORE INSERT OR UPDATE ON records
  FOR EACH ROW
  EXECUTE FUNCTION dh_enforce_record_rules();


-- ============================================================================
-- 7. SERVER TIMESTAMPS
-- ============================================================================

-- Server-side timestamp on every records write (field device clocks are
-- unreliable). Incremental pull keys off this.
CREATE OR REPLACE FUNCTION update_synced_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.synced_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_records_synced_at ON records;
CREATE TRIGGER trg_records_synced_at
  BEFORE INSERT OR UPDATE ON records
  FOR EACH ROW
  EXECUTE FUNCTION update_synced_at();

-- v4: config.updated_at is now trigger-maintained, so devices can detect
-- config changes reliably (v3 left it to the client and it drifted).
CREATE OR REPLACE FUNCTION dh_touch_config_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_config_updated_at ON config;
CREATE TRIGGER trg_config_updated_at
  BEFORE INSERT OR UPDATE ON config
  FOR EACH ROW
  EXECUTE FUNCTION dh_touch_config_updated_at();


-- ============================================================================
-- 8. CONFIG RULES TRIGGER
--
-- The orgMode row is the master switch, so it gets special handling:
-- - The shared key can never flip the org into clinic mode (that would
--   lock every field device out: a denial of service by anyone holding
--   the key).
-- - Only an admin account can change the mode in either direction.
--   Flipping BACK to field mode through the app is deliberately allowed
--   for admins: it is the recovery path when records were stranded on
--   field devices, and SETUP.md documents the sequence. It reopens the
--   shared-key surface, so the app must confirm loudly.
-- ============================================================================

CREATE OR REPLACE FUNCTION dh_enforce_config_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF NEW.key = 'orgMode' THEN
    IF COALESCE(NEW.value->>'mode', 'field') <> 'field' AND NOT dh_is_admin() THEN
      RAISE EXCEPTION 'Only an administrator account can switch this organization to clinic mode.';
    END IF;
    IF TG_OP = 'UPDATE'
       AND COALESCE(OLD.value->>'mode', 'field') = 'clinic'
       AND COALESCE(NEW.value->>'mode', 'field') <> 'clinic'
       AND NOT dh_is_admin() THEN
      RAISE EXCEPTION 'Only an administrator account can change this organization''s mode.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_config_rules ON config;
CREATE TRIGGER trg_config_rules
  BEFORE INSERT OR UPDATE ON config
  FOR EACH ROW
  EXECUTE FUNCTION dh_enforce_config_rules();


-- ============================================================================
-- 9. ROW LEVEL SECURITY
--
-- anon policies = FIELD MODE, gated on dh_org_mode(); they reproduce v3.0
-- exactly while the org is in field mode and evaporate in clinic mode
-- (single exception: the orgMode config row stays anon-readable for
-- bootstrap discovery).
-- authenticated policies = staff accounts; they work in BOTH modes (see
-- header) but are inert until the SQL-editor bootstrap creates an admin.
-- WITH CHECK is always spelled out rather than left implicit, so a later
-- edit to USING cannot silently widen what may be written.
-- No DELETE for app roles anywhere: records use the soft-delete flag.
-- ============================================================================

ALTER TABLE records ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
ALTER TABLE users_profiles ENABLE ROW LEVEL SECURITY;

-- ---- records: field mode (anon) ----
DROP POLICY IF EXISTS "anon_read_records" ON records;
CREATE POLICY "anon_read_records" ON records
  FOR SELECT TO anon
  USING ((SELECT dh_org_mode()) = 'field');

DROP POLICY IF EXISTS "anon_insert_records" ON records;
CREATE POLICY "anon_insert_records" ON records
  FOR INSERT TO anon
  WITH CHECK (
    (SELECT dh_org_mode()) = 'field'
    AND device_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id AND d.revoked_at IS NULL)
  );

DROP POLICY IF EXISTS "anon_update_records" ON records;
CREATE POLICY "anon_update_records" ON records
  FOR UPDATE TO anon
  USING (
    (SELECT dh_org_mode()) = 'field'
    AND device_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id AND d.revoked_at IS NULL)
  )
  WITH CHECK (
    (SELECT dh_org_mode()) = 'field'
    AND device_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id AND d.revoked_at IS NULL)
  );

-- ---- records: staff accounts (authenticated) ----
-- Helpers are wrapped in scalar subqueries so they evaluate once per
-- statement (initplan), not once per row - same pattern as the anon
-- policies' dh_org_mode() calls.
DROP POLICY IF EXISTS "auth_read_records" ON records;
CREATE POLICY "auth_read_records" ON records
  FOR SELECT TO authenticated
  USING ((SELECT dh_active_profile()));

DROP POLICY IF EXISTS "auth_insert_records" ON records;
CREATE POLICY "auth_insert_records" ON records
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT dh_active_profile())
    AND user_id = auth.uid()
    AND device_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id AND d.revoked_at IS NULL)
  );

DROP POLICY IF EXISTS "auth_update_records" ON records;
CREATE POLICY "auth_update_records" ON records
  FOR UPDATE TO authenticated
  USING ((SELECT dh_active_profile()))
  WITH CHECK (
    (SELECT dh_active_profile())
    AND device_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id AND d.revoked_at IS NULL)
  );

-- ---- devices ----
-- anon read is field-mode only. (The device-rules trigger's admin-count
-- SELECT runs as the caller, but anon can only reach that trigger through
-- the field-gated insert/update policies, so gating the read costs
-- nothing and stops clinic-mode fleet enumeration by old key holders.)
DROP POLICY IF EXISTS "anon_read_devices" ON devices;
CREATE POLICY "anon_read_devices" ON devices
  FOR SELECT TO anon
  USING ((SELECT dh_org_mode()) = 'field');

DROP POLICY IF EXISTS "anon_insert_devices" ON devices;
CREATE POLICY "anon_insert_devices" ON devices
  FOR INSERT TO anon
  WITH CHECK ((SELECT dh_org_mode()) = 'field');

DROP POLICY IF EXISTS "anon_update_devices" ON devices;
CREATE POLICY "anon_update_devices" ON devices
  FOR UPDATE TO anon
  USING ((SELECT dh_org_mode()) = 'field')
  WITH CHECK ((SELECT dh_org_mode()) = 'field');

DROP POLICY IF EXISTS "auth_read_devices" ON devices;
CREATE POLICY "auth_read_devices" ON devices
  FOR SELECT TO authenticated
  USING ((SELECT dh_active_profile()));

DROP POLICY IF EXISTS "auth_insert_devices" ON devices;
CREATE POLICY "auth_insert_devices" ON devices
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT dh_active_profile()));

DROP POLICY IF EXISTS "auth_update_devices" ON devices;
CREATE POLICY "auth_update_devices" ON devices
  FOR UPDATE TO authenticated
  USING ((SELECT dh_active_profile()))
  WITH CHECK ((SELECT dh_active_profile()));

-- ---- config ----
-- anon: full read in field mode; in clinic mode exactly ONE row stays
-- visible (orgMode), so a device holding only URL + key can discover it
-- must show the sign-in screen. Config never carries credentials
-- (working rule, enforced by review).
DROP POLICY IF EXISTS "anon_read_config" ON config;
CREATE POLICY "anon_read_config" ON config
  FOR SELECT TO anon
  USING ((SELECT dh_org_mode()) = 'field' OR key = 'orgMode');

DROP POLICY IF EXISTS "anon_write_config" ON config;
CREATE POLICY "anon_write_config" ON config
  FOR INSERT TO anon
  WITH CHECK ((SELECT dh_org_mode()) = 'field');

DROP POLICY IF EXISTS "anon_update_config" ON config;
CREATE POLICY "anon_update_config" ON config
  FOR UPDATE TO anon
  USING ((SELECT dh_org_mode()) = 'field')
  WITH CHECK ((SELECT dh_org_mode()) = 'field');

-- Staff read config once active; pending accounts see only orgMode.
DROP POLICY IF EXISTS "auth_read_config" ON config;
CREATE POLICY "auth_read_config" ON config
  FOR SELECT TO authenticated
  USING ((SELECT dh_active_profile()) OR key = 'orgMode');

-- Staff config writes are ADMIN ONLY - tighter than field mode, where the
-- client gates admin actions (documented honest limit).
DROP POLICY IF EXISTS "auth_write_config" ON config;
CREATE POLICY "auth_write_config" ON config
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT dh_is_admin()));

DROP POLICY IF EXISTS "auth_update_config" ON config;
CREATE POLICY "auth_update_config" ON config
  FOR UPDATE TO authenticated
  USING ((SELECT dh_is_admin()))
  WITH CHECK ((SELECT dh_is_admin()));

-- ---- users_profiles ----
-- Active staff see the roster (the flow board shows names). A pending or
-- revoked account sees ONLY its own row (the app needs it to render the
-- "awaiting approval" screen). anon sees nothing.
DROP POLICY IF EXISTS "auth_read_profiles" ON users_profiles;
CREATE POLICY "auth_read_profiles" ON users_profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR (SELECT dh_active_profile()));

-- Signup normally flows through the auth trigger; direct insert is limited
-- to the caller's own row and the rules trigger forces it pending.
DROP POLICY IF EXISTS "auth_insert_profiles" ON users_profiles;
CREATE POLICY "auth_insert_profiles" ON users_profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

-- Self-edits (display name, station role) plus admin edits of anyone;
-- the rules trigger decides which FIELDS each caller may change.
DROP POLICY IF EXISTS "auth_update_profiles" ON users_profiles;
CREATE POLICY "auth_update_profiles" ON users_profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR (SELECT dh_is_admin()))
  WITH CHECK (id = auth.uid() OR (SELECT dh_is_admin()));

-- ---- no hard deletes, any table, any app role ----
DROP POLICY IF EXISTS "no_delete_records" ON records;
CREATE POLICY "no_delete_records" ON records FOR DELETE USING (false);
DROP POLICY IF EXISTS "no_delete_devices" ON devices;
CREATE POLICY "no_delete_devices" ON devices FOR DELETE USING (false);
DROP POLICY IF EXISTS "no_delete_config" ON config;
CREATE POLICY "no_delete_config" ON config FOR DELETE USING (false);
DROP POLICY IF EXISTS "no_delete_profiles" ON users_profiles;
CREATE POLICY "no_delete_profiles" ON users_profiles FOR DELETE USING (false);


-- ============================================================================
-- 10. INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_records_date ON records (date);
CREATE INDEX IF NOT EXISTS idx_records_site ON records (site);
CREATE INDEX IF NOT EXISTS idx_records_deleted ON records (deleted);
CREATE INDEX IF NOT EXISTS idx_records_device_id ON records (device_id);
CREATE INDEX IF NOT EXISTS idx_records_saved_at ON records (saved_at);
CREATE INDEX IF NOT EXISTS idx_records_mrn ON records (mrn);
CREATE INDEX IF NOT EXISTS idx_records_referral_type ON records (referral_type);
CREATE INDEX IF NOT EXISTS idx_records_referral_date ON records (referral_date);
CREATE INDEX IF NOT EXISTS idx_records_provider ON records (provider);
CREATE INDEX IF NOT EXISTS idx_records_synced_at ON records (synced_at);
-- v4: the two indexes that previously existed only in migrations, plus
-- keyset pull and flow board support.
CREATE INDEX IF NOT EXISTS idx_records_template_id ON records (template_id);
CREATE INDEX IF NOT EXISTS idx_devices_active ON devices (id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_records_synced_at_id ON records (synced_at, id);
CREATE INDEX IF NOT EXISTS idx_records_date_flow ON records (date, flow_station);


-- ============================================================================
-- 11. REALTIME
-- Optional but recommended. Without this a device subscribes successfully
-- and shows Live while never receiving anything, so records only move on
-- the periodic sync. Safe to re-run. devices and users_profiles are
-- deliberately NOT published: revocation lands on the next write or sync.
-- Realtime respects RLS, so clinic-mode anon subscribers receive nothing
-- from records and only the orgMode row from config.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'records') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.records;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'config') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.config;
    END IF;
  END IF;
END $$;
