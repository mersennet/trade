'use client';
import { useEffect, useState } from 'react';
import type { JsonRpcSigner } from 'ethers';
import { useWallet } from '@/hooks/useWallet';
import { api } from '@/lib/api';
import { getReferralCode } from '@/lib/referral';
import { useToast } from '@/components/shared/Toast';

/**
 * One-time referral confirmation. Shows when this browser captured a ?ref=
 * code and the connected wallet is not attributed yet. Signing a one-line
 * statement is what makes the attribution trustworthy (nobody can attach a
 * wallet they do not control to their code); the referrer then earns 10 % of
 * this wallet's trading points — nothing is taken from the referee.
 */
export default function ReferralConfirm() {
  const { address, signer } = useWallet();
  const { toast } = useToast();
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'checking' | 'ready' | 'signing' | 'done' | 'hidden'>('idle');

  useEffect(() => {
    const c = getReferralCode();
    if (!c || !address) { setState('idle'); return; }
    if (localStorage.getItem(`mersennet-trade_ref_declined_${address.toLowerCase()}`) === '1') { setState('hidden'); return; }
    setCode(c);
    setState('checking');
    api.getReferralStatus(address)
      .then((s) => setState(s.referredBy ? 'done' : 'ready'))
      .catch(() => setState('hidden'));
  }, [address]);

  if (!address || !code || state !== 'ready' && state !== 'signing') return null;

  const confirm = async () => {
    if (!signer) return;
    setState('signing');
    try {
      const { message } = await api.getReferralMessage(code, address);
      const signature = await (signer as JsonRpcSigner).signMessage(message);
      const r = await api.attributeReferral(address, code, signature);
      toast(r.alreadyAttributed ? 'This wallet already has a referrer.' : `Referral confirmed — code ${r.code}. Your referrer earns 10% of your trading points; you lose nothing.`, 'success');
      setState('done');
    } catch (e) {
      const msg = (e as Error).message || '';
      toast(/rejected|denied/i.test(msg) ? 'Referral not confirmed.' : `Referral failed: ${msg}`, /rejected|denied/i.test(msg) ? 'info' : 'error');
      setState('ready');
    }
  };
  const decline = () => {
    localStorage.setItem(`mersennet-trade_ref_declined_${address.toLowerCase()}`, '1');
    setState('hidden');
  };

  return (
    <div className="border border-primary/30 bg-primary/[0.04] rounded-lg px-3 py-2 flex flex-wrap items-center gap-2 text-[11px]" data-testid="referral-confirm">
      <span className="text-foreground">You arrived with referral code <code className="font-mono text-primary">{code}</code>.</span>
      <span className="text-dim">Confirm it with one signature — the referrer earns 10% of your trading points as a bonus; nothing is deducted from you.</span>
      <span className="flex-1" />
      <button onClick={confirm} disabled={state === 'signing'} className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider bg-primary text-[#02120a] rounded-md disabled:opacity-60">
        {state === 'signing' ? 'Waiting for wallet…' : 'Confirm referral'}
      </button>
      <button onClick={decline} className="px-2 py-1 text-[10px] text-dim hover:text-foreground">Not now</button>
    </div>
  );
}
