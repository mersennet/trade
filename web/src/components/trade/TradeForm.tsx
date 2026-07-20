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
const PRO_ORDER_TYPES = [
  { value: 'stop', tKey: 'trade.stop', fallback: 'Stop', desc: 'Trigger at price' },
  { value: 'trailing', tKey: 'trade.trailingShort', fallback: 'Trail', desc: 'Follow the market' },
  { value: 'twap', tKey: 'trade.twap', fallback: 'TWAP', desc: 'Slice over time' },
  { value: 'scale', tKey: 'trade.scale', fallback: 'Scale', desc: 'Ladder of limits' },
] as const;

const LEVERAGE_PRESETS = [1, 2, 5, 10, 25, 50];
const SIZE_PRESETS = [25, 50, 75, 100];

const SPOT_ORDER_TYPES = [
  { value: 'limit', tKey: 'trade.limit', fallback: 'Limit' },
  { value: 'market', tKey: 'trade.market', fallback: 'Market' },
] as const;

export default function TradeForm() {
  const { market, trade, setTrade, skipConfirm, marginMode, setMarginMode, tickers, positions, oneClickEnabled, sessionKey, gaslessEnabled, setGasless } = useStore();
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
  const [showCalc, setShowCalc] = useState(false);
  const [riskPct, setRiskPct] = useState('2');
  const [calcEntry, setCalcEntry] = useState('');
  const [calcSl, setCalcSl] = useState('');
  const [twapSlices, setTwapSlices] = useState('10');
  const [twapDuration, setTwapDuration] = useState('60');
  const [scalePriceFrom, setScalePriceFrom] = useState('');
  const [scalePriceTo, setScalePriceTo] = useState('');
  const [showProTypes, setShowProTypes] = useState(false);

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
    if (!trade.price && (trade.orderType === 'limit' || trade.orderType === 'stop')) {
      toast('Enter a price', 'error');
      return;
    }
    if (!trade.size) {
      toast('Enter a size', 'error');
      return;
    }

    const useOneClick = oneClickEnabled && !!sessionKey;
    if (!skipConfirm && !useOneClick) {
      const priceLabel = trade.orderType === 'market' ? 'Market' : trade.price;
      const confirmed = window.confirm(
        `${trade.side.toUpperCase()} ${trade.size} ${market.base} @ ${priceLabel} (${trade.leverage}x)?`
      );
      if (!confirmed) return;
    }

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

      let orderOwner = address;
      if (useOneClick) {
        try {
          const { ethers } = await import('ethers');
          const sessionWallet = new ethers.Wallet(sessionKey!);
          orderOwner = sessionWallet.address;
        } catch {
          orderOwner = address;
        }
      }

      // Attach the captured referral builder code (from a ?ref= link) so the
      // referrer is credited — this is the only signal the API records.
      const builderCode = getReferralCode() || undefined;

      if (trade.orderType === 'twap' || trade.orderType === 'scale') {
        await api.submitTwap({
          owner: orderOwner,
          market_id: market.id,
          side: trade.side === 'buy' ? 'Buy' : 'Sell',
          total_size: parseFloat(trade.size),
          price_limit: trade.price ? parseFloat(trade.price) : undefined,
          slices: parseInt(twapSlices) || 10,
          duration_ms: (parseInt(twapDuration) || 60) * 1000,
          order_type: trade.orderType,
        });
        toast(`${trade.orderType.toUpperCase()} order submitted (${twapSlices} slices)`, 'success');
      } else if (trade.orderType === 'stop' || trade.orderType === 'trailing') {
        // Conditional orders are not signed; the API stores them and triggers
        // the actual signed market order when the trigger fires.
        await api.submitOrder({
          owner: orderOwner,
          market_id: market.id,
          side: trade.side === 'buy' ? 'Buy' : 'Sell',
          price: trade.price,
          size: trade.size,
          tif: trade.tif === 'gtc' ? 'Gtc' : trade.tif === 'ioc' ? 'Ioc' : 'Fok',
          leverage: trade.leverage,
          order_type: trade.orderType,
          tp_price: trade.tpEnabled && trade.tpPrice ? trade.tpPrice : undefined,
          sl_price: trade.slPrice ? trade.slPrice : undefined,
          trigger_price: (trade.orderType === 'stop') ? trade.price : undefined,
          trailing_pct: (trade.orderType === 'trailing') ? trade.price : undefined,
          reduce_only: trade.reduceOnly,
          builder_code: builderCode,
        });
        toast(`${trade.orderType.toUpperCase()} trigger order armed`, 'success');
      } else {
        // Limit / market orders are signed by the wallet and sent straight to
        // Mersennet's native on-chain CLOB precompile (0x…0100), where the
        // matching engine runs atomically and the order owner IS the verified
        // transaction signer. The API no longer places orders on a caller's
        // behalf (that trusted an unsigned `owner` field — account takeover).
        const ticker = tickers[market.id];
        const slippagePct = (useStore.getState().slippage || 1) / 100;
        let priceForOrder = trade.price;
        if (trade.orderType === 'market') {
          const m = ticker?.markPrice || 0;
          if (!m) throw new Error('No mark price available. Try again in a moment.');
          // Fixed-decimal, never scientific notation (toString() emits "1e-8"
          // for small numbers, which does not parse as a base-10 amount).
          priceForOrder = trade.side === 'buy'
            ? (m * (1 + slippagePct)).toFixed(8)
            : (m * (1 - slippagePct)).toFixed(8);
        }
        const { placeOrderOnChain } = await import('@/lib/orderSigning');
        const tif = trade.orderType === 'market'
          ? 'Ioc'
          : trade.tif === 'gtc' ? 'Gtc' : trade.tif === 'ioc' ? 'Ioc' : 'Fok';
        void builderCode; // referral credit now derives from on-chain fills, not an API hint
        await placeOrderOnChain(provider, {
          marketId: market.id,
          isBuy: trade.side === 'buy',
          priceUsd: priceForOrder,
          sizeBase: trade.size,
          tif,
          sessionKey: useOneClick ? sessionKey || undefined : undefined,
        });
        toast(`${trade.side === 'buy' ? 'Buy' : 'Sell'} ${trade.orderType} order placed`, 'success');
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
    <div className="bg-surface border border-border rounded-xl md:border-0 md:rounded-none p-2.5 md:p-3 xl:p-3.5 flex flex-col gap-2 overflow-hidden">
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
        <div className="flex items-center gap-1 text-[11px]">
          <div className="flex bg-surface-2 rounded-md overflow-hidden border border-border">
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
          <span className="ml-auto font-mono text-dim">
            <span className="text-muted">Lev </span>
            <span className="text-foreground font-semibold">{trade.leverage}×</span>
          </span>
          <span className="font-mono text-dim">
            <span className="text-muted">·</span> {formatNumber(collateral, 2)} MRSN
          </span>
        </div>
      )}

      {/* Order type — tiered segmented control: Limit and Market are the
          primary (most used) choices at readable size; the advanced types
          (Stop / Trail / TWAP / Scale) live behind a "Pro" dropdown so they
          don't shrink the common path down to 9px labels. */}
      <div className="relative">
        <div className="flex gap-px bg-background rounded-md border border-border overflow-hidden">
          {SPOT_ORDER_TYPES.map((ot) => (
            <button
              key={ot.value}
              onClick={() => { setTrade({ orderType: ot.value as never }); setShowProTypes(false); }}
              className={cn(
                'basis-0 flex-1 min-w-0 px-1 py-1.5 text-[11px] font-semibold transition-colors whitespace-nowrap',
                trade.orderType === ot.value
                  ? 'bg-foreground/[0.07] text-foreground'
                  : 'bg-surface-2 text-dim hover:text-foreground'
              )}
            >{t(ot.tKey, ot.fallback)}</button>
          ))}
          {!isSpot && (
            <button
              onClick={() => setShowProTypes((v) => !v)}
              className={cn(
                'basis-0 flex-1 min-w-0 px-1 py-1.5 text-[11px] font-semibold transition-colors whitespace-nowrap flex items-center justify-center gap-1',
                PRO_ORDER_TYPES.some((ot) => ot.value === trade.orderType)
                  ? 'bg-foreground/[0.07] text-foreground'
                  : 'bg-surface-2 text-dim hover:text-foreground'
              )}
            >
              {PRO_ORDER_TYPES.find((ot) => ot.value === trade.orderType)?.fallback ?? 'Pro'}
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
          )}
        </div>
        {showProTypes && !isSpot && (
          <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-xl z-30 py-1 min-w-[150px]">
            {PRO_ORDER_TYPES.map((ot) => (
              <button
                key={ot.value}
                onClick={() => { setTrade({ orderType: ot.value as never }); setShowProTypes(false); }}
                className={cn(
                  'flex items-center justify-between w-full text-left px-3 py-1.5 text-[11px] transition-colors',
                  trade.orderType === ot.value ? 'text-primary bg-primary/10' : 'text-foreground hover:bg-surface-2'
                )}
              >
                <span className="font-medium">{t(ot.tKey, ot.fallback)}</span>
                <span className="text-[9px] text-dim">{ot.desc}</span>
              </button>
            ))}
          </div>
        )}
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
      {trade.orderType === 'stop' && (
        <div>
          <label className="text-[11px] text-muted mb-1.5 block font-medium">{t('trade.triggerPrice', 'Trigger Price')}</label>
          <input
            type="number" value={trade.price}
            onChange={(e) => setTrade({ price: e.target.value })}
            placeholder="Trigger price"
            className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60 focus:bg-surface-3 transition-all"
          />
        </div>
      )}
      {trade.orderType === 'trailing' && (
        <div>
          <label className="text-[11px] text-muted mb-1.5 block font-medium">Trailing %</label>
          <input
            type="number" value={trade.price}
            onChange={(e) => setTrade({ price: e.target.value })}
            placeholder="e.g. 1.5"
            className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60 focus:bg-surface-3 transition-all"
          />
        </div>
      )}
      {trade.orderType === 'limit' && (
        <div>
          <label className="text-[11px] text-muted mb-1.5 block font-medium">{t('trade.price', 'Price')} ({market.quote})</label>
          <input
            type="number" value={trade.price}
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
      {trade.orderType === 'twap' && (
        <div className="space-y-2">
          <div>
            <label className="text-[11px] text-muted mb-1.5 block font-medium">Price Limit (optional)</label>
            <input type="number" value={trade.price} onChange={(e) => setTrade({ price: e.target.value })}
              placeholder="Max/min price" className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60 focus:bg-surface-3 transition-all" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-dim block mb-1">Slices</label>
              <input type="number" value={twapSlices} onChange={(e) => setTwapSlices(e.target.value)}
                className="w-full bg-surface-2 border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-primary/40" />
            </div>
            <div>
              <label className="text-[10px] text-dim block mb-1">Duration (sec)</label>
              <input type="number" value={twapDuration} onChange={(e) => setTwapDuration(e.target.value)}
                className="w-full bg-surface-2 border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-primary/40" />
            </div>
          </div>
        </div>
      )}
      {trade.orderType === 'scale' && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-dim block mb-1">Price From</label>
              <input type="number" value={scalePriceFrom} onChange={(e) => setScalePriceFrom(e.target.value)}
                className="w-full bg-surface-2 border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-primary/40" />
            </div>
            <div>
              <label className="text-[10px] text-dim block mb-1">Price To</label>
              <input type="number" value={scalePriceTo} onChange={(e) => setScalePriceTo(e.target.value)}
                className="w-full bg-surface-2 border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-primary/40" />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-dim block mb-1">Orders Count</label>
            <input type="number" value={twapSlices} onChange={(e) => setTwapSlices(e.target.value)}
              className="w-full bg-surface-2 border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-primary/40" />
          </div>
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
          onChange={(e) => setTrade({ size: e.target.value })}
          placeholder="0.00"
          className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60 focus:bg-surface-3 transition-all"
        />
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
        <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer select-none"
          title="Submit orders without a wallet signature or gas — Mersennet relays them for free">
          <input type="checkbox" checked={gaslessEnabled}
            onChange={(e) => setGasless(e.target.checked)} className="accent-cyan w-3.5 h-3.5 rounded" />
          {t('trade.gasless', 'Gasless')}
        </label>
      </div>

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

      {/* Order Summary */}
      {orderSummary && (
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-dim">Order Value</span>
            <span className="font-mono text-foreground">{formatNumber(orderSummary.notional, 2)} MRSN</span>
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
