-- Amounts are stored as text so they never pass through a float. Make sure they are always
-- non-negative integers (base units) or plain decimals (request amount).
ALTER TABLE invoices ADD CONSTRAINT invoices_base_units_check CHECK (
  received_amount_base_units ~ '^[0-9]{1,78}$'
  AND surplus_base_units ~ '^[0-9]{1,78}$'
  AND (crypto_amount_base_units IS NULL OR crypto_amount_base_units ~ '^[0-9]{1,78}$')
);
ALTER TABLE invoices ADD CONSTRAINT invoices_request_amount_check CHECK (request_amount ~ '^[0-9]{1,30}(\.[0-9]{1,18})?$');
ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_amount_check CHECK (amount_base_units ~ '^[0-9]{1,78}$');
ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_confirmations_check CHECK (confirmations >= 0);

-- Lifecycle timestamps. `updated_at` moves whenever a late transfer or a confirmation refresh
-- touches a row, so reporting by "day paid" needs its own column.
ALTER TABLE invoices ADD COLUMN paid_at timestamptz;
ALTER TABLE invoices ADD COLUMN closed_at timestamptz;
UPDATE invoices SET paid_at = updated_at WHERE status = 'paid';
UPDATE invoices SET closed_at = updated_at WHERE status IN ('paid', 'expired', 'late_payment', 'cancelled');
CREATE INDEX invoices_merchant_paid_idx ON invoices (merchant_id, paid_at DESC) WHERE paid_at IS NOT NULL;

CREATE FUNCTION orbitt_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION orbitt_invoice_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'paid' AND NEW.paid_at IS NULL THEN NEW.paid_at := now(); END IF;
    IF NEW.status IN ('paid', 'expired', 'late_payment', 'cancelled') AND NEW.closed_at IS NULL THEN NEW.closed_at := now(); END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER invoices_lifecycle BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION orbitt_invoice_lifecycle();
CREATE TRIGGER invoice_payments_touch BEFORE UPDATE ON invoice_payments FOR EACH ROW EXECUTE FUNCTION orbitt_touch_updated_at();
CREATE TRIGGER merchant_wallets_touch BEFORE UPDATE ON merchant_wallets FOR EACH ROW EXECUTE FUNCTION orbitt_touch_updated_at();

-- Every status an invoice passes through, written by the database itself so no code path can
-- change a status without leaving a trace. Feeds the invoice timeline in the dashboard.
CREATE TABLE invoice_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  from_status invoice_status,
  to_status invoice_status NOT NULL,
  received_amount_base_units text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX invoice_status_history_invoice_idx ON invoice_status_history (invoice_id, id);

CREATE FUNCTION orbitt_record_invoice_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO invoice_status_history (invoice_id, merchant_id, from_status, to_status, received_amount_base_units)
    VALUES (NEW.id, NEW.merchant_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, NEW.received_amount_base_units);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER invoices_status_history AFTER INSERT OR UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION orbitt_record_invoice_status();

-- Existing invoices get their creation and, if it moved on, their current status.
INSERT INTO invoice_status_history (invoice_id, merchant_id, from_status, to_status, received_amount_base_units, created_at)
SELECT id, merchant_id, NULL, 'created', '0', created_at FROM invoices WHERE status = 'created' OR payment_selected_at IS NULL;
INSERT INTO invoice_status_history (invoice_id, merchant_id, from_status, to_status, received_amount_base_units, created_at)
SELECT id, merchant_id, NULL, 'awaiting_payment', '0', coalesce(payment_selected_at, created_at)
FROM invoices WHERE status <> 'created' AND payment_selected_at IS NOT NULL;
INSERT INTO invoice_status_history (invoice_id, merchant_id, from_status, to_status, received_amount_base_units, created_at)
SELECT id, merchant_id, NULL, status, received_amount_base_units, updated_at
FROM invoices WHERE status NOT IN ('created', 'awaiting_payment');

-- Append-only audit log of everything people and API keys change in a workspace. Each row stores
-- the SHA-256 of its content and of the previous row of the same merchant, so editing or deleting
-- a row breaks the chain and `orbitt_verify_audit_log` reports where.
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  actor_type varchar(16) NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id uuid,
  actor_label varchar(320),
  action varchar(64) NOT NULL,
  target_type varchar(32),
  target_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  previous_hash char(64) NOT NULL,
  hash char(64) NOT NULL
);
CREATE INDEX audit_log_merchant_idx ON audit_log (merchant_id, id DESC);
CREATE INDEX audit_log_merchant_action_idx ON audit_log (merchant_id, action, id DESC);

CREATE FUNCTION orbitt_audit_hash(entry audit_log) RETURNS char(64) LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    entry.previous_hash, entry.merchant_id::text, entry.actor_type, coalesce(entry.actor_id::text, ''),
    coalesce(entry.actor_label, ''), entry.action, coalesce(entry.target_type, ''), coalesce(entry.target_id, ''),
    entry.details::text, coalesce(host(entry.ip), ''),
    to_char(entry.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8')), 'hex')
$$;

CREATE FUNCTION orbitt_audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialise writers per merchant so two concurrent entries cannot link to the same parent.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_log:' || NEW.merchant_id::text, 0));
  SELECT a.hash INTO NEW.previous_hash FROM audit_log a WHERE a.merchant_id = NEW.merchant_id ORDER BY a.id DESC LIMIT 1;
  NEW.previous_hash := coalesce(NEW.previous_hash, repeat('0', 64));
  NEW.created_at := clock_timestamp();
  NEW.hash := orbitt_audit_hash(NEW);
  RETURN NEW;
END $$;

CREATE FUNCTION orbitt_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION orbitt_audit_chain();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION orbitt_audit_immutable();

-- Returns the id of the first entry whose hash or link does not match, or NULL if the chain is intact.
CREATE FUNCTION orbitt_verify_audit_log(target_merchant uuid) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  entry audit_log;
  expected char(64) := repeat('0', 64);
BEGIN
  FOR entry IN SELECT * FROM audit_log WHERE merchant_id = target_merchant ORDER BY id LOOP
    IF entry.previous_hash <> expected OR entry.hash <> orbitt_audit_hash(entry) THEN RETURN entry.id; END IF;
    expected := entry.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- Foreign keys PostgreSQL does not index on its own.
CREATE INDEX api_keys_merchant_idx ON api_keys (merchant_id, created_at DESC);
CREATE INDEX merchant_users_merchant_idx ON merchant_users (merchant_id);
CREATE INDEX dashboard_sessions_user_idx ON dashboard_sessions (user_id);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);
