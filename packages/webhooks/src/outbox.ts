import { INVOICE_COLUMNS_I, serializeInvoice, type AssetDefinition, type InvoiceRow } from '@orbitt/core';

/** Minimal query surface shared by `pg` clients, so this package needs no driver dependency. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Queues a signed-webhook delivery for an invoice event. Call it inside the same transaction
 * that changes the invoice so the event and the state change commit together (outbox pattern).
 */
export async function enqueueInvoiceEvent(
  client: Queryable,
  catalog: readonly AssetDefinition[],
  invoiceId: string,
  eventType: string,
): Promise<void> {
  const selected = await client.query<InvoiceRow & { webhook_url: string | null; default_webhook_url: string | null; webhook_secret_ciphertext: string | null }>(
    `SELECT ${INVOICE_COLUMNS_I}, i.webhook_url, m.default_webhook_url, m.webhook_secret_ciphertext
     FROM invoices i JOIN merchants m ON m.id = i.merchant_id WHERE i.id = $1`, [invoiceId],
  );
  const row = selected.rows[0];
  const targetUrl = row?.webhook_url ?? row?.default_webhook_url ?? null;
  if (!row || !targetUrl || !row.webhook_secret_ciphertext) return;
  const payload = { event: eventType, created_at: new Date().toISOString(), invoice: serializeInvoice(row, catalog) };
  await client.query(
    // clock_timestamp(), unlike now(), advances within a transaction, so events written together
    // (e.g. detected then underpaid) keep their order for delivery and in the dashboard.
    `INSERT INTO webhook_deliveries (merchant_id, invoice_id, event_type, target_url, secret_ciphertext, payload, created_at, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(), clock_timestamp())`,
    [row.merchant_id, invoiceId, eventType, targetUrl, row.webhook_secret_ciphertext, JSON.stringify(payload)],
  );
}
