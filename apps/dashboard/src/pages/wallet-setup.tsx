import { useMemo, useState } from 'react';
import { Check, Copy, Eye, EyeOff, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { CoinIcon } from '@orbitt/ui';
import { createRecoveryPhrase, deriveWalletPublicKeys, WALLET_PATHS, walletKeyForNetwork } from '@orbitt/chains/wallet';
import { api, errorMessage, type CatalogAsset } from '../api.js';
import { Banner, Modal } from '../ui.js';

type Step = 'intro' | 'phrase' | 'verify' | 'done';

export interface SetupNetwork { native: CatalogAsset; tokens: CatalogAsset[]; connected: boolean }

function pickPositions(count: number, words: number): number[] {
  const positions = new Set<number>();
  const random = new Uint32Array(1);
  while (positions.size < count) {
    crypto.getRandomValues(random);
    positions.add(random[0]! % words);
  }
  return [...positions].sort((a, b) => a - b);
}

const IMPORT_HINTS: Array<{ label: string; path: string; apps: string }> = [
  { label: 'Bitcoin', path: `${WALLET_PATHS.bitcoin}/0/i`, apps: 'Sparrow, Electrum (BIP39, native SegWit), BlueWallet' },
  { label: 'Litecoin', path: `${WALLET_PATHS.litecoin}/0/i`, apps: 'Electrum-LTC (BIP39, native SegWit)' },
  { label: 'Ethereum and EVM chains', path: `${WALLET_PATHS.evm}/0/i`, apps: 'MetaMask, Rabby: invoice i is account i + 1' },
  { label: 'TRON', path: `${WALLET_PATHS.tron}/0/i`, apps: 'TronLink: invoice i is account i + 1' },
  { label: 'Solana', path: WALLET_PATHS.solana, apps: 'Phantom, Solflare: first account' },
];

/**
 * Creates a new wallet in this browser and connects its public keys. The recovery phrase is
 * generated and kept only in this component's memory; the server receives xpubs and addresses.
 */
export function CreateWalletModal({ networks, onClose, onSaved }: { networks: SetupNetwork[]; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const open = useMemo(() => networks.filter((network) => !network.connected), [networks]);
  const [step, setStep] = useState<Step>('intro');
  const [length, setLength] = useState<12 | 24>(12);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(open.map((network) => network.native.network)));
  const [phrase, setPhrase] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [stored, setStored] = useState(false);
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState<string[]>([]);
  const words = phrase ? phrase.split(' ') : [];

  const close = () => { setPhrase(''); setAnswers({}); onClose(); };
  const toggle = (network: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(network)) next.delete(network); else next.add(network);
    return next;
  });

  const generate = () => {
    setPhrase(createRecoveryPhrase(length));
    setRevealed(false); setStored(false); setError('');
    setStep('phrase');
  };
  const toVerify = () => { setPositions(pickPositions(3, words.length)); setAnswers({}); setStep('verify'); };
  const verified = positions.length > 0 && positions.every((position) => answers[position]?.trim().toLowerCase() === words[position]);

  const connect = async () => {
    setBusy(true); setError('');
    try {
      const keys = deriveWalletPublicKeys(phrase);
      const chosen = open.filter((network) => selected.has(network.native.network));
      const wallets = chosen.flatMap((network) => {
        const key = walletKeyForNetwork(keys, network.native.network);
        return key ? [{ asset: network.native.asset, network: network.native.network, ...key }] : [];
      });
      await api('/v1/dashboard/account/wallets', { method: 'PUT', body: JSON.stringify({ wallets }) });
      setConnected(chosen.map((network) => network.native.network_name));
      setPhrase(''); setAnswers({});
      setStep('done');
      await onSaved(`New wallet connected on ${chosen.length} ${chosen.length === 1 ? 'network' : 'networks'}.`);
    } catch (cause) { setError(errorMessage(cause, 'The wallet could not be connected.')); }
    finally { setBusy(false); }
  };

  if (step === 'intro') {
    return (
      <Modal title="Create a wallet" description="ORBITT PAY creates a new wallet right here in your browser and connects it to every network you pick." onClose={close}>
        <div className="form">
          <div className="notice"><ShieldCheck size={16} /><span>The 12 or 24 recovery words are created on this device and never sent to the server. Only public keys are stored, so ORBITT PAY can show addresses but can never move your funds.</span></div>
          {!open.length ? <Banner tone="success">Every network already has a wallet. Remove one under Assets to replace it.</Banner> : <>
            <fieldset className="choice-list">
              <legend>Networks</legend>
              {open.map((network) => (
                <label key={network.native.network} className="choice">
                  <input type="checkbox" checked={selected.has(network.native.network)} onChange={() => toggle(network.native.network)} />
                  <CoinIcon asset={network.native.asset} size={26} />
                  <span><strong>{network.native.network_name}</strong><small>{[network.native, ...network.tokens].map((asset) => asset.asset).join(', ')}</small></span>
                </label>
              ))}
            </fieldset>
            <div className="segmented" role="radiogroup" aria-label="Recovery phrase length">
              {([12, 24] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={length === value} className={length === value ? 'selected' : ''} onClick={() => setLength(value)}>{value} words</button>)}
            </div>
          </>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={close}>Cancel</button>
            <button type="button" className="primary-button" disabled={!open.length || !selected.size} onClick={generate}><Sparkles size={15} />Create wallet</button>
          </div>
        </div>
      </Modal>
    );
  }

  if (step === 'phrase') {
    return (
      <Modal title="Write down your recovery phrase" description="These words are the only way to access the money your customers send. Nobody, including ORBITT PAY, can recover them." onClose={close}>
        <div className="form">
          <div className="phrase-box">
            <ol className={`phrase-grid${revealed ? '' : ' is-hidden'}`} aria-label="Recovery phrase">
              {words.map((word, index) => <li key={index}><span>{index + 1}</span>{word}</li>)}
            </ol>
            {!revealed && <button type="button" className="secondary-button phrase-reveal" onClick={() => setRevealed(true)}><Eye size={15} />Show words</button>}
          </div>
          {revealed && <div className="inline-actions">
            <button type="button" className="secondary-button small" onClick={() => setRevealed(false)}><EyeOff size={13} />Hide</button>
            <button type="button" className="secondary-button small" onClick={() => void navigator.clipboard.writeText(phrase)}><Copy size={13} />Copy</button>
          </div>}
          <ul className="check-list warning-list">
            <li><TriangleAlert size={15} />Write the words on paper in this order and keep it offline. No screenshots, no cloud notes.</li>
            <li><TriangleAlert size={15} />Anyone with these words can take the funds. ORBITT PAY will never ask for them.</li>
          </ul>
          <label className="check-label"><input type="checkbox" checked={stored} onChange={(event) => setStored(event.target.checked)} />I have written down all {words.length} words in order</label>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => setStep('intro')}>Back</button>
            <button type="button" className="primary-button" disabled={!stored || !revealed} onClick={toVerify}>Continue</button>
          </div>
        </div>
      </Modal>
    );
  }

  if (step === 'verify') {
    return (
      <Modal title="Check your backup" description="Enter the requested words from your written copy." onClose={close}>
        <form className="form" onSubmit={(event) => { event.preventDefault(); if (verified) void connect(); }}>
          {positions.map((position, index) => (
            <label key={position}>Word #{position + 1}
              <input autoFocus={index === 0} autoComplete="off" autoCapitalize="none" spellCheck={false} value={answers[position] ?? ''}
                onChange={(event) => setAnswers((current) => ({ ...current, [position]: event.target.value }))}
                className={answers[position] && answers[position]!.trim().toLowerCase() === words[position] ? 'is-valid' : undefined} />
            </label>
          ))}
          {error && <Banner tone="error">{error}</Banner>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => setStep('phrase')}>Show words again</button>
            <button className="primary-button" disabled={!verified || busy}>{busy ? 'Connecting…' : 'Connect wallet'}</button>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="Wallet connected" description={`Ready on ${connected.join(', ')}.`} onClose={close}>
      <div className="form">
        <Banner tone="success">Customers can now pay on these networks. Every invoice gets its own address from this wallet.</Banner>
        <h3 className="section-title">Open the funds in a wallet app</h3>
        <p className="field-hint">Import your recovery phrase into a wallet app that uses these standard paths:</p>
        <div className="detail-list">
          {IMPORT_HINTS.map((hint) => (
            <div className="detail-row stacked" key={hint.label}>
              <span>{hint.label}</span>
              <div><code>{hint.path}</code><small>{hint.apps}</small></div>
            </div>
          ))}
        </div>
        <div className="notice"><TriangleAlert size={16} /><span>On EVM chains and TRON every invoice uses its own address. To move USDT or USDC from an address, that address needs a little ETH, POL, BNB or TRX for the network fee. The invoice drawer shows each invoice's wallet path.</span></div>
        <div className="modal-actions"><button type="button" className="primary-button" onClick={close}><Check size={15} />Done</button></div>
      </div>
    </Modal>
  );
}
