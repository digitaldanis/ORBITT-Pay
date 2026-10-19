-- Invoices may be created without a coin; the customer picks one on hosted checkout,
-- which locks the quote and assigns the payment address at that moment.
ALTER TABLE invoices ALTER COLUMN crypto_amount_base_units DROP NOT NULL;
ALTER TABLE invoices ALTER COLUMN crypto_amount DROP NOT NULL;
ALTER TABLE invoices ALTER COLUMN asset DROP NOT NULL;
ALTER TABLE invoices ALTER COLUMN network DROP NOT NULL;
ALTER TABLE invoices ADD COLUMN address_mode varchar(16) NOT NULL DEFAULT 'derived'
  CHECK (address_mode IN ('derived', 'shared'));
ALTER TABLE invoices ADD COLUMN payment_selected_at timestamptz;
ALTER TABLE invoices ADD CONSTRAINT invoices_selected_payment_check CHECK (
  status = 'created' OR status = 'cancelled' OR status = 'expired'
  OR (asset IS NOT NULL AND network IS NOT NULL AND crypto_amount_base_units IS NOT NULL AND address IS NOT NULL)
);

-- Derived addresses are unique per open invoice. Shared addresses (Solana) are reused, so the
-- payable amount must be unique per open invoice on that address instead.
DROP INDEX invoices_open_address_unique;
CREATE UNIQUE INDEX invoices_open_address_unique ON invoices (address, asset, network)
  WHERE address IS NOT NULL AND address_mode = 'derived'
    AND status IN ('created', 'awaiting_payment', 'detected', 'confirming', 'underpaid', 'overpaid');
CREATE UNIQUE INDEX invoices_open_shared_amount_unique ON invoices (address, asset, network, crypto_amount_base_units)
  WHERE address IS NOT NULL AND address_mode = 'shared'
    AND status IN ('created', 'awaiting_payment', 'detected', 'confirming', 'underpaid', 'overpaid');

-- Signature/transaction cursors for account-history scanners (Solana shared addresses).
CREATE TABLE address_scan_cursors (
  network varchar(48) NOT NULL,
  watch_address text NOT NULL,
  cursor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, watch_address)
);

CREATE INDEX webhook_deliveries_invoice_idx ON webhook_deliveries (invoice_id, created_at DESC) WHERE invoice_id IS NOT NULL;
CREATE INDEX invoices_merchant_status_idx ON invoices (merchant_id, status, created_at DESC);

-- Worker heartbeat per network, so checkout only offers networks that are actually watched.
CREATE TABLE network_scanner_status (
  network varchar(48) PRIMARY KEY,
  head_block text,
  last_scan_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);

CREATE INDEX invoices_network_address_idx ON invoices (network, lower(address)) WHERE address IS NOT NULL;
