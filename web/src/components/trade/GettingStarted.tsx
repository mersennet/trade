'use client';
import { useState } from 'react';
import Link from 'next/link';
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
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined' || !address) return false;
    return localStorage.getItem(`mersennet-trade_onboarding_done_${address.toLowerCase()}`) === '1';
  });

  if (!isConnected || !address || dismissed) return null;

  const steps = [
    {
      label: 'Get testnet MRSN',
      done: balance > 0,
      action: (
        <Link href="/faucet" className="text-[10px] text-primary hover:underline font-medium">Faucet</Link>
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
          Getting started <span className="text-dim font-normal">· {doneCount}/{steps.length}</span>
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
