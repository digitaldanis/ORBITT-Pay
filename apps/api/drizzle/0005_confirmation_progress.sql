-- Confirmations an invoice needs, fixed when the coin is chosen so checkout, dashboard and
-- worker agree even if the operator changes CONFIRMATIONS_* later.
ALTER TABLE invoices ADD COLUMN required_confirmations integer;
ALTER TABLE invoices ADD CONSTRAINT invoices_required_confirmations_check CHECK (required_confirmations IS NULL OR required_confirmations > 0);
