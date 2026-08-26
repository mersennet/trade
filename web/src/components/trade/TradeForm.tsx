'use client';
import { useState, useMemo } from 'react';
import { useStore } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api } from '@/lib/api';
import { cn, formatPrice, formatNumber } from '@/lib/utils';
import { getReferralCode } from '@/lib/referral';
import { playSound } from '@/lib/sounds';
import { useTranslation } from '@/i18n';
import { loadViewingKey, submitShieldedOrder, toChainUnits } from '@/lib/shielded';
// Stop / Trail / TWAP / Scale are intentionally NOT offered: their server-side
// execution engines require signed orders and would silently never fire.
// They return when client-side signed execution ships. TP/SL brackets and
// Chase (both client-side signed) cover the protective use cases today.

const LEVERAGE_PRESETS = [1, 2, 5, 10, 25, 50];
const SIZE_PRESETS = [25, 50, 75, 100];

const SPOT_ORDER_TYPES = [
  { value: 'limit', tKey: 'trade.limit', fallback: 'Limit' },
  { value: 'market', tKey: 'trade.market', fallback: 'Market' },
] as const;

export default function TradeForm() {
  const { market, trade, setTrade, skipConfirm, marginMode, setMarginMode, tickers, positions, oneClickEnabled, sessionKey } = useStore();
  const tradeMode = useStore((s) => s.tradeMode);
  const isSpot = tradeMode === 'spot';
  const privateMode = useStore((s) => s.privateMode);
  const privacyForkActive = useStore((s) => s.privacyForkActive);
  const shieldedActive = privateMode && privacyForkActive && !isSpot;
  const { address, isConnected, provider } = useWallet();
  const collateral = useStore((s) => Number(s.wallet.collateral) || 0);
  const { toast } = useToast();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [showCalc, setShowCalc] = useState(false);
  const [riskPct, setRiskPct] = useState('2');
  const [calcEntry, setCalcEntry] = useState('');
  const [calcSl, setCalcSl] = useState('');
  // Maker flags (chain-native): post-only rejects instead of taking, and a
  // good-till-date order auto-cancels on-chain at the chosen expiry.
  const [postOnly, setPostOnly] = useState(false);
  const [expiry, setExpiry] = useState<'never' | '1h' | '4h' | '1d' | '1w'>('never');
  // Chase: client-side keeper that re-pegs the limit order to the top of the
  // book via the one-click session key until it fills.
  const [chase, setChase] = useState(false);
  const [chaseId, setChaseId] = useState<string | null>(null);
  const [chaseReprices, setChaseReprices] = useState(0);
  const currentPosition = useMemo(() => {
    return positions.find((p) => p.marketId === market.id);
  }, [positions, market.id]);

  const orderSummary = useMemo(() => {
    const ticker = tickers[market.id];
    const price = trade.orderType === 'market'
      ? (ticker?.markPrice || 0)
      : parseFloat(trade.price) || 0;
    const size = parseFloat(trade.size) || 0;
    if (!price || !size) return null;

    const notional = price * size;
    const marginRequired = notional / trade.leverage;
    const maintenanceMargin = notional * 0.005;
    const liqDistance = (marginRequired - maintenanceMargin) / size;
    const liquidationPrice = trade.side === 'buy'
      ? Math.max(0, price - liqDistance)
      : price + liqDistance;
    const takerFee = notional * 0.0005;
    const makerFee = notional * 0.0002;
    const fee = trade.orderType === 'market' ? takerFee : makerFee;

    return { notional, marginRequired, liquidationPrice, fee };
  }, [tickers, market.id, trade]);

  const calcSize = () => {
    const r = parseFloat(riskPct) / 100;
    const entry = parseFloat(calcEntry);
    const sl = parseFloat(calcSl);
    if (!r || !entry || !sl || entry === sl) return '—';
    const riskPerUnit = Math.abs(entry - sl);
    const accountSize = collateral > 0 ? collateral : 10000;
    return (accountSize * r / riskPerUnit).toFixed(4);
  };

  const handleSubmit = async () => {
    if (!isConnected || !address) {
      toast('Connect wallet first', 'error');
      return;
    }
    if (!trade.price && trade.orderType === 'limit') {
      toast('Enter a price', 'error');
      return;
    }
    if (!trade.size) {
      toast('Enter a size', 'error');
      return;
    }

    const useOneClick = oneClickEnabled && !!sessionKey;
    if (!skipConfirm && !useOneClick) {
      // Inline confirm sheet (see below) — never a native window.confirm popup.
      setConfirming(true);
      return;
    }

    await executeOrder(useOneClick);
  };

  /**
   * After a limit/market order mines, diff open orders + position size to
   * report what actually happened: filled (and at what average), resting on
   * the book, partially filled, or — for market orders — no fill at all.
   * Polls briefly because the API indexer trails the chain by a block or two.
   */
  /** Snapshot open-order ids + position size BEFORE sending the tx — the
   * outcome diff is only meaningful against a pre-trade baseline. */
  const snapshotAccount = async (owner: string) => {
    const posSize = (list: { marketId: number; size: number | string }[]) =>
      Number(list.find((p) => p.marketId === market.id)?.size ?? 0);
    const orderKey = (o: { id?: unknown; orderId?: unknown }) => String(o.id ?? o.orderId);
    try {
      const [o, p] = await Promise.all([api.getOrders(owner), api.getPositions(owner)]);
      return { ids: new Set((o.orders || []).map(orderKey)), size: posSize(p.positions || []) };
    } catch {
      return { ids: new Set<string>(), size: 0 };
    }
  };

  const reportOutcome = async (owner: string, isBuy: boolean, price: string, before: { ids: Set<string>; size: number }, requestedSize?: string) => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const posSize = (list: { marketId: number; size: number | string }[]) =>
      Number(list.find((p) => p.marketId === market.id)?.size ?? 0);
    const orderKey = (o: { id?: unknown; orderId?: unknown }) => String(o.id ?? o.orderId);
    const beforeIds = before.ids;
    const beforeSize = before.size;

    for (let i = 0; i < 6; i++) {
      await sleep(1500);
      try {
        const [o, p] = await Promise.all([api.getOrders(owner), api.getPositions(owner)]);
        const afterSize = posSize(p.positions || []);
        const filled = Math.max(0, isBuy ? afterSize - beforeSize : beforeSize - afterSize);
        const resting = (o.orders || []).filter((ro) => !beforeIds.has(orderKey(ro)));
        const notify = useStore.getState().addNotification;
        if (filled > 0 && resting.length > 0) {
          const msg = `Partially filled ${formatNumber(filled, 4)} ${market.base} — remainder resting @ ${price}`;
          toast(msg, 'success');
          notify('fill', 'Partial fill', `${market.symbol}: ${msg}`);
          return;
        }
        if (filled > 0) {
          const entry = (p.positions || []).find((x) => x.marketId === market.id)?.entryPrice;
          const requested = requestedSize ? Number(requestedSize) : 0;
          const shortfall = requested > 0 && filled < requested - 1e-9;
          const msg = shortfall
            ? `Filled ${formatNumber(filled, 4)} of ${requestedSize} ${market.base}${entry ? ` @ ${formatPrice(Number(entry))}` : ''} — book depth exhausted`
            : `Filled ${formatNumber(filled, 4)} ${market.base}${entry ? ` @ ${formatPrice(Number(entry))}` : ''}`;
          toast(msg, shortfall ? 'warning' : 'success');
          notify('fill', `${isBuy ? 'Bought' : 'Sold'} ${market.base}`, `${market.symbol}: ${msg}`);
          return;
        }
        if (resting.length > 0) {
          toast(`Order resting on the book @ ${price}`, 'success');
          return;
        }
      } catch { /* retry */ }
    }
    // Nothing changed after polling: an IOC/market order that crossed nothing.
    toast('No fill — no liquidity within your slippage tolerance', 'warning');
    useStore.getState().addNotification('warning', 'No fill', `${market.symbol}: order crossed nothing within your slippage tolerance`);
  };

  const executeOrder = async (useOneClick: boolean) => {
    setConfirming(false);
    if (!address) {
      toast('Connect wallet first', 'error');
      return;
    }
    const walletAddress = address;
    setLoading(true);
    try {
      // Private mode: route through the shielded intent lane instead of the
      // transparent CLOB. Side is salted, authorship hidden; the wallet
      // records the order locally for client-side reconstruction.
      if (shieldedActive) {
        if (trade.orderType !== 'limit' && trade.orderType !== 'market') {
          throw new Error('Private mode supports limit and market orders');
        }
        const vk = loadViewingKey();
        if (!vk) {
          throw new Error('Set up a viewing key in the Privacy panel first');
        }
        let priceForOrder = trade.price;
        if (trade.orderType === 'market') {
          const m = tickers[market.id]?.markPrice || 0;
          if (!m) throw new Error('No mark price available. Try again in a moment.');
          const slippagePct = (useStore.getState().slippage || 1) / 100;
          priceForOrder = trade.side === 'buy'
            ? (m * (1 + slippagePct)).toFixed(8)
            : (m * (1 - slippagePct)).toFixed(8);
        }
        const { intentId } = await submitShieldedOrder(vk, {
          marketId: market.id,
          side: trade.side,
          price: toChainUnits(priceForOrder),
          size: toChainUnits(trade.size),
        });
        toast(`Shielded ${trade.side} order submitted (${intentId.slice(0, 10)}…)`, 'success');
        if (useStore.getState().soundEnabled) playSound('fill');
        setTrade({ size: '' });
        return;
      }

      let orderOwner = walletAddress;
      if (useOneClick) {
        try {
          const { ethers } = await import('ethers');
          const sessionWallet = new ethers.Wallet(sessionKey!);
          orderOwner = sessionWallet.address;
        } catch {
          orderOwner = walletAddress;
        }
      }

      // Attach the captured referral builder code (from a ?ref= link) so the
      // referrer is credited — this is the only signal the API records.
      const builderCode = getReferralCode() || undefined;

      if (trade.orderType !== 'limit' && trade.orderType !== 'market') {
        // Defensive: a stale persisted orderType (stop/trail/twap/scale from an
        // older session) must never reach the server-side engines, which cannot
        // execute unsigned orders. Reset to limit and tell the user plainly.
        setTrade({ orderType: 'limit' as never });
        throw new Error(
          `${trade.orderType.toUpperCase()} orders are disabled until signed execution ships — use TP/SL brackets or Chase instead.`,
        );
      }
      {
        // Limit / market orders are signed by the wallet and sent straight to
        // Mersennet's native on-chain CLOB precompile (0x…0100), where the
        // matching engine runs atomically and the order owner IS the verified
        // transaction signer. The API no longer places orders on a caller's
        // behalf (that trusted an unsigned `owner` field — account takeover).
        // Chase order: hand off to the client-side keeper, which places a
        // post-only order at the top of the book and re-pegs it on every move.
        if (trade.orderType === 'limit' && chase) {
          if (!useOneClick || !sessionKey) {
            throw new Error('Chase orders need one-click trading (session key) — enable it in settings.');
          }
          const { startChase } = await import('@/lib/chase');
          const marketSymbol = market.symbol;
          const id = await startChase({
            marketId: market.id,
            isBuy: trade.side === 'buy',
            size: toChainUnits(trade.size),
            sessionKey,
            onEvent: (evt) => {
              if (evt.kind === 'repriced') {
                setChaseReprices(evt.reprices || 0);
              } else if (evt.kind === 'filled') {
                setChaseId(null);
                setChaseReprices(0);
                toast(`Chase order filled on ${marketSymbol}`, 'success');
                if (useStore.getState().soundEnabled) playSound('fill');
              } else if (evt.kind === 'stopped') {
                setChaseId(null);
                setChaseReprices(0);
                toast(`Chase stopped: ${evt.message}`, 'info');
              }
            },
          });
          setChaseId(id);
          setChaseReprices(0);
          toast(`Chasing top of book on ${marketSymbol}`, 'success');
          setTrade({ size: '' });
          return;
        }
        const ticker = tickers[market.id];
        let priceForOrder = trade.price;
        const { placeOrderOnChain, marketableLimitPrice } = await import('@/lib/orderSigning');
        if (trade.orderType === 'market') {
          // Price *through* the live book by ≥1 tick, bounded by slippage, so a
          // market order actually crosses on integer-tick markets (mark ±
          // slippage rounded to an int silently no-fills on e.g. MRSN ≈ 98).
          priceForOrder = await marketableLimitPrice(
            market.id,
            trade.side === 'buy',
            useStore.getState().slippage || 1,
            ticker?.markPrice || 0,
          );
        }
        const tif = trade.orderType === 'market'
          ? 'Ioc'
          : trade.tif === 'gtc' ? 'Gtc' : trade.tif === 'ioc' ? 'Ioc' : 'Fok';
        void builderCode; // referral credit now derives from on-chain fills, not an API hint
        // Snapshot BEFORE sending — the outcome diff needs a pre-trade baseline.
        const before = await snapshotAccount(orderOwner);
        // Optimistic pending order: the Orders tab shows it instantly (marked
        // pending) for the whole wallet-sign → mine window, not just after.
        const tempId = `pending-${Date.now()}`;
        useStore.getState().addPendingOrder({
          tempId,
          owner: orderOwner,
          market_id: market.id,
          side: trade.side,
          price: String(priceForOrder),
          size: trade.size,
          tif,
          ts: Date.now(),
        });
        // Good-till-date: convert the chosen duration to an absolute chain
        // block height (~2s blocks). Only meaningful for resting GTC limits.
        const isRestingLimit = trade.orderType !== 'market' && tif === 'Gtc';
        let expireAtBlock = 0;
        if (isRestingLimit && expiry !== 'never') {
          const seconds = { '1h': 3_600, '4h': 14_400, '1d': 86_400, '1w': 604_800 }[expiry];
          try {
            const { getDefaultChain } = await import('@/lib/chain');
            const res = await fetch(getDefaultChain().rpcUrls[0], {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
            });
            const { result } = await res.json();
            expireAtBlock = parseInt(result, 16) + Math.ceil(seconds / 2);
          } catch {
            // If the head lookup fails, place without expiry rather than fail.
            expireAtBlock = 0;
          }
        }
        try {
          await placeOrderOnChain(provider, {
            marketId: market.id,
            isBuy: trade.side === 'buy',
            priceUsd: priceForOrder,
            sizeBase: trade.size,
            tif,
            maker: isRestingLimit && (postOnly || expireAtBlock > 0)
              ? { postOnly, expireAtBlock: expireAtBlock || undefined }
              : undefined,
            sessionKey: useOneClick ? sessionKey || undefined : undefined,
          });
        } catch (e) {
          useStore.getState().removePendingOrder(tempId);
          const msg = (e as Error).message || '';
          if (msg.includes('post-only')) {
            throw new Error('Post-only order would cross the book — adjust your price or disable Post Only.');
          }
          throw e;
        }
        // Report the real outcome (filled / resting / partial / no fill) instead
        // of a blind "placed" — the tx mining only proves inclusion, not a fill.
        void reportOutcome(orderOwner, trade.side === 'buy', String(priceForOrder), before, trade.size);
      }
      if (useStore.getState().soundEnabled) playSound('fill');
      setTrade({ size: '' });
    } catch (e) {
      toast(`Order failed: ${(e as Error).message}`, 'error');
      if (useStore.getState().soundEnabled) playSound('alert');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div data-trade-form className="relative bg-surface border border-border rounded-xl md:border-0 md:rounded-none p-2.5 md:p-3 xl:p-3.5 flex flex-col gap-2 overflow-hidden shrink-0">
      {/* Inline order confirmation — replaces the native window.confirm popup.
          Shows the full order ticket and keeps the user in the terminal. */}
      {confirming && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/85 backdrop-blur-sm p-4">
          <div className="w-full max-w-[260px] bg-surface border border-border rounded-xl p-4 shadow-2xl">
            <p className="text-[13px] font-semibold text-foreground mb-3">Confirm Order</p>
            <div className="space-y-1.5 text-[11px] font-mono">
              <div className="flex justify-between">
                <span className="text-dim">Side</span>
                <span className={trade.side === 'buy' ? 'text-green font-semibold' : 'text-red font-semibold'}>
                  {trade.side === 'buy' ? (isSpot ? 'Buy' : 'Long') : (isSpot ? 'Sell' : 'Short')}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Market</span>
                <span className="text-foreground">{market.base}/{market.quote}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Type</span>
                <span className="text-foreground capitalize">{trade.orderType}{trade.orderType !== 'market' ? ` · ${trade.tif.toUpperCase()}` : ' · IOC'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Price</span>
                <span className="text-foreground">{trade.orderType === 'market' ? 'Market' : trade.price}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">Size</span>
                <span className="text-foreground">{trade.size} {market.base}</span>
              </div>
              {!isSpot && (
                <div className="flex justify-between">
                  <span className="text-dim">Leverage</span>
                  <span className="text-foreground">{trade.leverage}×</span>
                </div>
              )}
              {orderSummary && (
                <div className="flex justify-between pt-1.5 border-t border-border/50">
                  <span className="text-dim">Est. Fee</span>
                  <span className="text-foreground">{formatNumber(orderSummary.fee, 4)} {market.quote}</span>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setConfirming(false)}
                className="flex-1 py-2 rounded-md bg-surface-2 border border-border text-[12px] font-medium text-dim hover:text-foreground transition-colors"
              >Cancel</button>
              <button
                onClick={() => void executeOrder(oneClickEnabled && !!sessionKey)}
                className={cn(
                  'flex-1 py-2 rounded-md text-[12px] font-semibold text-white transition-colors',
                  trade.side === 'buy' ? 'bg-green hover:bg-green/90' : 'bg-red hover:bg-red/90'
                )}
              >Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Side toggle. Parent uses background color + gap-px so the 1px gap
          reads as a thin dark divider between cells. */}
      <div className="flex gap-px bg-background rounded-md overflow-hidden border border-border">
        <button
          onClick={() => setTrade({ side: 'buy' })}
          className={cn(
            'flex-1 py-1.5 text-[13px] font-semibold transition-colors',
            trade.side === 'buy'
              ? 'bg-green/15 text-green'
              : 'bg-surface-2 text-dim hover:text-foreground'
          )}
        >{isSpot ? t('trade.buy', 'Buy') : t('trade.long', 'Long')}</button>
        <button
          onClick={() => setTrade({ side: 'sell' })}
          className={cn(
            'flex-1 py-1.5 text-[13px] font-semibold transition-colors',
            trade.side === 'sell'
              ? 'bg-red/15 text-red'
              : 'bg-surface-2 text-dim hover:text-foreground'
          )}
        >{isSpot ? t('trade.sell', 'Sell') : t('trade.short', 'Short')}</button>
      </div>

      {/* Cross/Isolated + Leverage chip on one compact row (perps only) */}
      {!isSpot && (
        <div className="flex items-center gap-1 text-[11px] flex-wrap">
          <div className="flex bg-surface-2 rounded-md overflow-hidden border border-border shrink-0">
            {(['cross', 'isolated'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMarginMode(m)}
                className={cn(
                  'px-2 py-1 font-medium capitalize transition-colors',
                  marginMode === m ? 'bg-foreground/5 text-foreground' : 'text-dim hover:text-muted'
                )}
              >{m}</button>
            ))}
          </div>
          <span className="ml-auto font-mono text-dim whitespace-nowrap">
            <span className="text-muted">Lev </span>
            <span className="text-foreground font-semibold">{trade.leverage}×</span>
          </span>
          <span className="font-mono text-dim whitespace-nowrap">
            <span className="text-muted">·</span> {formatNumber(collateral, 2)} MRSN
          </span>
        </div>
      )}

      {/* Order type — Limit and Market. Advanced server-triggered types
          (Stop / Trail / TWAP / Scale) are withheld until they execute with
          signed orders; use TP/SL brackets and Chase for protection today. */}
      <div className="relative">
        <div className="flex gap-px bg-background rounded-md border border-border overflow-hidden">
          {SPOT_ORDER_TYPES.map((ot) => (
            <button
              key={ot.value}
              onClick={() => setTrade({ orderType: ot.value as never })}
              className={cn(
                'basis-0 flex-1 min-w-0 px-1 py-1.5 text-[11px] font-semibold transition-colors whitespace-nowrap',
                trade.orderType === ot.value
                  ? 'bg-foreground/[0.07] text-foreground'
                  : 'bg-surface-2 text-dim hover:text-foreground'
              )}
            >{t(ot.tKey, ot.fallback)}</button>
          ))}
        </div>
      </div>

      {/* Current position pill (only when there is one) */}
      {currentPosition && (
        <div className="flex items-center gap-1.5 text-[10px] px-2 py-1 bg-surface-2 rounded-md border border-border">
          <span className="text-dim">Pos</span>
          <span className={cn('font-mono font-semibold', Number(currentPosition.size) > 0 ? 'text-green' : 'text-red')}>
            {Number(currentPosition.size) > 0 ? '+' : '−'}{formatNumber(Math.abs(Number(currentPosition.size)), 4)} {market.base}
          </span>
        </div>
      )}

      {/* Price field */}
      {trade.orderType === 'limit' && (
        <div>
          <label className="text-[11px] text-muted mb-1.5 block font-medium">{t('trade.price', 'Price')} ({market.quote})</label>
          <input
            type="number" value={trade.price}
            aria-label={`Price (${market.quote})`}
            onChange={(e) => setTrade({ price: e.target.value })}
            placeholder="0.00"
            className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60 focus:bg-surface-3 transition-all"
          />
        </div>
      )}
      {trade.orderType === 'market' && (
        <div className="flex items-center px-3 py-2.5 bg-surface-2 border border-border rounded-lg">
          <span className="text-[11px] text-dim">{t('trade.price', 'Price')}</span>
          <span className="ml-auto text-sm font-mono text-foreground/60">{t('trade.market', 'Market')}</span>
        </div>
      )}

      {/* Size */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] text-muted font-medium">{t('trade.size', 'Size')} ({market.base})</label>
          <button onClick={() => setShowCalc(!showCalc)} className="text-[10px] text-primary hover:text-primary-hover font-medium">
            {showCalc ? 'Hide Calc' : 'Size Calc'}
          </button>
        </div>
        <input
          type="number" value={trade.size}
          aria-label={`Size (${market.base})`}
          onChange={(e) => setTrade({ size: e.target.value })}
          placeholder="0.00"
          className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60 focus:bg-surface-3 transition-all"
        />
        {/* Available balance + Max, on their own row so the label never wraps */}
        {isConnected && (
          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-dim font-mono">
              Avail <span className="text-foreground/80">{formatNumber(collateral, 2)} MRSN</span>
            </span>
            <button
              onClick={() => {
                const markPrice = tickers[market.id]?.markPrice || 0;
                if (!markPrice || !collateral) return;
                setTrade({ size: ((collateral * trade.leverage) / markPrice).toFixed(4) });
              }}
              className="text-[10px] text-primary hover:text-primary-hover font-medium"
            >Max</button>
          </div>
        )}
        {/* Size % presets */}
        <div className="flex gap-px bg-background rounded-md border border-border overflow-hidden mt-1.5">
          {SIZE_PRESETS.map((pct) => {
            const ticker = tickers[market.id];
            const markPrice = ticker?.markPrice || 0;
            return (
              <button
                key={pct}
                onClick={() => {
                  if (!markPrice || !collateral) return;
                  const maxNotional = collateral * trade.leverage;
                  const maxSize = maxNotional / markPrice;
                  const s = (maxSize * pct / 100).toFixed(4);
                  setTrade({ size: s });
                }}
                className="flex-1 py-1 text-[10.5px] font-medium bg-surface-2 text-dim hover:text-foreground transition-colors"
              >{pct}%</button>
            );
          })}
        </div>
      </div>

      {/* Position size calculator */}
      {showCalc && (
        <div className="p-2.5 bg-surface-2 rounded-lg space-y-2 border border-border">
          <p className="text-[10px] text-dim uppercase tracking-wider font-semibold">Position Size Calculator</p>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-dim block mb-1">Risk %</label>
              <input type="number" value={riskPct} onChange={(e) => setRiskPct(e.target.value)}
                className="w-full bg-surface border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-primary/40" />
            </div>
            <div>
              <label className="text-[10px] text-dim block mb-1">Entry</label>
              <input type="number" value={calcEntry} onChange={(e) => setCalcEntry(e.target.value)}
                className="w-full bg-surface border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-primary/40" />
            </div>
            <div>
              <label className="text-[10px] text-dim block mb-1">Stop Loss</label>
              <input type="number" value={calcSl} onChange={(e) => setCalcSl(e.target.value)}
                className="w-full bg-surface border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-primary/40" />
            </div>
          </div>
          <div className="flex items-center justify-between pt-1 border-t border-border/50">
            <span className="text-[11px] text-muted">Suggested size:</span>
            <button
              onClick={() => { const s = calcSize(); if (s !== '—') setTrade({ size: s }); }}
              className="text-[11px] text-primary font-mono font-semibold hover:underline"
            >{calcSize()} {market.base}</button>
          </div>
        </div>
      )}

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Leverage (perps only) */}
      {!isSpot && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[11px] text-muted font-medium">{t('trade.leverage', 'Leverage')}</label>
            <span className="text-xs font-mono font-semibold text-foreground">{trade.leverage}×</span>
          </div>
          <input
            type="range" min={1} max={market.maxLeverage} value={trade.leverage}
            aria-label="Leverage"
            onChange={(e) => setTrade({ leverage: Number(e.target.value) })}
            className="range-fill w-full"
            style={{ ['--pct' as string]: `${((trade.leverage - 1) / Math.max(1, market.maxLeverage - 1)) * 100}%` }}
          />
          <div className="flex gap-px bg-background rounded-md border border-border overflow-hidden mt-1.5">
            {LEVERAGE_PRESETS.filter(l => l <= market.maxLeverage).map((l) => (
              <button key={l} onClick={() => setTrade({ leverage: l })}
                className={cn(
                  'flex-1 py-1 text-[10.5px] font-medium font-mono transition-colors',
                  trade.leverage === l
                    ? 'bg-foreground/[0.07] text-foreground'
                    : 'bg-surface-2 text-dim hover:text-foreground'
                )}
              >{l}×</button>
            ))}
          </div>
        </div>
      )}

      {/* TIF + Slippage on the same compact row */}
      <div className="flex items-center gap-1">
        <div className="flex flex-1 gap-px bg-background rounded-md border border-border overflow-hidden">
          {(['gtc', 'ioc', 'fok'] as const).map((tifVal) => (
            <button key={tifVal} onClick={() => setTrade({ tif: tifVal })}
              className={cn(
                'flex-1 py-1 text-[10.5px] font-medium uppercase tracking-wide transition-colors',
                trade.tif === tifVal ? 'bg-foreground/[0.07] text-foreground' : 'bg-surface-2 text-dim hover:text-foreground'
              )}
            >{tifVal}</button>
          ))}
        </div>
        <button
          onClick={() => useStore.getState().setShowSettings(true)}
          className="px-2 py-1 bg-surface-2 rounded-md border border-border text-[10.5px] text-dim hover:text-foreground transition-colors font-mono whitespace-nowrap"
          title="Slippage tolerance: click to change"
        >
          Slip {useStore.getState().slippage}%
        </button>
      </div>

      {/* Options row (perps-specific options hidden in spot) */}
      <div className="flex items-center gap-4 flex-wrap">
        {!isSpot && (
          <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer select-none"
            title="Attach take-profit and stop-loss trigger prices to this order">
            <input type="checkbox" checked={trade.tpEnabled}
              onChange={(e) => setTrade({ tpEnabled: e.target.checked })} className="accent-primary w-3.5 h-3.5 rounded" />
            {t('trade.tp', 'TP')}/{t('trade.sl', 'SL')}
          </label>
        )}
        {!isSpot && (
          <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer select-none"
            title="Order can only reduce your existing position, never increase or flip it">
            <input type="checkbox" checked={trade.reduceOnly}
              onChange={(e) => setTrade({ reduceOnly: e.target.checked })} className="accent-primary w-3.5 h-3.5 rounded" />
            {t('trade.reduceOnly', 'Reduce Only')}
          </label>
        )}
        {trade.orderType === 'limit' && trade.tif === 'gtc' && (
          <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer select-none"
            title="Maker-only: the chain rejects the order instead of letting it take liquidity">
            <input type="checkbox" checked={postOnly}
              onChange={(e) => setPostOnly(e.target.checked)} className="accent-primary w-3.5 h-3.5 rounded" />
            Post Only
          </label>
        )}
        {trade.orderType === 'limit' && trade.tif === 'gtc' && (
          <label className={cn(
            'flex items-center gap-2 text-[11px] select-none',
            oneClickEnabled && sessionKey ? 'text-muted cursor-pointer' : 'text-dim/60 cursor-not-allowed'
          )}
            title={oneClickEnabled && sessionKey
              ? 'Auto-reprice: keeps this order pegged to the top of the book (cancels + re-places via your one-click session key) until it fills'
              : 'Chase needs one-click trading — enable it in settings so reprices can sign without popups'}>
            <input type="checkbox" checked={chase} disabled={!oneClickEnabled || !sessionKey}
              onChange={(e) => setChase(e.target.checked)} className="accent-primary w-3.5 h-3.5 rounded" />
            Chase
          </label>
        )}
      </div>

      {/* Active chase banner */}
      {chaseId && (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-primary/[0.08] border border-primary/30 rounded-lg">
          <span className="text-[11px] text-foreground">
            Chasing top of book
            <span className="text-dim font-mono"> · {chaseReprices} reprice{chaseReprices === 1 ? '' : 's'}</span>
          </span>
          <button
            onClick={async () => {
              const { stopChase } = await import('@/lib/chase');
              if (chaseId) stopChase(chaseId);
            }}
            className="px-2 py-0.5 text-[10.5px] font-medium text-red border border-red/40 rounded-md hover:bg-red/10 transition-colors"
          >Stop</button>
        </div>
      )}

      {/* Good-till-date: the chain auto-cancels the resting order at expiry */}
      {trade.orderType === 'limit' && trade.tif === 'gtc' && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] text-dim whitespace-nowrap" title="On-chain expiry: the order cancels itself at the chosen time, even with the tab closed">Expires</span>
          <div className="flex flex-1 gap-px bg-background rounded-md border border-border overflow-hidden">
            {(['never', '1h', '4h', '1d', '1w'] as const).map((v) => (
              <button key={v} onClick={() => setExpiry(v)}
                className={cn(
                  'flex-1 py-1 text-[10px] font-medium uppercase tracking-wide transition-colors',
                  expiry === v ? 'bg-foreground/[0.07] text-foreground' : 'bg-surface-2 text-dim hover:text-foreground'
                )}
              >{v === 'never' ? 'GTC' : v}</button>
            ))}
          </div>
        </div>
      )}

      {/* TP/SL */}
      {trade.tpEnabled && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] text-muted mb-1.5 block font-medium">{t('trade.takeProfit', 'Take Profit')}</label>
            <input type="number" value={trade.tpPrice}
              onChange={(e) => setTrade({ tpPrice: e.target.value })}
              placeholder="TP Price"
              className="w-full bg-surface-2 border border-border rounded-lg px-2.5 py-2 text-xs text-foreground font-mono outline-none focus:border-green/40 transition-all" />
          </div>
          <div>
            <label className="text-[11px] text-muted mb-1.5 block font-medium">{t('trade.stopLoss', 'Stop Loss')}</label>
            <input type="number" value={trade.slPrice}
              onChange={(e) => setTrade({ slPrice: e.target.value })}
              placeholder="SL Price"
              className="w-full bg-surface-2 border border-border rounded-lg px-2.5 py-2 text-xs text-foreground font-mono outline-none focus:border-red/40 transition-all" />
          </div>
        </div>
      )}

      {/* Shielded-route indicator: visible whenever private mode will apply
          to the next order so the user always knows which lane they're on. */}
      {shieldedActive && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-primary/10 border border-primary/20">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary shrink-0">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span className="text-[10px] text-primary font-medium">Private mode — order routes through the shielded lane</span>
        </div>
      )}

      {/* Submit — flat colored button, no glow. Label is a single short verb
          ("Place Order" / "Connect Wallet") since the directional intent is
          already shown by the Long/Short toggle and the button color. */}
      <button
        data-submit-order
        onClick={handleSubmit}
        disabled={loading || !isConnected}
        className={cn(
          'w-full py-2.5 rounded-md text-[13px] font-semibold tracking-wide transition-colors disabled:cursor-not-allowed mt-0.5',
          !isConnected
            ? 'bg-surface-2 text-dim border border-border'
            : trade.side === 'buy'
              ? 'bg-green hover:bg-green/90 text-white shadow-[0_0_14px_rgba(52,211,153,0.18)]'
              : 'bg-red hover:bg-red/90 text-white shadow-[0_0_14px_rgba(255,82,64,0.15)]'
        )}
      >
        {loading
          ? t('trade.placing', 'Placing…')
          : !isConnected
            ? t('common.connectWallet', 'Connect Wallet')
            : t('trade.placeOrder', 'Place Order')}
      </button>

      {/* Order Summary — notional is the headline number (how traders actually
          size), the rest stays small. */}
      {orderSummary && (
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted font-medium">Order Value</span>
            <span className="font-mono text-[15px] font-semibold text-foreground tabular-nums">
              {formatNumber(orderSummary.notional, 2)} <span className="text-[10px] text-dim font-normal">{market.quote}</span>
            </span>
          </div>
          {!isSpot && (
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-dim">Margin Required</span>
              <span className="font-mono text-foreground">{formatNumber(orderSummary.marginRequired, 2)} MRSN</span>
            </div>
          )}
          {!isSpot && (
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-dim">Liquidation Price</span>
              <span className="font-mono text-yellow">{formatPrice(orderSummary.liquidationPrice)}</span>
            </div>
          )}
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-dim">Est. Fee</span>
            <span className="font-mono text-foreground/60">{formatNumber(orderSummary.fee, 4)} MRSN</span>
          </div>
        </div>
      )}
    </div>
  );
}
