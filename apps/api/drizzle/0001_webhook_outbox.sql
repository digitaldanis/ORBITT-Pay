ALTER TABLE merchants ADD COLUMN default_webhook_url text;
ALTER TABLE merchants ADD COLUMN webhook_secret_ciphertext text;

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  invoice_id uuid REFERENCES invoices(id),
  event_type varchar(80) NOT NULL,
  target_url text NOT NULL,
  secret_ciphertext text NOT NULL,
  payload jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  delivered_at timestamptz,
  last_http_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX webhook_deliveries_merchant_created_idx ON webhook_deliveries (merchant_id, created_at DESC);

CREATE TABLE webhook_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  http_status integer,
  response_excerpt text,
  error text,
  CONSTRAINT webhook_delivery_attempts_delivery_attempt_unique UNIQUE (delivery_id, attempt_number)
);
