/**
 * Confirmations a transfer needs before an invoice counts as paid. TRON history is read with
 * only_confirmed=true (solidified) and Solana with the finalized commitment, so one observation
 * is already final there.
 */
export const DEFAULT_CONFIRMATIONS: Readonly<Record<string, number>> = {
  bitcoin: 2, 'bitcoin-testnet': 2, litecoin: 6,
  ethereum: 12, 'ethereum-sepolia': 2, base: 10, arbitrum: 10, optimism: 10, polygon: 64, 'bnb-chain': 15,
  tron: 1, solana: 1,
};

/** Typical seconds per confirmation, used only to show customers an estimate. */
export const SECONDS_PER_CONFIRMATION: Readonly<Record<string, number>> = {
  bitcoin: 600, 'bitcoin-testnet': 600, litecoin: 150,
  ethereum: 12, 'ethereum-sepolia': 12, base: 2, arbitrum: 0.25, optimism: 2, polygon: 2, 'bnb-chain': 0.75,
  tron: 60, solana: 15,
};

/** Required confirmations for a network; `CONFIRMATIONS_<NETWORK>` (e.g. CONFIRMATIONS_BNB_CHAIN) overrides the default. */
export function requiredConfirmations(network: string, env: Readonly<Record<string, string | undefined>> = process.env): number {
  const override = env[`CONFIRMATIONS_${network.toUpperCase().replace(/-/g, '_')}`];
  if (override !== undefined && /^\d+$/.test(override) && Number(override) > 0 && Number(override) <= 10_000) return Number(override);
  return DEFAULT_CONFIRMATIONS[network] ?? 1;
}

/** Rough seconds until `remaining` more confirmations, or null when the network has no estimate. */
export function confirmationEta(network: string, remaining: number): number | null {
  const seconds = SECONDS_PER_CONFIRMATION[network];
  if (seconds === undefined) return null;
  return Math.max(0, Math.ceil(remaining * seconds));
}
