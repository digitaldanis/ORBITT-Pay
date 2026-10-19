import { useMemo, useState, type FormEvent } from 'react';
import { KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { CoinIcon } from '@orbitt/ui';
import { api, errorMessage, type Account, type AssetFamily, type CatalogAsset, type NetworkHealth, type Wallet } from '../api.js';
import { middleTruncate, relativeTime } from '../format.js';
import { Banner, Loading, Modal, PageHeader } from '../ui.js';
import { useCatalog } from '../catalog.js';

interface NetworkWallet { native: CatalogAsset; tokens: CatalogAsset[]; wallet: Wallet | undefined; health: NetworkHealth | undefined }

const KEY_HELP: Record<AssetFamily, { label: string; placeholder: string; hint: string }> = {
  utxo: { label: 'Account public key', placeholder: 'zpub6r… or xpub6C…', hint: 'Native SegWit account key (BIP84). Export it from your hardware or desktop wallet.' },
  evm: { label: 'Account public key', placeholder: 'xpub6D…', hint: 'Account key for m/44\'/60\'/0\'. One key covers the coin and its tokens on this network.' },
  tron: { label: 'Account public key', placeholder: 'xpub6D…', hint: 'Account key for m/44\'/195\'/0\'. Covers TRX and TRC-20 tokens.' },
  solana: { label: 'Wallet address', placeholder: 'J6Szzp…', hint: 'Your regular Solana address. Each payment is identified by its exact amount, and tokens arrive in its token accounts.' },
};

const FAMILY_LABEL: Record<AssetFamily, string> = { utxo: 'Unique address per invoice', evm: 'Unique address per invoice', tron: 'Unique address per invoice', solana: 'One address, unique amount' };

function HealthLine({ health }: { health: NetworkHealth | undefined }) {
  if (!health) return <span className="health idle"><i />Waiting for the scanner</span>;
  if (!health.healthy) return <span className="health down" title={health.last_error ?? undefined}><i />{health.last_error ? 'Scanner error' : 'Scanner stalled'} · {relativeTime(health.last_scan_at)}</span>;
  return <span className="health up"><i />Live{health.head_block ? ` · block ${Number(health.head_block).toLocaleString()}` : ''} · {relativeTime(health.last_scan_at)}</span>;
}

function WalletModal({ entry, onClose, onSaved }: { entry: NetworkWallet; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const help = KEY_HELP[entry.native.family];
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    const key = entry.native.address_mode === 'shared' ? 'address' : 'extended_public_key';
    try {
      await api('/v1/dashboard/account/wallets', { method: 'PUT', body: JSON.stringify({ wallets: [{ asset: entry.native.asset, network: entry.native.network, [key]: value.trim() }] }) });
      await onSaved(`${entry.native.network_name} wallet saved.`);
      onClose();
    } catch (cause) { setError(errorMessage(cause, 'The wallet could not be saved.')); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={`${entry.wallet ? 'Replace' : 'Add'} ${entry.native.network_name} wallet`} description={`Receives ${[entry.native, ...entry.tokens].map((asset) => asset.asset).join(', ')}.`} onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <div className="notice"><ShieldCheck size={16} /><span>Only public data. Never enter a seed phrase or private key. ORBITT PAY cannot move your funds.</span></div>
        <label>{help.label}<textarea rows={3} autoFocus required spellCheck={false} autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} placeholder={help.placeholder} className="mono" /></label>
        <p className="field-hint">{help.hint}{entry.native.family === 'utxo' && ` Path m/84'/${entry.native.asset === 'LTC' ? 2 : 0}'/0'.`}</p>
        {entry.wallet && entry.native.address_mode === 'derived' && <p className="field-hint warning">A new key starts address derivation from index 0. It can only be changed while no invoice on this network is open.</p>}
        {error && <Banner tone="error">{error}</Banner>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || !value.trim()}>{busy ? 'Verifying…' : 'Save wallet'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function AssetsPage({ account, reloadAccount }: { account: Account | null; reloadAccount: () => Promise<void> }) {
  const catalog = useCatalog();
  const [editing, setEditing] = useState<NetworkWallet | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const entries = useMemo<NetworkWallet[]>(() => catalog.assets
    .filter((asset) => asset.enabled && asset.asset === asset.wallet_asset)
    .map((native) => ({
      native,
      tokens: catalog.assets.filter((asset) => asset.enabled && asset.network === native.network && asset.wallet_asset === native.asset && asset.asset !== native.asset),
      wallet: account?.wallets.find((wallet) => wallet.asset === native.asset && wallet.network === native.network),
      health: catalog.networks.find((network) => network.network === native.network),
    })), [catalog.assets, catalog.networks, account]);

  const saved = async (text: string) => { setMessage(text); setError(''); await Promise.all([reloadAccount(), catalog.reload()]); };
  const remove = async (entry: NetworkWallet) => {
    if (!window.confirm(`Remove the ${entry.native.network_name} wallet? Customers can no longer pay with ${[entry.native, ...entry.tokens].map((asset) => asset.asset).join(', ')} on this network.`)) return;
    setMessage(''); setError('');
    try {
      await api(`/v1/dashboard/account/wallets/${encodeURIComponent(entry.native.asset)}/${encodeURIComponent(entry.native.network)}`, { method: 'DELETE' });
      await saved(`${entry.native.network_name} wallet removed.`);
    } catch (cause) { setError(errorMessage(cause, 'The wallet could not be removed.')); }
  };

  const ready = entries.filter((entry) => entry.wallet).length;
  const coins = catalog.assets.filter((asset) => asset.available).length;

  return <>
    <PageHeader title="Assets" description="Connect a public key per network. Every coin and token on that network is then ready for checkout." />
    {message && <Banner tone="success" onDismiss={() => setMessage('')}>{message}</Banner>}
    {(error || catalog.error) && <Banner tone="error" onDismiss={() => setError('')}>{error || catalog.error}</Banner>}
    <div className="summary-strip">
      <div><strong>{ready}</strong><span>of {entries.length} networks connected</span></div>
      <div><strong>{coins}</strong><span>coins and tokens accepted</span></div>
      <div><ShieldCheck size={16} /><span>Non-custodial. Payments settle directly in your wallets.</span></div>
    </div>
    {catalog.loading && !entries.length ? <Loading label="Loading networks…" /> : (
      <div className="network-grid">
        {entries.map((entry) => (
          <article key={entry.native.network} className={`network-card${entry.wallet ? ' connected' : ''}`}>
            <header>
              <CoinIcon asset={entry.native.asset} size={38} />
              <div className="network-title"><strong>{entry.native.network_name}</strong><span>{FAMILY_LABEL[entry.native.family]}</span></div>
              {entry.wallet ? <span className="badge tone-success"><i />Connected</span> : <span className="badge tone-neutral"><i />Not connected</span>}
            </header>
            <div className="asset-chips">
              {[entry.native, ...entry.tokens].map((asset) => (
                <span key={asset.asset} className={`asset-chip${asset.available ? ' on' : ''}`} title={asset.contract ? `Contract ${asset.contract}` : asset.name}>
                  <CoinIcon asset={asset.asset} network={asset.network} size={18} />{asset.asset}
                </span>
              ))}
            </div>
            {entry.wallet ? (
              <div className="wallet-key">
                <KeyRound size={14} />
                <span className="mono">{middleTruncate(entry.wallet.public_key_hint, 10, 8)}</span>
                {entry.native.address_mode === 'derived' && <span className="muted">· next index {entry.wallet.next_derivation_index}</span>}
              </div>
            ) : <p className="muted small-text">{entry.native.address_mode === 'shared' ? 'Connect your wallet address' : 'Connect an account public key'} to accept these assets.</p>}
            <footer>
              <HealthLine health={entry.health} />
              <div className="inline-actions">
                {entry.wallet && <button className="icon-button" onClick={() => void remove(entry)} aria-label={`Remove ${entry.native.network_name} wallet`} title="Remove"><Trash2 size={14} /></button>}
                <button className={entry.wallet ? 'secondary-button small' : 'primary-button small'} onClick={() => setEditing(entry)}>{entry.wallet ? 'Replace' : <><Plus size={13} />Connect</>}</button>
              </div>
            </footer>
          </article>
        ))}
      </div>
    )}
    {editing && <WalletModal entry={editing} onClose={() => setEditing(null)} onSaved={saved} />}
  </>;
}
