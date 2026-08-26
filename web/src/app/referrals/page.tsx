'use client';
import { useEffect, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type BuilderCode } from '@/lib/api';
import { shortenAddress, formatNumber } from '@/lib/utils';

export default function ReferralsPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [myCodes, setMyCodes] = useState<BuilderCode[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [newCode, setNewCode] = useState('');
  const [referralPoints, setReferralPoints] = useState(0);

  const loadMyCodes = (addr: string) =>
    api.getBuilderCodesByOwner(addr)
      .then((r) => setMyCodes(r.codes || []))
      .catch(() => {});

  useEffect(() => {
    if (address) {
      loadMyCodes(address);
      api.getPoints(address)
        .then((r) => setReferralPoints(r.referralPoints || 0))
        .catch(() => {});
    }
  }, [address]);

  const createCode = async () => {
    if (!address) { toast('Connect wallet first', 'error'); return; }
    try {
      const res = await api.createBuilderCode(address, newLabel || undefined, newCode || undefined);
      toast(`Builder code created: ${res.code}`, 'success');
      setNewLabel('');
      setNewCode('');
      // Refresh the list that is actually rendered ("Your Builder Codes").
      loadMyCodes(address);
    } catch (e) { toast(`Failed: ${(e as Error).message}`, 'error'); }
  };

  const copyLink = (code: string) => {
    navigator.clipboard.writeText(`https://trade.mersennet.com/?ref=${code}`);
    toast('Referral link copied!', 'info');
  };

  return (
    <div className="p-4 max-w-full space-y-6">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-foreground mb-2">Referrals & Builder Codes</h2>
        <p className="text-dim">Earn revenue share by referring traders or building integrations</p>
      </div>

      {/* Attribution from signed on-chain orders is not wired up yet, so
          counters cannot grow from real trading. Say so instead of showing a
          forever-zero dashboard under revenue-share promises. */}
      <div className="max-w-2xl mx-auto flex items-start gap-2 px-4 py-3 rounded-lg bg-yellow/10 border border-yellow/30">
        <span className="text-yellow text-sm leading-none mt-0.5">⚠</span>
        <p className="text-xs text-yellow/90 leading-relaxed">
          Early preview — referral attribution for signed on-chain orders is still being built,
          so points and order counters may not reflect your referred traders&apos; activity yet.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-2">Referral Program</h3>
          <p className="text-sm text-dim mb-3">Earn 10% of referred traders trading points + fee rebates</p>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-dim">Your Referral Points</span>
              <span className="text-foreground font-medium font-mono">{formatNumber(referralPoints)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-dim">Orders via your codes</span>
              <span className="text-foreground font-medium font-mono">{myCodes.reduce((s, c) => s + Number(c.total_orders || 0), 0)}</span>
            </div>
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-2">Builder Codes</h3>
          <p className="text-sm text-dim mb-3">
            {myCodes.length > 0
              ? `${(Math.max(...myCodes.map((c) => Number(c.fee_share_bps) || 0)) / 100).toFixed(2)}% fee share on orders using your builder code`
              : '1% fee share on orders using your builder code (default)'}
          </p>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-dim">Your Codes</span>
              <span className="text-foreground font-medium font-mono">{myCodes.length}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-dim">Total Volume</span>
              <span className="text-foreground font-medium font-mono">{formatNumber(myCodes.reduce((s, c) => s + (Number(c.total_volume) || 0), 0))} MRSN</span>
            </div>
          </div>
        </div>
      </div>

      {isConnected && (
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Create Builder Code</h3>
          <div className="flex gap-2">
            <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="Code (optional, auto-generated)" className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors duration-200" />
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Label" className="w-32 bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors duration-200" />
            <button onClick={createCode} className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium hover:shadow-[0_0_16px_rgba(125,255,155,0.15)] transition-all duration-200">
              Create
            </button>
          </div>
        </div>
      )}

      {myCodes.length > 0 && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Your Builder Codes</h3>
          </div>
          <div className="divide-y divide-border">
            {myCodes.map((c) => (
              <div key={c.code} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-mono text-foreground">{c.code}</p>
                  <p className="text-xs text-dim">{c.label || 'No label'} | <span className="font-mono">{c.total_orders}</span> orders | <span className="font-mono">{formatNumber(Number(c.total_volume))} MRSN</span> volume</p>
                </div>
                <button onClick={() => copyLink(c.code)} className="px-3 py-1 bg-surface-2 text-dim hover:text-muted rounded text-xs transition-colors duration-200">
                  Copy Link
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
