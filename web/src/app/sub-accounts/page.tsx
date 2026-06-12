'use client';
import { useState, useEffect } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { useStore } from '@/stores/useStore';
import { shortenAddress, cn } from '@/lib/utils';

interface SubAccount {
  name: string;
  address: string;
  privateKey: string;
}

export default function SubAccountsPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const { sessionKey, setSessionKey, setOneClick, setWallet: setWalletStore } = useStore();
  const [accounts, setAccounts] = useState<SubAccount[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [newName, setNewName] = useState('');
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('pt_sub_accounts');
    if (saved) try { setAccounts(JSON.parse(saved)); } catch {}
    setActiveIdx(parseInt(localStorage.getItem('pt_active_sub') || '-1'));
  }, []);

  useEffect(() => {
    if (!sessionKey) { setSessionAddress(null); return; }
    (async () => {
      try {
        const { ethers } = await import('ethers');
        const wallet = new ethers.Wallet(sessionKey);
        setSessionAddress(wallet.address);
      } catch {
        setSessionAddress(null);
      }
    })();
  }, [sessionKey]);

  const save = (accs: SubAccount[]) => {
    setAccounts(accs);
    localStorage.setItem('pt_sub_accounts', JSON.stringify(accs));
  };

  const create = async () => {
    if (!newName.trim()) { toast('Enter a name', 'error'); return; }
    const { ethers } = await import('ethers');
    const wallet = ethers.Wallet.createRandom();
    const acc: SubAccount = { name: newName.trim(), address: wallet.address, privateKey: wallet.privateKey };
    save([...accounts, acc]);
    setNewName('');
    toast(`Sub-account "${acc.name}" created`, 'success');
  };

  const switchTo = async (idx: number) => {
    setActiveIdx(idx);
    localStorage.setItem('pt_active_sub', idx.toString());
    if (idx === -1) {
      try {
        if (typeof window !== 'undefined' && window.ethereum) {
          const accs = (await window.ethereum.request({ method: 'eth_accounts' })) as string[];
          if (accs[0]) setWalletStore({ address: accs[0] });
        }
      } catch {}
      toast('Switched to main account', 'info');
    } else {
      const acc = accounts[idx];
      // Watch-only: this only changes which address the data views query. The
      // signer stays the connected wallet — sub-account private keys are not
      // wired to any signer, so trades/deposits still execute from the main
      // account. We surface that explicitly rather than implying isolation.
      setWalletStore({ address: acc.address });
      toast(`Viewing ${acc.name} (watch-only — trades still use your main wallet)`, 'info');
    }
  };

  const remove = (idx: number) => {
    if (activeIdx === idx) switchTo(-1);
    const next = accounts.filter((_, i) => i !== idx);
    save(next);
    toast('Sub-account removed', 'info');
  };

  const copyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    toast('Private key copied to clipboard', 'info');
  };

  const generateSessionKey = async () => {
    const { ethers } = await import('ethers');
    const wallet = ethers.Wallet.createRandom();
    setSessionKey(wallet.privateKey);
    toast('Session key generated', 'success');
  };

  // NOTE: Mersennet has no on-chain session-key delegation yet — orders are
  // plain msg.sender txs. A generated session key cannot trade the main
  // account's collateral, so we do NOT pretend to "approve" one for trading.
  // The Approve button is disabled until real delegation ships.

  const revokeSessionKey = () => {
    setSessionKey(null);
    setOneClick(false);
    toast('Session key revoked', 'info');
  };

  if (!isConnected) {
    return (
      <div className="p-4 max-w-full space-y-6">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-bold text-foreground mb-2">Sub-Accounts & Session Keys</h2>
          <p className="text-dim text-sm">Isolated strategies and one-click trading</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-10 text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-primary/8 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary/50">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <h3 className="text-sm font-medium text-foreground mb-1">Connect Wallet</h3>
          <p className="text-xs text-dim max-w-md mx-auto">Connect your wallet to create watch-only sub-accounts and preview the session-key flow. On-chain isolation and one-click delegation are not live yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-full space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-foreground mb-2">Sub-Accounts & Session Keys</h2>
        <p className="text-dim text-sm">Watch-only sub-accounts and session-key preview</p>
      </div>

      {/* One-Click Trading / Session Keys */}
      <div className="bg-surface border border-primary/30 rounded-xl p-5 shadow-[0_0_24px_rgba(139,92,246,0.06)]">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-3 h-3 rounded-full bg-dim/30 transition-colors" />
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">One-Click Trading</h3>
            <span className="px-1.5 py-0.5 bg-yellow/10 text-yellow rounded text-[9px] font-semibold uppercase tracking-wider">Preview · not yet on-chain</span>
          </div>
        </div>

        <div className="bg-surface-2 rounded-lg p-3 mb-4 text-xs text-dim leading-relaxed">
          <p className="mb-2">
            <span className="text-foreground font-medium">How it will work:</span> Once on-chain session-key delegation
            ships, you will be able to register a temporary key that signs orders on your behalf — enabling instant
            execution without a MetaMask popup for every trade.
          </p>
          <p>
            <span className="text-yellow font-medium">Not active yet.</span> Mersennet orders are plain wallet
            transactions today, and a generated key holds no collateral and is not authorized to trade your account.
            You can generate and store a key locally now, but it cannot place orders for you until delegation is live.
          </p>
        </div>

        {!sessionKey ? (
          <button
            onClick={generateSessionKey}
            className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium hover:shadow-[0_0_16px_rgba(139,92,246,0.15)] transition-all duration-200"
          >
            Generate Session Key
          </button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3 bg-surface-2 rounded-lg p-3">
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-0.5">Session Key Address</p>
                <p className="text-foreground font-mono text-xs truncate">{sessionAddress || 'Deriving...'}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="px-2 py-0.5 bg-surface text-dim rounded text-[10px] font-medium whitespace-nowrap">
                  Stored locally
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                disabled
                title="On-chain session-key delegation is not available yet"
                className="py-2 bg-surface-2 text-dim rounded-lg text-sm font-medium cursor-not-allowed"
              >
                Approve for Trading (coming soon)
              </button>
              <button
                onClick={revokeSessionKey}
                className="py-2 bg-red/10 text-red rounded-lg text-sm font-medium hover:bg-red/20 transition-colors duration-200"
              >
                Delete Key
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Watch-only disclosure */}
      <div className="bg-surface-2 border border-border rounded-lg p-3 text-[11.5px] text-dim leading-relaxed">
        <span className="text-foreground font-medium">Watch-only.</span> Selecting a sub-account changes which address
        the data views (positions, collateral, orders) display. It does <span className="text-foreground">not</span>{' '}
        switch the signer — any deposit or trade still executes from your connected main wallet. True per-account
        isolation requires on-chain account abstraction, which is not live yet.
      </div>

      {/* Main Account */}
      <div
        className={cn(
          'bg-surface border rounded-xl p-4 cursor-pointer hover-lift transition-all duration-200',
          activeIdx === -1 ? 'border-primary' : 'border-border'
        )}
        onClick={() => switchTo(-1)}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-foreground uppercase tracking-wider">Main Account</p>
            <p className="text-xs text-dim font-mono">{shortenAddress(address || '', 8)}</p>
          </div>
          {activeIdx === -1 && <span className="px-2 py-0.5 bg-green/20 text-green rounded text-xs">Active</span>}
        </div>
      </div>

      {/* Sub-Accounts */}
      {accounts.map((acc, i) => (
        <div
          key={i}
          className={cn(
            'bg-surface border rounded-xl p-4 hover-lift transition-all duration-200',
            activeIdx === i ? 'border-primary' : 'border-border'
          )}
        >
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-xs font-medium text-foreground uppercase tracking-wider">{acc.name}</p>
              <p className="text-xs text-dim font-mono">{shortenAddress(acc.address, 8)}</p>
            </div>
            {activeIdx === i && <span className="px-2 py-0.5 bg-cyan/20 text-cyan rounded text-xs">Viewing</span>}
          </div>
          <div className="flex gap-2">
            <button onClick={() => switchTo(i)} className="px-3 py-1 bg-primary/10 text-primary rounded text-xs hover:bg-primary/20 transition-colors duration-200">
              View (watch-only)
            </button>
            <button onClick={() => copyKey(acc.privateKey)} className="px-3 py-1 bg-surface-2 text-dim hover:text-muted rounded text-xs transition-colors duration-200">
              Export Key
            </button>
            <button onClick={() => remove(i)} className="px-3 py-1 bg-red/10 text-red rounded text-xs hover:bg-red/20 transition-colors duration-200">
              Delete
            </button>
          </div>
        </div>
      ))}

      {/* Create Sub-Account */}
      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Create Sub-Account</h3>
        <div className="flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Account name (e.g. Scalping)"
            className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors duration-200"
          />
          <button onClick={create} className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium hover:shadow-[0_0_16px_rgba(139,92,246,0.15)] transition-all duration-200">
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
