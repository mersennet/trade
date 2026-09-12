'use client';
import { useState } from 'react';
import { useStore } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { cn } from '@/lib/utils';

/**
 * First-trade checklist shown until the wallet has completed the onboarding
 * loop: fund → deposit → first order → enable one-click. Dismissal is
 * persisted per wallet. Hyperliquid prompts "Enable trading" after the first
 * deposit; this covers the whole ramp.
 */
export default function GettingStarted() {
  const { address, isConnected } = useWallet();
  const balance = useStore((s) => Number(s.wallet.balance) || 0);
  const collateral = useStore((s) => Number(s.wallet.collateral) || 0);
  const positions = useStore((s) => s.positions);
  const orders = useStore((s) => s.orders);
  const oneClickEnabled = useStore((s) => s.oneClickEnabled);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const requestDeposit = useStore((s) => s.requestDeposit);
  const requestConnect = useStore((s) => s.requestConnect);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined' || !address) return false;
    return localStorage.getItem(`mersennet-trade_onboarding_done_${address.toLowerCase()}`) === '1';
  });

  // Before a wallet is connected the whole ramp is one step; make it the
  // obvious first action instead of an empty account panel.
  if (!isConnected || !address) {
    return (
      <div className="bg-surface border border-primary/20 rounded-xl md:rounded-none md:border-0 md:border-b p-3 shrink-0" data-testid="getting-started">
        <p className="text-[11px] font-semibold text-foreground mb-2">
          Getting started <span className="text-dim font-normal">· 0/5</span>
        </p>
        <div className="flex items-center gap-2">
          <span className="w-3.5 h-3.5 rounded-full border border-primary/60 shrink-0" />
          <span className="text-[11px] flex-1 text-foreground">Connect a wallet <span className="block text-[10px] text-dim">MetaMask, Rabby or any injected wallet · testnet, nothing at stake</span></span>
          <button
            onClick={() => requestConnect()}
            className="text-[10px] text-primary hover:underline font-medium"
          >Connect</button>
        </div>
      </div>
    );
  }
  if (dismissed) return null;

  const steps = [
    {
      label: 'Get testnet MRSN',
      // Having collateral implies the faucet step happened — don't show
      // step 2 done while step 1 is pending just because gas was spent.
      done: balance > 0 || collateral > 0,
      action: (
        <a href={`https://faucet.mersennet.com/?address=${address}`} target="_blank" rel="noopener" className="text-[10px] text-primary hover:underline font-medium">Faucet ↗</a>
      ),
    },
    {
      label: 'Deposit collateral',
      done: collateral > 0,
      action: (
        <button
          onClick={() => requestDeposit()}
          className="text-[10px] text-primary hover:underline font-medium"
        >Deposit</button>
      ),
    },
    {
      label: 'Place your first order',
      done: positions.length > 0 || orders.length > 0,
      action: null,
    },
    {
      label: 'Enable one-click trading',
      done: oneClickEnabled,
      action: (
        <button
          onClick={() => setShowSettings(true)}
          className="text-[10px] text-primary hover:underline font-medium"
        >Settings</button>
      ),
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;

  const dismiss = () => {
    localStorage.setItem(`mersennet-trade_onboarding_done_${address.toLowerCase()}`, '1');
    setDismissed(true);
  };

  return (
    <div className="bg-surface border border-primary/20 rounded-xl md:rounded-none md:border-0 md:border-b p-3 shrink-0">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold text-foreground">
          Getting started <span className="text-dim font-normal">· {doneCount + 1}/{steps.length + 1}</span>
        </p>
        <button
          onClick={dismiss}
          aria-label="Dismiss getting-started checklist"
          className="text-dim hover:text-foreground text-xs leading-none px-1"
        >×</button>
      </div>
      <div className="space-y-1.5">
        {steps.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <span className={cn(
              'w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 text-[8px]',
              s.done ? 'bg-green/20 border-green/40 text-green' : 'border-border text-transparent'
            )}>
              {s.done ? '✓' : ''}
            </span>
            <span className={cn('text-[11px] flex-1', s.done ? 'text-dim line-through' : 'text-foreground')}>
              {s.label}
            </span>
            {!s.done && s.action}
          </div>
        ))}
      </div>
    </div>
  );
}
