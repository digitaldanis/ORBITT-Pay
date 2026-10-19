export interface ChainTransfer {
  transactionId: string;
  asset: string;
  network: string;
  address: string;
  amountBaseUnits: bigint;
  blockNumber: bigint | null;
  confirmations: bigint;
  observedAt: Date;
}
