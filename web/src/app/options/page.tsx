'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type OptionChain, type OptionContract, type OptionPosition, type OptionGreeks } from '@/lib/api';
import { formatPrice, formatNumber, cn } from '@/lib/utils';

export default function OptionsPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [chains, setChains] = useState<OptionChain[]>([]);
  const [underlying, setUnderlying] = useState<'BTC' | 'ETH'>('BTC');
  const [contracts, setContracts] = useState<OptionContract[]>([]);
  const [positions, setPositions] = useState<OptionPosition[]>([]);
  const [greeksMap, setGreeksMap] = useState<Record<number, OptionGreeks>>({});
  const [selectedContract, setSelectedContract] = useState<OptionContract | null>(null);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [orderSize, setOrderSize] = useState('');
  const [orderPrice, setOrderPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.getOptionChains().then((d) => setChains(d.chains || [])).catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    api.getOptionChain(underlying).then((d) => setContracts(d.contracts || [])).catch(() => {});
    if (address) api.getOptionPositions(address).then((d) => setPositions(d.positions || [])).catch(() => {});
  }, [underlying, address]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (contracts.length === 0) return;
    // One bulk request for the whole underlying — the old per-contract fan-out
    // fired hundreds of parallel requests and tripped the API rate limiter.
    api.getOptionGreeksBulk(underlying)
      .then((d) => {
        const next: Record<number, OptionGreeks> = {};
        for (const g of d.greeks || []) {
          if (g.contractId != null) next[g.contractId] = g;
        }
        setGreeksMap(next);
      })
      .catch(() => {});
  }, [contracts, underlying]);

  // Contracts carry full timestamps; several expire at different times on the
  // same day. Group by calendar day so the tab row shows "Aug 16" once, not
  // a dozen identical chips overflowing the viewport.
  const expiryDay = (exp: string) => {
    try { return new Date(exp).toISOString().slice(0, 10); } catch { return exp; }
  };

  const expiries = useMemo(() => {
    const set = new Set(contracts.map((c) => expiryDay(c.expiry)));
    return Array.from(set).sort();
  }, [contracts]);

  const [selectedExpiry, setSelectedExpiry] = useState('');
  useEffect(() => {
    if (expiries.length && !expiries.includes(selectedExpiry)) setSelectedExpiry(expiries[0]);
  }, [expiries, selectedExpiry]);

  const filteredContracts = useMemo(() =>
    contracts.filter((c) => expiryDay(c.expiry) === selectedExpiry),
  [contracts, selectedExpiry]);

  const strikes = useMemo(() => {
    const set = new Set(filteredContracts.map((c) => c.strike));
    return Array.from(set).sort((a, b) => a - b);
  }, [filteredContracts]);

  const contractAt = (strike: number, type: 'call' | 'put') =>
    filteredContracts.find((c) => c.strike === strike && c.option_type === type);

  const handleSubmit = async () => {
    if (!isConnected || !address || !selectedContract || !orderSize || !orderPrice) {
      toast('Select a contract, set size/price, and connect wallet', 'warning');
      return;
    }
    setSubmitting(true);
    try {
      await api.submitOptionOrder({ owner: address, contract_id: selectedContract.id, side, size: Number(orderSize), price: Number(orderPrice) });
      toast(`${side.toUpperCase()} ${selectedContract.option_type} @ ${selectedContract.strike} placed`, 'success');
      setOrderSize('');
      setOrderPrice('');
      refresh();
    } catch (e) {
      toast(`Order failed: ${(e as Error).message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const formatExpiry = (exp: string) => {
    try { return new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
    catch { return exp; }
  };

  return (
    <div className="p-3 md:p-4 max-w-full space-y-4">
      {/* Options settle in the API's database, not on-chain — labeled a
          preview like vault/funding-arb so nobody mistakes it for live. */}
      <div className="bg-yellow/10 border border-yellow/40 rounded-lg p-3 flex items-start gap-2.5">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow shrink-0 mt-0.5">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div className="text-[12px] leading-relaxed">
          <span className="text-yellow font-semibold">Preview &middot; Not yet on-chain.</span>{' '}
          <span className="text-foreground/80">
            Options trading is simulated for UX testing — no tokens move from your wallet and
            positions are not settled on-chain.
          </span>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-2">
        <h2 className="text-xl font-bold text-foreground">Options</h2>
        <div className="flex gap-1 bg-surface-2 rounded-lg p-1">
          {(['BTC', 'ETH'] as const).map((u) => (
            <button
              key={u}
              onClick={() => setUnderlying(u)}
              className={cn(
                'px-4 py-1.5 rounded-md text-xs font-semibold transition-all duration-200',
                underlying === u ? 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_rgba(125,255,155,0.2)]' : 'text-dim hover:text-muted'
              )}
            >{u}</button>
          ))}
        </div>
      </div>

      {/* Expiry tabs */}
      {expiries.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {expiries.map((exp) => (
            <button
              key={exp}
              onClick={() => setSelectedExpiry(exp)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-[11px] font-medium whitespace-nowrap transition-all duration-200',
                selectedExpiry === exp ? 'bg-cyan/10 text-cyan shadow-[inset_0_0_0_1px_rgba(34,211,238,0.2)]' : 'bg-surface-2 text-dim hover:text-muted'
              )}
            >{formatExpiry(exp)}</button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        {/* Option chain table */}
        <div className="xl:col-span-3 bg-surface border border-border rounded-xl p-4 overflow-x-auto">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Option Chain</h3>
          {strikes.length === 0 ? (
            <p className="text-dim text-xs text-center py-8">No contracts available for this expiry</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border/50">
                  <th colSpan={4} className="text-center pb-2 font-medium text-green/70">Calls</th>
                  <th className="pb-2 font-medium text-center text-foreground">Strike</th>
                  <th colSpan={4} className="text-center pb-2 font-medium text-red/70">Puts</th>
                </tr>
                <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border/30">
                  <th className="pb-1.5 text-left font-medium">Mark</th>
                  <th className="pb-1.5 text-right font-medium">IV</th>
                  <th className="pb-1.5 text-right font-medium">Delta</th>
                  <th className="pb-1.5 text-right font-medium w-4"></th>
                  <th className="pb-1.5 text-center font-medium"></th>
                  <th className="pb-1.5 text-left font-medium w-4"></th>
                  <th className="pb-1.5 text-left font-medium">Delta</th>
                  <th className="pb-1.5 text-left font-medium">IV</th>
                  <th className="pb-1.5 text-right font-medium">Mark</th>
                </tr>
              </thead>
              <tbody>
                {strikes.map((strike) => {
                  const call = contractAt(strike, 'call');
                  const put = contractAt(strike, 'put');
                  const cg = call ? greeksMap[call.id] : null;
                  const pg = put ? greeksMap[put.id] : null;
                  const isSelected = selectedContract?.strike === strike;
                  return (
                    <tr key={strike} className={cn('border-b border-border/20 hover:bg-surface-2/50 transition-colors', isSelected && 'bg-primary/5')}>
                      <td
                        className="py-2 font-mono text-green cursor-pointer hover:text-green/80"
                        onClick={() => { if (call) { setSelectedContract(call); setOrderPrice(call.mark_price.toString()); } }}
                      >
                        {call ? formatPrice(call.mark_price) : '—'}
                      </td>
                      <td className="py-2 text-right font-mono text-foreground/60">{call ? (call.iv * 100).toFixed(1) + '%' : '—'}</td>
                      <td className="py-2 text-right font-mono text-cyan">{cg ? cg.delta.toFixed(3) : '—'}</td>
                      <td className="py-2"></td>
                      <td className="py-2 text-center font-mono font-bold text-foreground">{formatPrice(strike)}</td>
                      <td className="py-2"></td>
                      <td className="py-2 font-mono text-cyan">{pg ? pg.delta.toFixed(3) : '—'}</td>
                      <td className="py-2 font-mono text-foreground/60">{put ? (put.iv * 100).toFixed(1) + '%' : '—'}</td>
                      <td
                        className="py-2 text-right font-mono text-red cursor-pointer hover:text-red/80"
                        onClick={() => { if (put) { setSelectedContract(put); setOrderPrice(put.mark_price.toString()); } }}
                      >
                        {put ? formatPrice(put.mark_price) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Order form sidebar */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-4">Order</h3>

          {selectedContract ? (
            <div className="space-y-3">
              <div className="bg-surface-2 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-dim uppercase tracking-wider">Contract</span>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-bold uppercase', selectedContract.option_type === 'call' ? 'bg-green/10 text-green' : 'bg-red/10 text-red')}>
                    {selectedContract.option_type}
                  </span>
                </div>
                <p className="text-sm font-mono text-foreground font-semibold">{underlying} {formatPrice(selectedContract.strike)}</p>
                <p className="text-[10px] text-dim">{formatExpiry(selectedContract.expiry)}</p>
              </div>

              {greeksMap[selectedContract.id] && (
                <div className="grid grid-cols-2 gap-2">
                  {(['delta', 'gamma', 'theta', 'vega'] as const).map((k) => {
                    const v = greeksMap[selectedContract.id][k];
                    return (
                      <div key={k} className="bg-surface-2 rounded-lg p-2 text-center">
                        <p className="text-[9px] text-dim uppercase tracking-wider">{k}</p>
                        <p className="text-xs font-mono text-cyan">{typeof v === 'number' ? v.toFixed(4) : '—'}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex gap-1 bg-surface-2 rounded-lg p-1">
                <button onClick={() => setSide('buy')} className={cn('flex-1 py-1.5 rounded-md text-xs font-semibold transition-all', side === 'buy' ? 'bg-green/15 text-green' : 'text-dim')}>Buy</button>
                <button onClick={() => setSide('sell')} className={cn('flex-1 py-1.5 rounded-md text-xs font-semibold transition-all', side === 'sell' ? 'bg-red/15 text-red' : 'text-dim')}>Sell</button>
              </div>

              <div>
                <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Size</label>
                <input type="number" value={orderSize} onChange={(e) => setOrderSize(e.target.value)} placeholder="0.0" className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono outline-none focus:border-primary/40 transition-colors" />
              </div>
              <div>
                <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Price</label>
                <input type="number" value={orderPrice} onChange={(e) => setOrderPrice(e.target.value)} placeholder="0.00" className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono outline-none focus:border-primary/40 transition-colors" />
              </div>

              <button
                onClick={handleSubmit}
                disabled={submitting || !isConnected}
                className={cn(
                  'w-full py-2.5 rounded-lg text-xs font-semibold transition-all duration-200 disabled:opacity-50',
                  side === 'buy' ? 'bg-green/80 hover:bg-green text-white' : 'bg-red/80 hover:bg-red text-white'
                )}
              >
                {!isConnected ? 'Connect Wallet' : submitting ? 'Placing...' : `${side === 'buy' ? 'Buy' : 'Sell'} ${selectedContract.option_type.toUpperCase()}`}
              </button>
            </div>
          ) : (
            <p className="text-dim text-xs text-center py-6">Click a call or put price to select a contract</p>
          )}
        </div>
      </div>

      {/* Positions */}
      {isConnected && positions.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Your Option Positions</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border/50">
                  <th className="text-left pb-2 font-medium">Contract</th>
                  <th className="text-left pb-2 font-medium">Type</th>
                  <th className="text-right pb-2 font-medium">Strike</th>
                  <th className="text-right pb-2 font-medium">Size</th>
                  <th className="text-right pb-2 font-medium">Entry</th>
                  <th className="text-right pb-2 font-medium">Mark</th>
                  <th className="text-right pb-2 font-medium">PnL</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id} className="border-b border-border/30 last:border-0">
                    <td className="py-2 font-medium text-foreground">{p.underlying} {formatExpiry(p.expiry)}</td>
                    <td className="py-2">
                      <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-bold uppercase', p.option_type === 'call' ? 'bg-green/10 text-green' : 'bg-red/10 text-red')}>
                        {p.option_type}
                      </span>
                    </td>
                    <td className="py-2 text-right font-mono text-foreground">{formatPrice(p.strike)}</td>
                    <td className="py-2 text-right font-mono text-foreground">{formatNumber(p.size, 2)}</td>
                    <td className="py-2 text-right font-mono text-dim">{formatPrice(p.entry_price)}</td>
                    <td className="py-2 text-right font-mono text-foreground">{formatPrice(p.mark_price)}</td>
                    <td className={cn('py-2 text-right font-mono font-semibold', p.pnl >= 0 ? 'text-green' : 'text-red')}>
                      {p.pnl >= 0 ? '+' : ''}{formatNumber(p.pnl, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
