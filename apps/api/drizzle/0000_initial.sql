CREATE TYPE invoice_status AS ENUM (
  'created', 'awaiting_payment', 'detected', 'confirming', 'paid',
  'underpaid', 'overpaid', 'expired', 'late_payment', 'cancelled'
);

CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  order_id varchar(255),
  fiat_amount text,
  fiat_currency varchar(3),
  rate_used text,
  rate_timestamp timestamptz,
  crypto_amount_base_units text NOT NULL,
  received_amount_base_units text NOT NULL DEFAULT '0',
  surplus_base_units text NOT NULL DEFAULT '0',
  asset varchar(32) NOT NULL,
  network varchar(48) NOT NULL,
  address text,
  derivation_path text,
  status invoice_status NOT NULL DEFAULT 'created',
  expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invoices_merchant_created_idx ON invoices (merchant_id, created_at DESC);
CREATE INDEX invoices_expiry_idx ON invoices (expires_at) WHERE status IN ('created', 'awaiting_payment', 'underpaid');
CREATE UNIQUE INDEX invoices_open_address_unique ON invoices (address, asset, network)
  WHERE address IS NOT NULL AND status IN ('created', 'awaiting_payment', 'detected', 'confirming', 'underpaid', 'overpaid');

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  key varchar(255) NOT NULL,
  request_hash varchar(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_merchant_key_unique UNIQUE (merchant_id, key)
);
