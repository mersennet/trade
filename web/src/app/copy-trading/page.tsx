'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type Trade, type Market, type LeaderboardEntry } from '@/lib/api';
import { subscribe as subscribeWs } from '@/lib/wsHub';
import { cn, formatPrice, formatNumber, shortenAddress } from '@/lib/utils';

interface TraderSettings {
  address: string;
  copyRatio: number;
  maxSize: number;
  stopLoss: number;
}

interface CopiedTrade {
  id: string;
  traderAddress: string;
  marketId: number;
  symbol: string;
  side: string;
  price: number;
  size: number;
  originalSize: number;
  timestamp: number;
  pnl: number;
}

const STORAGE_KEYS = {
  followed: 'pt_copy_followed',
  settings: 'pt_copy_settings',
  log: 'pt_copy_log',
  seenTrades: 'pt_copy_seen',
} as const;

function loadJson<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export default function CopyTradingPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();

  const [tab, setTab] = useState<'traders' | 'following' | 'activity' | 'portfolio'>('traders');
  const [traders, setTraders] = useState<LeaderboardEntry[]>([]);
  const [followedSettings, setFollowedSettings] = useState<TraderSettings[]>([]);
  const [copyMode, setCopyMode] = useState(false);
  const [copiedTrades, setCopiedTrades] = useState<CopiedTrade[]>([]);
  const [editingTrader, setEditingTrader] = useState<string | null>(null);
  const seenTradeIds = useRef<Set<number>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [markets, setMarkets] = useState<Market[]>([]);

  useEffect(() => {
    api.getLeaderboard('monthly', 'pnl', 20).then((r) => setTraders(r.traders)).catch(() => {});
    api.getMarkets().then((r) => setMarkets(r.markets || [])).catch(() => {});
    setFollowedSettings(loadJson<TraderSettings[]>(STORAGE_KEYS.settings, []));
    setCopiedTrades(loadJson<CopiedTrade[]>(STORAGE_KEYS.log, []));
    const seen = loadJson<number[]>(STORAGE_KEYS.seenTrades, []);
    seenTradeIds.current = new Set(seen);
  }, []);

  const saveSettings = (next: TraderSettings[]) => {
    setFollowedSettings(next);
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(next));
  };

  const saveCopiedTrades = useCallback((trades: CopiedTrade[]) => {
    setCopiedTrades(trades);
    localStorage.setItem(STORAGE_KEYS.log, JSON.stringify(trades.slice(0, 100)));
  }, []);

  // Persist the de-dup set so a page reload doesn't re-copy already-seen trades.
  const persistSeenTrades = useCallback(() => {
    try {
      const ids = Array.from(seenTradeIds.current).slice(-500);
      localStorage.setItem(STORAGE_KEYS.seenTrades, JSON.stringify(ids));
    } catch {}
  }, []);

  const followedAddresses = followedSettings.map((s) => s.address);

  const toggleFollow = (addr: string) => {
    const isFollowed = followedAddresses.includes(addr);
    const next = isFollowed
      ? followedSettings.filter((s) => s.address !== addr)
      : [...followedSettings, { address: addr, copyRatio: 0.5, maxSize: 1000, stopLoss: 10 }];
    saveSettings(next);
    toast(isFollowed ? `Unfollowed ${shortenAddress(addr)}` : `Following ${shortenAddress(addr)}`, 'info');
  };

  const updateTraderSettings = (addr: string, patch: Partial<TraderSettings>) => {
    const next = followedSettings.map((s) => s.address === addr ? { ...s, ...patch } : s);
    saveSettings(next);
    toast('Settings updated', 'success');
    setEditingTrader(null);
  };

  const executeCopyTrade = useCallback(async (trade: Trade, settings: TraderSettings) => {
    if (!address) return;
    const market = markets.find((m) => m.id === trade.marketId);
    if (!market) return;

    // trade.size is in base-asset units and trade.price is the fill price (MRSN
    // notional per unit). maxSize is a notional cap in MRSN, so clamp on notional
    // (size * price), not on raw base-asset size.
    const adjustedSize = trade.size * settings.copyRatio;
    const notional = adjustedSize * trade.price;
    const clampedSize = notional > settings.maxSize && trade.price > 0
      ? settings.maxSize / trade.price
      : adjustedSize;
    if (clampedSize <= 0) return;

    // Preview: real orders are signed wallet transactions to the CLOB precompile;
    // the trade API rejects unsigned submission (SIGNED_ORDER_REQUIRED). Until
    // signed copy execution ships, record the copy locally as a simulation
    // instead of firing a request that would always 400.
    const newCopied: CopiedTrade = {
      id: `${trade.id}-${Date.now()}`,
      traderAddress: trade.taker,
      marketId: trade.marketId,
      symbol: market.symbol,
      side: trade.side,
      price: trade.price,
      size: clampedSize,
      originalSize: trade.size,
      timestamp: Date.now(),
      pnl: 0,
    };

    saveCopiedTrades([newCopied, ...copiedTrades]);
    toast('Preview: copy trades are simulated — signed execution coming soon', 'info');
  }, [address, copiedTrades, saveCopiedTrades, toast, markets]);

  useEffect(() => {
    if (!copyMode || !isConnected || followedSettings.length === 0) return;

    // A fill between two followed wallets arrives once per wallet: seenTradeIds dedupes.
    const onTrade = (data: { type: string; id: number; time?: string; marketId: number; taker: string; maker: string; side: Trade['side']; price: number; size: number }) => {
      try {
        if (data.type !== 'trade') return;
        if (seenTradeIds.current.has(data.id)) return;
        seenTradeIds.current.add(data.id);
        persistSeenTrades();

        const trade: Trade = {
          id: data.id, block: 0, time: data.time || new Date().toISOString(),
          marketId: data.marketId, taker: data.taker, maker: data.maker,
          side: data.side, price: data.price, size: data.size,
        };
        const traderMatch = followedSettings.find(
          (s) => s.address.toLowerCase() === trade.taker.toLowerCase()
        );
        if (traderMatch) executeCopyTrade(trade, traderMatch);
      } catch {}
    };

    const unsubscribes = followedSettings.map((s) => subscribeWs(`trades:followed:${s.address.toLowerCase()}`, onTrade));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [copyMode, isConnected, followedSettings, executeCopyTrade, persistSeenTrades]);

  const totalPnl = copiedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalCopied = copiedTrades.length;
  const buys = copiedTrades.filter((t) => t.side === 'buy').length;
  const sells = copiedTrades.filter((t) => t.side === 'sell').length;

  const TABS = [
    { key: 'traders' as const, label: 'Top Traders' },
    { key: 'following' as const, label: `Following (${followedSettings.length})` },
    { key: 'activity' as const, label: `Activity (${copiedTrades.length})` },
    { key: 'portfolio' as const, label: 'Portfolio' },
  ];

  return (
    <div className="page-shell space-y-6">
      <div className="text-center mb-8">
        <h1 className="page-title">Copy Trading</h1>
        <p className="page-sub">Follow top traders and automatically mirror their positions</p>
      </div>

      {/* Preview banner */}
      <div className="bg-yellow/10 border border-yellow/40 rounded-lg p-3 flex items-start gap-2.5">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow shrink-0 mt-0.5">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div className="text-[12px] leading-relaxed">
          <span className="text-yellow font-semibold">Preview &middot; Not yet on-chain.</span>{' '}
          <span className="text-foreground/80">
            Copy execution is a preview and does not place real orders yet. Followed traders&apos; fills are
            mirrored as simulated entries only — no orders are submitted and no funds move. Signed on-chain
            copy execution is coming soon.
          </span>
        </div>
      </div>

      {/* Copy Mode Toggle */}
      <div className="bg-surface border border-border rounded-xl p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn('w-2.5 h-2.5 rounded-full transition-colors', copyMode ? 'bg-green animate-pulse' : 'bg-dim/30')} />
          <div>
            <p className="text-sm font-medium text-foreground">Copy Mode</p>
            <p className="text-[10px] text-dim">
              {copyMode
                ? `Active: live-streaming ${followedSettings.length} trader(s) over WebSocket`
                : 'Enable to auto-copy trades from followed traders'}
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={copyMode}
          aria-label="Copy mode"
          onClick={() => {
            if (!isConnected) { toast('Connect wallet first', 'error'); return; }
            if (!copyMode && followedSettings.length === 0) { toast('Follow at least one trader first', 'error'); return; }
            setCopyMode(!copyMode);
            toast(copyMode ? 'Copy mode disabled' : 'Copy mode enabled', 'info');
          }}
          className={cn(
            'relative w-12 h-6 rounded-full transition-all duration-300',
            copyMode ? 'bg-green' : 'bg-surface-2 border border-border'
          )}
        >
          <span className={cn(
            'absolute top-0.5 w-5 h-5 rounded-full transition-all duration-300 shadow-sm',
            copyMode ? 'left-[26px] bg-white' : 'left-0.5 bg-dim/40'
          )} />
        </button>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 bg-surface-2 rounded-lg p-0.5 w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-4 py-2 text-sm rounded-md transition-all duration-200',
              tab === t.key
                ? 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_rgba(43,217,106,0.2)]'
                : 'text-dim hover:text-muted'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Top Traders Tab */}
      {tab === 'traders' && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-dim text-[10px] uppercase tracking-wider font-medium border-b border-border">
                <th className="text-left px-4 py-3">Trader</th>
                <th className="text-right px-4 py-3">PnL (30d)</th>
                <th className="text-right px-4 py-3">Win Rate</th>
                <th className="text-right px-4 py-3">Trades</th>
                <th className="text-center px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {traders.map((t) => (
                <tr key={t.address} className="border-b border-border/50 hover:bg-surface-2 transition-colors duration-200">
                  <td className="px-4 py-3 text-foreground font-mono text-xs">{shortenAddress(t.address, 6)}</td>
                  <td className={cn('px-4 py-3 text-right font-mono', t.pnl >= 0 ? 'text-green' : 'text-red')}>
                    ${formatNumber(Math.abs(t.pnl))}
                  </td>
                  <td className="px-4 py-3 text-right text-foreground font-mono">{t.winRate}%</td>
                  <td className="px-4 py-3 text-right text-foreground font-mono">{t.trades}</td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => toggleFollow(t.address)}
                      className={cn(
                        'px-3 py-1 rounded text-xs font-medium transition-colors duration-200',
                        followedAddresses.includes(t.address)
                          ? 'bg-red/10 text-red hover:bg-red/20'
                          : 'bg-primary/10 text-primary hover:bg-primary/20'
                      )}
                    >
                      {followedAddresses.includes(t.address) ? 'Unfollow' : 'Follow'}
                    </button>
                  </td>
                </tr>
              ))}
              {traders.length === 0 && (
                <tr><td colSpan={5} className="text-center py-8 text-dim text-xs">Loading traders...</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Following Tab */}
      {tab === 'following' && (
        <div className="space-y-3">
          {followedSettings.length > 0 ? followedSettings.map((s) => (
            <div key={s.address} className="bg-surface border border-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center">
                    <span className="text-primary text-xs font-bold font-mono">{s.address.slice(2, 4).toUpperCase()}</span>
                  </div>
                  <span className="text-foreground font-mono text-sm">{shortenAddress(s.address, 8)}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditingTrader(editingTrader === s.address ? null : s.address)}
                    className="px-3 py-1 bg-surface-2 text-dim hover:text-muted rounded text-xs transition-colors duration-200"
                  >
                    {editingTrader === s.address ? 'Close' : 'Settings'}
                  </button>
                  <button
                    onClick={() => toggleFollow(s.address)}
                    className="px-3 py-1 bg-red/10 text-red rounded text-xs hover:bg-red/20 transition-colors duration-200"
                  >
                    Unfollow
                  </button>
                </div>
              </div>

              {/* Inline Settings Display */}
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="bg-surface-2 rounded-lg p-2">
                  <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-0.5">Copy Ratio</p>
                  <p className="text-foreground font-mono">{s.copyRatio}x</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-2">
                  <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-0.5">Max Size</p>
                  <p className="text-foreground font-mono">{formatNumber(s.maxSize)} MRSN</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-2">
                  <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-0.5">Stop Loss</p>
                  <p className="text-foreground font-mono">{s.stopLoss}%</p>
                </div>
              </div>

              {/* Editable Settings */}
              {editingTrader === s.address && (
                <EditSettings
                  settings={s}
                  onSave={(patch) => updateTraderSettings(s.address, patch)}
                  onCancel={() => setEditingTrader(null)}
                />
              )}
            </div>
          )) : (
            <div className="bg-surface border border-border rounded-xl p-8 text-center">
              <p className="text-dim text-xs mb-2">Not following any traders yet</p>
              <button
                onClick={() => setTab('traders')}
                className="px-4 py-1.5 bg-primary/10 text-primary rounded text-xs hover:bg-primary/20 transition-colors duration-200"
              >
                Browse Traders
              </button>
            </div>
          )}
        </div>
      )}

      {/* Activity Log Tab */}
      {tab === 'activity' && (
        <div className="space-y-4">
          {copiedTrades.length > 0 ? (
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-dim text-[10px] uppercase tracking-wider font-medium border-b border-border">
                    <th className="text-left px-4 py-3">Time</th>
                    <th className="text-left px-4 py-3">Trader</th>
                    <th className="text-left px-4 py-3">Market</th>
                    <th className="text-center px-4 py-3">Side</th>
                    <th className="text-right px-4 py-3">Price</th>
                    <th className="text-right px-4 py-3">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {copiedTrades.slice(0, 50).map((t) => (
                    <tr key={t.id} className="border-b border-border/50 hover:bg-surface-2 transition-colors duration-200">
                      <td className="px-4 py-3 text-dim font-mono text-xs">
                        {new Date(t.timestamp).toLocaleTimeString()}
                      </td>
                      <td className="px-4 py-3 text-foreground font-mono text-xs">{shortenAddress(t.traderAddress)}</td>
                      <td className="px-4 py-3 text-foreground text-xs">{t.symbol}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={cn(
                          'px-2 py-0.5 rounded text-[10px] font-bold uppercase',
                          t.side === 'buy' ? 'bg-green/10 text-green' : 'bg-red/10 text-red'
                        )}>
                          {t.side}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-foreground font-mono text-xs">{formatPrice(t.price)}</td>
                      <td className="px-4 py-3 text-right text-foreground font-mono text-xs">{formatNumber(t.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="bg-surface border border-border rounded-xl p-8 text-center">
              <p className="text-dim text-xs mb-1">No copied trades yet</p>
              <p className="text-dim/60 text-[10px]">Enable Copy Mode and follow traders to start</p>
            </div>
          )}

          {copiedTrades.length > 0 && (
            <button
              onClick={() => { saveCopiedTrades([]); toast('Activity cleared', 'info'); }}
              className="text-dim text-xs hover:text-red transition-colors duration-200"
            >
              Clear activity log
            </button>
          )}
        </div>
      )}

      {/* Portfolio Tab */}
      {tab === 'portfolio' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Total P&L', value: `$${formatNumber(totalPnl)}`, color: totalPnl >= 0 ? 'text-green' : 'text-red' },
              { label: 'Trades Copied', value: totalCopied.toString(), color: 'text-foreground' },
              { label: 'Buys', value: buys.toString(), color: 'text-green' },
              { label: 'Sells', value: sells.toString(), color: 'text-red' },
            ].map((item) => (
              <div key={item.label} className="bg-surface border border-border rounded-xl p-4 text-center">
                <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">{item.label}</p>
                <p className={cn('text-lg font-bold font-mono', item.color)}>{item.value}</p>
              </div>
            ))}
          </div>

          {/* Per-Trader Breakdown */}
          <div className="bg-surface border border-border rounded-xl p-4">
            <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Per-Trader Breakdown</h3>
            {followedSettings.length > 0 ? followedSettings.map((s) => {
              const traderTrades = copiedTrades.filter((t) => t.traderAddress.toLowerCase() === s.address.toLowerCase());
              const traderPnl = traderTrades.reduce((sum, t) => sum + t.pnl, 0);
              return (
                <div key={s.address} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 bg-primary/10 rounded-full flex items-center justify-center">
                      <span className="text-primary text-[10px] font-bold font-mono">{s.address.slice(2, 4).toUpperCase()}</span>
                    </div>
                    <span className="text-foreground font-mono text-xs">{shortenAddress(s.address)}</span>
                  </div>
                  <div className="text-right">
                    <p className={cn('font-mono text-xs', traderPnl >= 0 ? 'text-green' : 'text-red')}>
                      ${formatNumber(traderPnl)}
                    </p>
                    <p className="text-[10px] text-dim">{traderTrades.length} trades</p>
                  </div>
                </div>
              );
            }) : (
              <p className="text-dim text-xs text-center py-4">No followed traders</p>
            )}
          </div>

          {/* Per-Market Breakdown */}
          <div className="bg-surface border border-border rounded-xl p-4">
            <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Per-Market Breakdown</h3>
            {copiedTrades.length > 0 ? (
              [...new Set(copiedTrades.map((t) => t.symbol))].map((symbol) => {
                const mTrades = copiedTrades.filter((t) => t.symbol === symbol);
                const mPnl = mTrades.reduce((sum, t) => sum + t.pnl, 0);
                return (
                  <div key={symbol} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
                    <span className="text-foreground text-xs font-medium">{symbol}</span>
                    <div className="text-right">
                      <p className={cn('font-mono text-xs', mPnl >= 0 ? 'text-green' : 'text-red')}>
                        ${formatNumber(mPnl)}
                      </p>
                      <p className="text-[10px] text-dim">{mTrades.length} trades</p>
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-dim text-xs text-center py-4">No trade data</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EditSettings({ settings, onSave, onCancel }: {
  settings: TraderSettings;
  onSave: (patch: Partial<TraderSettings>) => void;
  onCancel: () => void;
}) {
  const [ratio, setRatio] = useState(settings.copyRatio.toString());
  const [maxSize, setMaxSize] = useState(settings.maxSize.toString());
  const [stopLoss, setStopLoss] = useState(settings.stopLoss.toString());

  return (
    <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1 block">Copy Ratio (0.1x–2x)</label>
          <input
            type="number"
            step="0.1"
            min="0.1"
            max="2"
            value={ratio}
            onChange={(e) => setRatio(e.target.value)}
            className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors duration-200 font-mono"
          />
        </div>
        <div>
          <label className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1 block">Max Size (MRSN notional)</label>
          <input
            type="number"
            min="1"
            value={maxSize}
            onChange={(e) => setMaxSize(e.target.value)}
            className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors duration-200 font-mono"
          />
        </div>
        <div>
          <label className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1 block">Stop Loss (%)</label>
          <input
            type="number"
            min="0"
            max="100"
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
            className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors duration-200 font-mono"
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 text-dim text-xs hover:text-muted transition-colors duration-200">
          Cancel
        </button>
        <button
          onClick={() => onSave({
            copyRatio: Math.min(2, Math.max(0.1, parseFloat(ratio) || 0.5)),
            maxSize: Math.max(1, parseFloat(maxSize) || 1000),
            stopLoss: Math.min(100, Math.max(0, parseFloat(stopLoss) || 10)),
          })}
          className="px-4 py-1.5 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-medium hover:shadow-[0_0_16px_rgba(43,217,106,0.15)] transition-all duration-200"
        >
          Save Settings
        </button>
      </div>
    </div>
  );
}
