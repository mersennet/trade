'use client';
import { useState, useEffect } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useStore } from '@/stores/useStore';
import { shortenAddress, cn } from '@/lib/utils';

/**
 * Sub-accounts.
 *
 * Mersennet orders are now wallet-signed transactions to the CLOB precompile —
 * the trading identity IS the connected wallet (msg.sender). A separate
 * "sub-account" is therefore just another wallet address you connect.
 *
 * We deliberately do NOT generate or store private keys in the browser: a prior
 * version wrote raw `ethers.Wallet.createRandom()` keys into localStorage, which
 * any XSS or malicious extension could exfiltrate to drain funds. Keys must live
 * in a real wallet (MetaMask account, hardware wallet, etc.), never in web
 * storage.
 */

// Only non-sensitive labels are persisted — addresses the user wants to track.
interface SubAccountLabel {
  name: string;
  address: string;
}

const LABELS_KEY = 'pt_sub_account_labels';

export default function SubAccountsPage() {
  const { address, isConnected } = useWallet();
  const { sessionKey } = useStore();
  const [labels, setLabels] = useState<SubAccountLabel[]>([]);
  const [newName, setNewName] = useState('');
  const [newAddress, setNewAddress] = useState('');

  useEffect(() => {
    // One-time cleanup: purge any plaintext keys written by the old version.
    localStorage.removeItem('pt_sub_accounts');
    localStorage.removeItem('pt_active_sub');
    const saved = localStorage.getItem(LABELS_KEY);
    if (saved) { try { setLabels(JSON.parse(saved)); } catch { /* ignore */ } }
  }, []);

  const save = (next: SubAccountLabel[]) => {
    setLabels(next);
    localStorage.setItem(LABELS_KEY, JSON.stringify(next));
  };

  const add = () => {
    const name = newName.trim();
    const addr = newAddress.trim();
    if (!name || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
    save([...labels, { name, address: addr }]);
    setNewName('');
    setNewAddress('');
  };

  const remove = (idx: number) => save(labels.filter((_, i) => i !== idx));

  if (!isConnected) {
    return (
      <div className="p-4 max-w-full space-y-6">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-bold text-foreground mb-2">Sub-Accounts</h2>
          <p className="text-dim text-sm">Track and switch between your wallet accounts</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-10 text-center">
          <h3 className="text-sm font-medium text-foreground mb-1">Connect Wallet</h3>
          <p className="text-xs text-dim max-w-md mx-auto">
            Orders on Mersennet are signed by your connected wallet, so each wallet account is its own
            trading identity. Connect a wallet to get started, then add labels for any other accounts
            you want to track here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-full space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-foreground mb-2">Sub-Accounts</h2>
        <p className="text-dim text-sm">Each wallet account is an independent trading identity</p>
      </div>

      <div className="bg-surface-2 border border-border rounded-lg p-3 text-[11.5px] text-dim leading-relaxed">
        <span className="text-foreground font-medium">How this works.</span> Orders are wallet-signed
        transactions to the on-chain order book, so the account you trade as is whichever wallet is
        connected. To trade as a different account, switch accounts in your wallet (e.g. MetaMask) and
        reconnect. For security we never generate or store private keys in the browser — add other
        accounts below only as labels to keep an eye on their balances and positions.
        {sessionKey ? ' A session key is set locally but on-chain delegation is not live yet, so it cannot sign orders.' : ''}
      </div>

      {/* Connected (active) account */}
      <div className="bg-surface border border-primary rounded-xl p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-foreground uppercase tracking-wider">Connected Account</p>
            <p className="text-xs text-dim font-mono">{shortenAddress(address || '', 8)}</p>
          </div>
          <span className="px-2 py-0.5 bg-green/20 text-green rounded text-xs">Active</span>
        </div>
      </div>

      {/* Tracked labels */}
      {labels.map((acc, i) => (
        <div
          key={acc.address}
          className={cn(
            'bg-surface border rounded-xl p-4 transition-all duration-200',
            acc.address.toLowerCase() === (address || '').toLowerCase() ? 'border-primary' : 'border-border'
          )}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-foreground uppercase tracking-wider">{acc.name}</p>
              <p className="text-xs text-dim font-mono">{shortenAddress(acc.address, 8)}</p>
            </div>
            <button
              onClick={() => remove(i)}
              className="px-3 py-1 bg-red/10 text-red rounded text-xs hover:bg-red/20 transition-colors duration-200"
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      {/* Add a tracked account (address only) */}
      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Track an Account</h3>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Label (e.g. Scalping)"
            className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors duration-200"
          />
          <input
            value={newAddress}
            onChange={(e) => setNewAddress(e.target.value)}
            placeholder="0x… address"
            className="flex-[2] bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono outline-none focus:border-primary transition-colors duration-200"
          />
          <button
            onClick={add}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium transition-all duration-200"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
