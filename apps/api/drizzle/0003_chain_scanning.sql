CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  transaction_id varchar(128) NOT NULL,
  asset varchar(32) NOT NULL,
  amount_base_units text NOT NULL,
  confirmations bigint NOT NULL DEFAULT 0,
  block_number bigint,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_payments_transaction_unique UNIQUE (invoice_id, transaction_id, asset)
);

CREATE INDEX invoice_payments_invoice_idx ON invoice_payments (invoice_id, observed_at);
CREATE INDEX invoices_chain_scan_idx ON invoices (network, status, created_at) WHERE address IS NOT NULL;

CREATE TABLE chain_scan_cursors (
  network varchar(48) PRIMARY KEY,
  cursor_block bigint NOT NULL CHECK (cursor_block >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
