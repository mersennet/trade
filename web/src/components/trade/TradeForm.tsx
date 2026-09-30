'use client';
import { useState, useMemo, useEffect, useRef } from 'react';
import { AGENT_GAS_TOPUP_MRSN } from '@/lib/agent';
import { startPoll } from '@/lib/poll';
import { faucetUrl } from '@/lib/links';
import { useStore } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { useMarketTick } from '@/hooks/useMarketTick';
import { useToast } from '@/components/shared/Toast';
import { api, type ClobProtocol } from '@/lib/api';
import { cn, formatPrice, formatNumber } from '@/lib/utils';
import { getReferralCode } from '@/lib/referral';
import { playSound } from '@/lib/sounds';
import { useTranslation } from '@/i18n';
import { loadViewingKey, submitShieldedOrder, toChainUnits } from '@/lib/shielded';
import { floorLots, splitWholeLots } from '@/lib/lots';
// Stop / Trailing / TWAP are client-side conditional orders (see
// hooks/useConditionalOrders): armed here, watched in the browser, executed as
// signed orders when they trigger — silently with one-click, otherwise with a
// wallet popup at trigger time. Scale places its ladder immediately. Spot
// keeps Limit / Market only.

// Time-in-force in plain words; the acronym stays as the compact label.
const TIF_LABEL: Record<'gtc' | 'ioc' | 'fok', { short: string; long: string; help: string }> = {
  gtc: { short: 'GTC', long: 'Good till cancelled', help: 'Rests on the book until filled or cancelled' },
  ioc: { short: 'IOC', long: 'Immediate or cancel', help: 'Fills what it can right now; the rest is cancelled' },
  fok: { short: 'FOK', long: 'Fill or kill', help: 'Fills completely right now or is cancelled entirely' },
};

// Presets are filtered by the market's max leverage, which is the inverse of
// the initial margin the chain enforces (10% → 10×); the old 25×/50× steps
// were never enforceable.
const LEVERAGE_PRESETS = [1, 2, 3, 5, 10, 25, 50];
/** Slider positions per preset segment; the track is piecewise-linear between presets. */
const LEV_STEPS = 100;
const SIZE_PRESETS = [25, 50, 75, 100];

const SPOT_ORDER_TYPES = [
  { value: 'limit', tKey: 'trade.limit', fallback: 'Limit' },
  { value: 'market', tKey: 'trade.market', fallback: 'Market' },
] as const;
const PERP_ORDER_TYPES = [
  ...SPOT_ORDER_TYPES,
  { value: 'stop', tKey: 'trade.stop', fallback: 'Stop' },
  { value: 'trailing', tKey: 'trade.trailing', fallback: 'Trail' },
  { value: 'scale', tKey: 'trade.scale', fallback: 'Scale' },
  { value: 'twap', tKey: 'trade.twap', fallback: 'TWAP' },
] as const;
const TWAP_DURATIONS: Array<{ value: string; label: string; ms: number }> = [
  { value: '5m', label: '5 min', ms: 5 * 60_000 },
  { value: '15m', label: '15 min', ms: 15 * 60_000 },
  { value: '1h', label: '1 hour', ms: 60 * 60_000 },
  { value: '4h', label: '4 hours', ms: 4 * 60 * 60_000 },
];
const CONDITIONAL_TYPES = new Set(['stop', 'trailing', 'twap']);

export default function TradeForm() {
  const { market, trade, setTrade, skipConfirm, tickers, positions, oneClickEnabled, sessionKey } = useStore();
  // Price inputs step by the market's tick ($0.01 on rescaled markets, $10 on BTC).
  const { step: priceStep, tick: priceTick } = useMarketTick(market);
  // "Place your first order" in the checklist prefilled a 1-unit market buy:
  // bring the form on screen and flash it so the click visibly did something.
  const firstOrderRequestTs = useStore((s) => s.firstOrderRequestTs);
  const formRef = useRef<HTMLDivElement | null>(null);
  const [formFlash, setFormFlash] = useState(false);
  useEffect(() => {
    if (!firstOrderRequestTs) return;
    const t = setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFormFlash(true);
      setTimeout(() => setFormFlash(false), 1600);
    }, 120);
    return () => clearTimeout(t);
  }, [firstOrderRequestTs]);
  const tradeMode = useStore((s) => s.tradeMode);
  const isSpot = tradeMode === 'spot';
  const privateMode = useStore((s) => s.privateMode);
  const privacyForkActive = useStore((s) => s.privacyForkActive);
  const shieldedActive = privateMode && privacyForkActive && !isSpot;
  const { address, isConnected, provider } = useWallet();
  const collateral = useStore((s) => Number(s.wallet.collateral) || 0);
  const walletMrsn = useStore((s) => Number(s.wallet.balance || '0') / 1e18);
  const requestDeposit = useStore((s) => s.requestDeposit);
  const faucetHref = faucetUrl(address);
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [chaseId, setChaseId] = useState<string | null>(null);
  // Conditional / ladder inputs (kept out of the persisted trade slice).
  const [triggerPrice, setTriggerPrice] = useState('');
  const [stopLimit, setStopLimit] = useState(false);
  const [trailPct, setTrailPct] = useState('2');
  const [scaleFrom, setScaleFrom] = useState('');
  const [scaleTo, setScaleTo] = useState('');
  const [scaleCount, setScaleCount] = useState('5');
  const [twapDuration, setTwapDuration] = useState('15m');
  const [twapSlices, setTwapSlices] = useState('10');
  const [chaseReprices, setChaseReprices] = useState(0);
  const currentPosition = useMemo(() => {
    return positions.find((p) => p.marketId === market.id);
  }, [positions, market.id]);
  // What new exposure can use: equity (collateral + unrealized PnL) minus the
  // initial margin open positions already hold (the positions API's `margin`).
  const availableMargin = useMemo(() => {
    const upnl = positions.reduce((s, p) => s + (Number(p.unrealizedPnl) || 0), 0);
    const used = positions.reduce((s, p) => s + (Number(p.margin) || 0), 0);
    return Math.max(0, collateral + upnl - used);
  }, [positions, collateral]);
  // Largest size for this side: closing an opposite position needs no new margin.
  const maxOrderSize = (markPrice: number) => {
    if (!markPrice) return 0;
    const held = Number(currentPosition?.size || 0);
    const closing = trade.side === 'buy' ? Math.max(0, -held) : Math.max(0, held);
    return closing + (availableMargin * trade.leverage) / markPrice;
  };

  // Real fee tier from 30d volume — same source AccountPanel uses. Falls back
  // to the Base tier so the confirm sheet never shows a hardcoded stale rate.
  const [feeRates, setFeeRates] = useState<{ maker: number; taker: number }>({ maker: 0, taker: 0.00035 });
  // The testnet engine charges no maker/taker fee; the schedule is the planned
  // one. While feesCharged is false the estimate is 0 and the sheet says why.
  const [feesCharged, setFeesCharged] = useState(false);
  useEffect(() => {
    if (!address) return;
    Promise.all([api.getStats(), api.getTraderProfile(address)])
      .then(([stats, profile]) => {
        const tiers = (stats.feeTiers || []) as { name: string; minVolume: number; makerFee: number; takerFee: number }[];
        const vol = Number(profile?.stats?.['monthly']?.volume ?? profile?.stats?.['alltime']?.volume ?? 0);
        const tier = [...tiers].sort((a, b) => b.minVolume - a.minVolume).find((t) => vol >= t.minVolume) || tiers[0];
        if (tier) setFeeRates({ maker: tier.makerFee, taker: tier.takerFee });
        setFeesCharged(stats.feesCharged === true);
      })
      .catch(() => {});
  }, [address]);

  // A leverage persisted from before the cap (25×/50× presets) is clamped to
  // the market's enforceable max so notional/margin math never uses it.
  useEffect(() => {
    if (trade.leverage > market.maxLeverage) setTrade({ leverage: market.maxLeverage });
  }, [trade.leverage, market.maxLeverage, setTrade]);
  // Presets this market allows, and the piecewise map between leverage and
  // slider position so the thumb lines up with the preset marks.
  const levPresets = useMemo(() => {
    const p = LEVERAGE_PRESETS.filter((l) => l <= market.maxLeverage);
    return p.length >= 2 ? p : [1, Math.max(2, market.maxLeverage)];
  }, [market.maxLeverage]);
  const levToPos = (lev: number) => {
    const l = Math.min(Math.max(lev, levPresets[0]), levPresets[levPresets.length - 1]);
    for (let i = 0; i < levPresets.length - 1; i++) {
      const a = levPresets[i], b = levPresets[i + 1];
      if (l <= b) return Math.round((i + (l - a) / (b - a)) * LEV_STEPS);
    }
    return (levPresets.length - 1) * LEV_STEPS;
  };
  const posToLev = (pos: number) => {
    const i = Math.min(levPresets.length - 2, Math.max(0, Math.floor(pos / LEV_STEPS)));
    const f = (pos - i * LEV_STEPS) / LEV_STEPS;
    return Math.max(1, Math.round(levPresets[i] + f * (levPresets[i + 1] - levPresets[i])));
  };

  const [protocol, setProtocol] = useState<ClobProtocol | null>(null);
  useEffect(() => {
    let alive = true;
    api.getProtocol().then((p) => { if (alive) setProtocol(p); }).catch(() => {});
    const stop = startPoll(() => api.getProtocol().then((p) => { if (alive) setProtocol(p); }), 60_000);
    return () => { alive = false; stop(); };
  }, []);

  const orderSummary = useMemo(() => {
    const ticker = tickers[market.id];
    // Reference price for the ticket: limit → entered price; stop → trigger
    // (or its limit); scale → midpoint of the ladder; market/trailing/TWAP →
    // current mark.
    const price = trade.orderType === 'limit'
      ? parseFloat(trade.price) || 0
      : trade.orderType === 'stop'
        ? (stopLimit ? parseFloat(trade.price) : parseFloat(triggerPrice)) || 0
        : trade.orderType === 'scale'
          ? ((parseFloat(scaleFrom) || 0) + (parseFloat(scaleTo) || 0)) / 2
          : (ticker?.markPrice || 0);
    const size = parseFloat(trade.size) || 0;
    if (!price || !size) return null;

    const notional = price * size;
    const marginRequired = notional / trade.leverage;
    // Liquidation estimate with the margin the chain enforces (5% maintenance
    // from the settlement switch; the node reports 0 before it, in which
    // case nothing is liquidatable and we show the post-switch rule). Isolated
    // view of this order: collateral = margin posted at the chosen leverage.
    //   long : m = (e − C/s) / (1 − mm)     short: m = (e + C/s) / (1 + mm)
    const mm = (protocol?.maintenanceMarginBps || protocol?.settlementMaintenanceMarginBps || 500) / 10000;
    const cPerUnit = marginRequired / size;
    const liquidationPrice = trade.side === 'buy'
      ? Math.max(0, (price - cPerUnit) / (1 - mm))
      : (price + cPerUnit) / (1 + mm);
    const takes = trade.orderType === 'market' || trade.orderType === 'trailing' || trade.orderType === 'twap' || (trade.orderType === 'stop' && !stopLimit);
    const fee = feesCharged ? notional * (takes ? feeRates.taker : feeRates.maker) : 0;

    // Before the settlement switch the chain enforces no margin, so a ticket
    // can open a position the post-switch rules (10% initial / 5%
    // maintenance) would never allow — and the keeper closes it in the switch
    // block. Flag it here rather than let a tester find out on Sunday.
    const imBps = protocol?.settlementInitialMarginBps || 1000;
    const preSwitchOversized = !!protocol && !protocol.settlementActive && isConnected
      && notional > collateral * (10000 / imBps);

    return { notional, marginRequired, liquidationPrice, fee, preSwitchOversized };
  }, [tickers, market.id, trade, feeRates, feesCharged, stopLimit, triggerPrice, scaleFrom, scaleTo, protocol, collateral, isConnected]);

  const calcSize = () => {
    const r = parseFloat(riskPct) / 100;
    const entry = parseFloat(calcEntry);
    const sl = parseFloat(calcSl);
    if (!r || !entry || !sl || entry === sl) return '—';
    const riskPerUnit = Math.abs(entry - sl);
    // Sizes against real collateral only; an imaginary 10,000 MRSN account
    // produced sizes the chain could never fill.
    if (!(collateral > 0)) return '—';
    return floorLots(collateral * r / riskPerUnit);
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
    if (trade.orderType === 'stop' && !(Number(triggerPrice) > 0)) {
      toast('Enter a trigger price', 'error');
      return;
    }
    if (trade.orderType === 'stop' && stopLimit && !(Number(trade.price) > 0)) {
      toast('Enter the limit price to rest at once triggered', 'error');
      return;
    }
    if (trade.orderType === 'trailing' && !(Number(trailPct) > 0 && Number(trailPct) < 50)) {
      toast('Trail distance must be between 0 and 50%', 'error');
      return;
    }
    if (trade.orderType === 'scale') {
      const a = Number(scaleFrom), b = Number(scaleTo), n = Number(scaleCount);
      if (!(a > 0 && b > 0) || a === b) { toast('Enter a price range for the ladder', 'error'); return; }
      if (!(n >= 2 && n <= 20)) { toast('Ladder size must be between 2 and 20 orders', 'error'); return; }
    }
    if (trade.orderType === 'twap' && !(Number(twapSlices) >= 2 && Number(twapSlices) <= 100)) {
      toast('TWAP needs between 2 and 100 slices', 'error');
      return;
    }
    if (!Number.isInteger(Number(trade.size))) {
      toast(`Sizes are whole ${market.base} on this market (lot 1) — enter ${Math.floor(Number(trade.size)) || 1} or more whole units.`, 'error');
      return;
    }
    const pieces = trade.orderType === 'twap' ? Math.floor(Number(twapSlices)) : trade.orderType === 'scale' ? Math.floor(Number(scaleCount)) : 1;
    if (pieces > 1 && Number(trade.size) < pieces) {
      toast(`${trade.orderType === 'twap' ? 'A TWAP' : 'A ladder'} of ${pieces} orders needs at least ${pieces} ${market.base} — sizes are whole units.`, 'error');
      return;
    }
    // The chain has no reduce-only flag: it is enforced at submission against
    // the live position, which only holds for orders that execute at once.
    const immediate = trade.orderType === 'market' || (trade.orderType === 'limit' && trade.tif !== 'gtc' && !chase);
    if (trade.reduceOnly && !immediate) {
      toast('Reduce Only works with market orders and IOC/FOK limits — a resting or triggered order could open a position if yours closes first.', 'error');
      return;
    }
    const tpN = trade.tpEnabled ? Number(trade.tpPrice) || 0 : 0;
    const slN = trade.tpEnabled ? Number(trade.slPrice) || 0 : 0;
    if (tpN > 0 || slN > 0) {
      if (trade.orderType !== 'market' && trade.orderType !== 'limit') {
        toast('TP/SL attaches to market and limit orders — for other order types, set it on the position once it opens.', 'error');
        return;
      }
      if (trade.reduceOnly) {
        toast('TP/SL cannot be attached to a Reduce Only order.', 'error');
        return;
      }
      const ref = trade.orderType === 'market' ? (tickers[market.id]?.markPrice || 0) : Number(trade.price);
      const long = trade.side === 'buy';
      if (ref > 0 && tpN > 0 && (long ? tpN <= ref : tpN >= ref)) {
        toast(`Take-profit ${tpN} must be ${long ? 'above' : 'below'} ${formatPrice(ref)} for a ${long ? 'long' : 'short'}.`, 'error');
        return;
      }
      if (ref > 0 && slN > 0 && (long ? slN >= ref : slN <= ref)) {
        toast(`Stop-loss ${slN} must be ${long ? 'below' : 'above'} ${formatPrice(ref)} for a ${long ? 'long' : 'short'}.`, 'error');
        return;
      }
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

      // With agent delegation the one-click key signs the transaction but the
      // precompile books the order to the granting account: the owner of every
      // order, position and fill is the connected wallet.
      const orderOwner = walletAddress;

      // Attach the captured referral builder code (from a ?ref= link) so the
      // referrer is credited — this is the only signal the API records.
      const builderCode = getReferralCode() || undefined;

      if (CONDITIONAL_TYPES.has(trade.orderType)) {
        // Arm a client-side conditional order. Nothing touches the chain until
        // the condition is met; the watcher (useConditionalOrders) then signs
        // the order — silently with one-click, otherwise with a wallet popup.
        const id = `${trade.orderType}-${market.id}-${Date.now()}`;
        const isBuy = trade.side === 'buy';
        const base = { id, owner: walletAddress, marketId: market.id, marketSymbol: market.symbol, isBuy, size: trade.size, createdAt: Date.now() };
        if (trade.orderType === 'stop') {
          const trig = Number(triggerPrice);
          const mark = tickers[market.id]?.markPrice || 0;
          if (mark && (isBuy ? trig <= mark : trig >= mark)) {
            throw new Error(`A ${isBuy ? 'buy' : 'sell'} stop must be ${isBuy ? 'above' : 'below'} the current mark (${mark}) — use a limit order for the other direction.`);
          }
          useStore.getState().addConditional({ ...base, kind: 'stop', triggerPrice: trig, limitPrice: stopLimit ? Number(trade.price) : null });
          toast(`${stopLimit ? 'Stop-limit' : 'Stop'} armed on ${market.symbol}: ${isBuy ? 'buy' : 'sell'} ${trade.size} when mark ${isBuy ? '≥' : '≤'} ${trig}`, 'success');
        } else if (trade.orderType === 'trailing') {
          useStore.getState().addConditional({ ...base, kind: 'trailing', trailPct: Number(trailPct) });
          toast(`Trailing stop armed on ${market.symbol}: ${isBuy ? 'buy' : 'sell'} ${trade.size} after a ${trailPct}% retrace`, 'success');
        } else {
          const d = TWAP_DURATIONS.find((x) => x.value === twapDuration) || TWAP_DURATIONS[1];
          const slices = Math.floor(Number(twapSlices));
          useStore.getState().addConditional({ ...base, kind: 'twap', slices, intervalMs: Math.floor(d.ms / slices), executed: 0, nextAt: Date.now() });
          toast(`TWAP started on ${market.symbol}: ${trade.size} in ${slices} slices over ${d.label}${useOneClick ? '' : ' — each slice asks for a wallet signature; enable one-click to run silently'}`, 'success');
        }
        if (!useOneClick) {
          useStore.getState().addNotification('info', 'Conditional order armed', 'Orders arm in this browser and fire while a Mersennet Trade tab is open. Enable one-click trading in Settings so they fire without a wallet popup.');
        }
        setTrade({ size: '' });
        setTriggerPrice('');
        return;
      }
      if (trade.orderType === 'scale') {
        // Ladder: N limit orders spread evenly across [from, to], placed now.
        const { placeOrderOnChain } = await import('@/lib/orderSigning');
        const a = Number(scaleFrom), b = Number(scaleTo), n = Math.floor(Number(scaleCount));
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const step = (hi - lo) / (n - 1);
        const total = Number(trade.size);
        const { getPriceScale: gps, roundToTick } = await import('@/lib/priceScale');
        const scaleScale = await gps(market.id);
        const slices = splitWholeLots(total, n);
        if (slices.some((s) => s === 0)) {
          toast(`A ladder of ${n} orders needs at least ${n} ${market.base} (sizes are whole units) — lower the order count or raise the size.`, 'error');
          return;
        }
        if (!useOneClick) toast(`Placing ${n} orders — your wallet will ask ${n} times (enable one-click to skip)`, 'info');
        let placed = 0;
        for (let i = 0; i < n; i++) {
          const px = roundToTick(lo + step * i, scaleScale); // the market's finest tick
          try {
            await placeOrderOnChain(provider, {
              marketId: market.id,
              isBuy: trade.side === 'buy',
              priceUsd: String(px),
              sizeBase: String(slices[i]),
              tif: 'Gtc',
              maker: postOnly ? { postOnly: true } : undefined,
              sessionKey: useOneClick ? sessionKey || undefined : undefined,
            });
            placed++;
          } catch (e) {
            const msg = (e as Error).message || '';
            if (/user (rejected|denied)/i.test(msg)) break;
            toast(`Ladder level ${px} failed: ${msg}`, 'error');
          }
        }
        toast(`Scale order: ${placed}/${n} limit orders resting between ${lo} and ${hi}`, placed === n ? 'success' : 'info');
        if (placed > 0 && useStore.getState().soundEnabled) playSound('fill');
        setTrade({ size: '' });
        return;
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
          const chaseLots = Number(trade.size);
          if (!Number.isInteger(chaseLots) || chaseLots <= 0) {
            throw new Error(`Sizes are whole ${market.base} on this market (lot 1).`);
          }
          const { startChase } = await import('@/lib/chase');
          const marketSymbol = market.symbol;
          const id = await startChase({
            marketId: market.id,
            isBuy: trade.side === 'buy',
            size: String(chaseLots),
            sessionKey,
            owner: walletAddress,
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
        let sizeForOrder = trade.size;
        if (trade.reduceOnly) {
          const { livePositionSize } = await import('@/lib/positions');
          const live = await livePositionSize(orderOwner, market.id);
          if (live === null) throw new Error('Could not read your position from the chain — try again.');
          const reducible = trade.side === 'buy' ? -live : live;
          if (reducible <= 0) {
            throw new Error(`Reduce Only: there is no ${trade.side === 'buy' ? 'short' : 'long'} ${market.base} position to reduce.`);
          }
          if (Number(trade.size) > reducible) {
            sizeForOrder = String(reducible);
            toast(`Reduce Only: size limited to your ${reducible} ${market.base} position`, 'info');
          }
        }
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
          size: sizeForOrder,
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
            sizeBase: sizeForOrder,
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
        void reportOutcome(orderOwner, trade.side === 'buy', String(priceForOrder), before, sizeForOrder);
        // TP/SL rides on a bracket, like one set from the Positions table: it
        // fires while this session is open and closes at most the live position
        // (nothing, if this order never filled).
        const tpN = trade.tpEnabled ? Number(trade.tpPrice) || 0 : 0;
        const slN = trade.tpEnabled ? Number(trade.slPrice) || 0 : 0;
        if (tpN > 0 || slN > 0) {
          useStore.getState().setBracket({
            id: `${orderOwner.toLowerCase()}-${market.id}`,
            owner: orderOwner,
            marketId: market.id,
            isLong: trade.side === 'buy',
            size: sizeForOrder,
            tp: tpN > 0 ? String(tpN) : null,
            sl: slN > 0 ? String(slN) : null,
            ts: Date.now(),
          });
          toast(`TP/SL set on ${market.symbol} — executes while this session is open`, 'info');
        }
      }
      if (useStore.getState().soundEnabled) playSound('fill');
      setTrade({ size: '', tpPrice: '', slPrice: '' });
    } catch (e) {
      const raw = (e as Error).message || '';
      const msg = useOneClick && /insufficient funds|insufficient balance for gas/i.test(raw)
        ? `Your one-click agent key is out of gas — top it up in Settings (${AGENT_GAS_TOPUP_MRSN} MRSN lasts thousands of orders).`
        : raw;
      toast(`Order failed: ${msg}`, 'error');
      if (useStore.getState().soundEnabled) playSound('alert');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={formRef} data-trade-form className={cn('relative bg-surface border border-border rounded-xl md:border-0 md:rounded-none p-2.5 md:p-3 xl:p-3.5 flex flex-col gap-2 overflow-hidden shrink-0 transition-shadow duration-500', formFlash && 'ring-2 ring-primary/70 ring-inset')}>
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
                <span className="text-foreground capitalize">
                  {trade.orderType === 'stop' ? (stopLimit ? 'Stop-limit' : 'Stop') : trade.orderType === 'trailing' ? 'Trailing stop' : trade.orderType}
                  {trade.orderType === 'limit' ? ` · ${trade.tif.toUpperCase()}` : trade.orderType === 'market' ? ' · immediate or cancel' : trade.orderType === 'scale' ? ` · ${scaleCount} × GTC` : trade.orderType === 'twap' ? ` · ${twapSlices} slices / ${TWAP_DURATIONS.find((d) => d.value === twapDuration)?.label}` : ' · client-side trigger'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-dim">{trade.orderType === 'stop' ? 'Trigger' : trade.orderType === 'trailing' ? 'Trail' : trade.orderType === 'scale' ? 'Range' : 'Price'}</span>
                <span className="text-foreground">
                  {trade.orderType === 'market' || trade.orderType === 'twap' ? 'Market'
                    : trade.orderType === 'stop' ? `${triggerPrice}${stopLimit ? ` → limit ${trade.price}` : ' → market'}`
                    : trade.orderType === 'trailing' ? `${trailPct}% from extreme`
                    : trade.orderType === 'scale' ? `${scaleFrom} – ${scaleTo}`
                    : trade.price}
                </span>
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
                <div className="flex justify-between pt-1.5 border-t border-border/50" title={feesCharged ? 'Maker/taker fee at your 30-day volume tier' : 'The testnet charges no trading fee; the planned schedule starts at 0% maker / 0.035% taker'}>
                  <span className="text-dim">{feesCharged ? 'Est. Fee' : 'Fee (testnet)'}</span>
                  <span className="text-foreground">{feesCharged ? `${formatNumber(orderSummary.fee, 4)} ${market.quote}` : '0 — no trading fees on testnet'}</span>
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
      {/* Side toggle — phosphor: the active side is a solid block with dark
          text, the inactive side stays an outlined ghost. */}
      <div className="flex gap-px bg-background overflow-hidden border border-border">
        <button
          onClick={() => setTrade({ side: 'buy' })}
          className={cn(
            'flex-1 py-2 text-[11px] font-extrabold uppercase tracking-[0.18em] transition-colors',
            trade.side === 'buy'
              ? 'bg-green text-[#02120a]'
              : 'bg-surface-2 text-dim hover:text-foreground'
          )}
        >{isSpot ? t('trade.buy', 'Buy') : t('trade.long', 'Long')}</button>
        <button
          onClick={() => setTrade({ side: 'sell' })}
          className={cn(
            'flex-1 py-2 text-[11px] font-extrabold uppercase tracking-[0.18em] transition-colors',
            trade.side === 'sell'
              ? 'bg-red text-[#160503]'
              : 'bg-surface-2 text-dim hover:text-foreground'
          )}
        >{isSpot ? t('trade.sell', 'Sell') : t('trade.short', 'Short')}</button>
      </div>

      {/* Cross/Isolated + Leverage chip on one compact row (perps only) */}
      {!isSpot && (
        <div className="flex items-center gap-1 text-[11px] flex-wrap">
          <span
            className="px-2 py-1 font-medium bg-surface-2 border border-border rounded-md text-foreground shrink-0"
            title="Cross margin: every position is margined against your whole collateral. The order book has no isolated margin."
          >Cross</span>
          <span className="ml-auto font-mono text-dim whitespace-nowrap">
            <span className="text-muted">Lev </span>
            <span className="text-foreground font-semibold">{trade.leverage}×</span>
          </span>
          <span className="font-mono text-dim whitespace-nowrap">
            <span className="text-muted">·</span> {formatNumber(collateral, 2)} MRSN
          </span>
        </div>
      )}

      {/* Order type. Stop / Trail / TWAP arm client-side and fire as signed
          orders; Scale places its ladder now. Spot keeps Limit / Market. */}
      <div className="relative">
        {/* Two types → one row; six → a 3×2 grid so labels never collide in the 280 px column. */}
        <div className={cn('gap-px bg-background rounded-md border border-border overflow-hidden', isSpot ? 'flex' : 'grid grid-cols-3')}>
          {(isSpot ? SPOT_ORDER_TYPES : PERP_ORDER_TYPES).map((ot) => (
            <button
              key={ot.value}
              onClick={() => setTrade({ orderType: ot.value as never })}
              className={cn(
                'min-w-0 px-1 py-1.5 text-[11px] font-semibold transition-colors whitespace-nowrap',
                isSpot && 'basis-0 flex-1',
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
          <label className="label-caps mb-1.5 flex justify-between"><span>{t('trade.price', 'Price')}</span><span>{market.quote}</span></label>
          <input
            type="number" value={trade.price} step={priceStep} inputMode="decimal"
            aria-label={`Price (${market.quote})`}
            onChange={(e) => setTrade({ price: e.target.value })}
            placeholder={priceTick < 1 ? (0).toFixed(Math.ceil(-Math.log10(priceTick))) : '0'}
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
      {trade.orderType === 'stop' && (
        <div className="space-y-2">
          <div>
            <label className="label-caps mb-1.5 flex justify-between"><span>Trigger price</span><span>{market.quote}</span></label>
            <input type="number" step={priceStep} inputMode="decimal" value={triggerPrice} aria-label={`Trigger price (${market.quote})`} onChange={(e) => setTriggerPrice(e.target.value)}
              placeholder={tickers[market.id]?.markPrice ? String(tickers[market.id].markPrice) : '0.00'}
              className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60 transition-all" />
          </div>
          <label className="flex items-center gap-2 text-[11px] text-muted cursor-pointer">
            <input type="checkbox" checked={stopLimit} onChange={(e) => setStopLimit(e.target.checked)} className="accent-primary" />
            Stop-limit: rest a limit order at a price once triggered (default takes the market)
          </label>
          {stopLimit && (
            <input type="number" step={priceStep} inputMode="decimal" value={trade.price} aria-label={`Limit price (${market.quote})`} onChange={(e) => setTrade({ price: e.target.value })} placeholder={`Limit price (${market.quote})`}
              className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60 transition-all" />
          )}
          <p className="text-[10px] text-dim leading-relaxed">
            {trade.side === 'buy' ? 'Fires when the mark rises to the trigger' : 'Fires when the mark falls to the trigger'} — watched in this browser, signed by {oneClickEnabled && sessionKey ? 'your one-click key' : 'your wallet (a popup at trigger time; enable one-click to skip it)'}.
          </p>
        </div>
      )}
      {trade.orderType === 'trailing' && (
        <div className="space-y-2">
          <div>
            <label className="label-caps mb-1.5 flex justify-between"><span>Trail distance</span><span>%</span></label>
            <div className="flex gap-1">
              <input type="number" value={trailPct} aria-label="Trail distance (%)" onChange={(e) => setTrailPct(e.target.value)} step="0.5" min="0.1" max="49"
                className="flex-1 bg-surface-3 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground font-mono outline-none focus:border-primary/60 transition-all" />
              {['1', '2', '5'].map((v) => (
                <button key={v} onClick={() => setTrailPct(v)} className={cn('px-2.5 text-[11px] font-mono rounded-lg border transition-colors', trailPct === v ? 'border-primary/60 text-foreground' : 'border-border text-dim hover:text-foreground')}>{v}%</button>
              ))}
            </div>
          </div>
          <p className="text-[10px] text-dim leading-relaxed">
            {trade.side === 'buy'
              ? `Tracks the lowest mark since armed and buys when the mark bounces ${trailPct || '…'}% above it`
              : `Tracks the highest mark since armed and sells when the mark drops ${trailPct || '…'}% below it`} — watched in this browser while a tab is open.
          </p>
        </div>
      )}
      {trade.orderType === 'scale' && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-1.5">
            <div>
              <label className="label-caps mb-1.5 block">From</label>
              <input type="number" step={priceStep} inputMode="decimal" value={scaleFrom} aria-label="Ladder start price" onChange={(e) => setScaleFrom(e.target.value)} placeholder="0" className="w-full bg-surface-3 border border-border rounded-lg px-2.5 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60" />
            </div>
            <div>
              <label className="label-caps mb-1.5 block">To</label>
              <input type="number" step={priceStep} inputMode="decimal" value={scaleTo} aria-label="Ladder end price" onChange={(e) => setScaleTo(e.target.value)} placeholder="0" className="w-full bg-surface-3 border border-border rounded-lg px-2.5 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60" />
            </div>
            <div>
              <label className="label-caps mb-1.5 block">Orders</label>
              <input type="number" value={scaleCount} aria-label="Number of ladder orders" onChange={(e) => setScaleCount(e.target.value)} min="2" max="20" className="w-full bg-surface-3 border border-border rounded-lg px-2.5 py-2.5 text-sm text-foreground font-mono outline-none focus:border-primary/60" />
            </div>
          </div>
          <p className="text-[10px] text-dim leading-relaxed">
            Places {scaleCount || 'N'} resting limit orders spread evenly across the range, the total size split equally. Placed now, on-chain{oneClickEnabled && sessionKey ? '' : ' — one wallet confirmation per order without one-click'}.
          </p>
        </div>
      )}
      {trade.orderType === 'twap' && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className="label-caps mb-1.5 block">Duration</label>
              <select value={twapDuration} onChange={(e) => setTwapDuration(e.target.value)} aria-label="TWAP duration" className="w-full bg-surface-3 border border-border rounded-lg px-2.5 py-2.5 text-sm text-foreground font-mono outline-none focus:border-primary/60">
                {TWAP_DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label-caps mb-1.5 block">Slices</label>
              <input type="number" value={twapSlices} aria-label="TWAP slices" onChange={(e) => setTwapSlices(e.target.value)} min="2" max="100" className="w-full bg-surface-3 border border-border rounded-lg px-2.5 py-2.5 text-sm text-foreground font-mono outline-none focus:border-primary/60" />
            </div>
          </div>
          <p className="text-[10px] text-dim leading-relaxed">
            Splits the size into {twapSlices || 'N'} market orders, one every {(() => { const d = TWAP_DURATIONS.find((x) => x.value === twapDuration); const n = Number(twapSlices) || 1; return d ? `${Math.max(1, Math.round(d.ms / n / 1000))} s` : '…'; })()} while this tab is open{oneClickEnabled && sessionKey ? '' : ' — each slice asks for a wallet signature without one-click'}.
          </p>
        </div>
      )}

      {/* Size */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="label-caps">{t('trade.size', 'Size')} · {market.base}</label>
          <button onClick={() => setShowCalc(!showCalc)} className="text-[10px] text-primary hover:text-primary-hover font-medium">
            {showCalc ? 'Hide Calc' : 'Size Calc'}
          </button>
        </div>
        <input
          type="number" value={trade.size} step={1} min={0} inputMode="numeric"
          aria-label={`Size (${market.base})`}
          onChange={(e) => setTrade({ size: e.target.value })}
          placeholder="0"
          className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-dim font-mono outline-none focus:border-primary/60 focus:bg-surface-3 transition-all"
        />
        {trade.size !== '' && !Number.isInteger(Number(trade.size)) && (
          <p className="text-[10px] text-yellow mt-1">Sizes are whole {market.base} on this market (lot 1) — {trade.size} would be refused.</p>
        )}
        {/* Available balance + Max, on their own row so the label never wraps */}
        {isConnected && (
          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-dim font-mono" title="Equity (collateral plus unrealized PnL) minus the initial margin your open positions hold">
              Avail <span className="text-foreground/80">{formatNumber(availableMargin, 2)} MRSN</span>
            </span>
            <button
              onClick={() => {
                const size = maxOrderSize(tickers[market.id]?.markPrice || 0);
                if (size > 0) setTrade({ size: floorLots(size) });
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
                  const maxSize = maxOrderSize(markPrice);
                  if (maxSize > 0) setTrade({ size: floorLots(maxSize * pct / 100) });
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
            <label className="label-caps" title={market.marginEnforced ? 'Initial margin 10% of notional (10× max), maintenance 5%' : 'Max 10× from block 1,605,600 (10% initial margin). Until then the chain enforces no margin; the ticket keeps you inside the limit anyway.'}>
              {t('trade.leverage', 'Leverage')} <span className="text-dim normal-case tracking-normal">· max {market.maxLeverage}×</span>
            </label>
            <span className="text-xs font-mono font-bold text-primary-bright">{Math.min(trade.leverage, market.maxLeverage)}×</span>
          </div>
          {/* The slider runs on the same scale as the marks below it: piecewise
              between presets (1·2·3·5·10), so the thumb sits on the "3×" mark at
              3× instead of a fifth of the way along a linear 1–10 track. */}
          <input
            type="range" min={0} max={(levPresets.length - 1) * LEV_STEPS} step={1}
            value={levToPos(Math.min(trade.leverage, market.maxLeverage))}
            aria-label="Leverage"
            aria-valuetext={`${trade.leverage}×`}
            onChange={(e) => setTrade({ leverage: posToLev(Number(e.target.value)) })}
            className="range-fill w-full"
            style={{ ['--pct' as string]: `${(levToPos(Math.min(trade.leverage, market.maxLeverage)) / ((levPresets.length - 1) * LEV_STEPS)) * 100}%` }}
          />
          <div className="relative h-5 mt-0.5">
            {levPresets.map((l, i) => {
              const last = i === levPresets.length - 1;
              const pos = i === 0 ? { left: 0 } : last ? { right: 0 } : { left: `${(i / (levPresets.length - 1)) * 100}%` };
              return (
                <button key={l} type="button" onClick={() => setTrade({ leverage: l })}
                  style={pos}
                  className={cn(
                    'absolute top-0 px-1.5 py-0.5 rounded text-[10.5px] font-medium font-mono transition-colors',
                    i !== 0 && !last && '-translate-x-1/2',
                    trade.leverage === l
                      ? 'bg-foreground/[0.07] text-foreground'
                      : 'text-dim hover:text-foreground'
                  )}
                >{l}×</button>
              );
            })}
          </div>
        </div>
      )}

      {/* Everyday toggles stay visible; power settings collapse below. */}
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
      </div>

      {/* Advanced: TIF, slippage, post-only, chase, on-chain expiry. Collapsed
          by default — the summary chip shows any non-default choices. */}
      <div className="border border-border-subtle rounded-lg overflow-hidden">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center justify-between px-2.5 py-1.5 text-[10.5px] text-dim hover:text-foreground bg-surface-2/40 transition-colors"
          aria-expanded={showAdvanced}
        >
          <span className="font-medium">Advanced</span>
          <span className="flex items-center gap-1.5 font-mono">
            {trade.tif.toUpperCase()}
            {postOnly && trade.orderType === 'limit' && trade.tif === 'gtc' && ' · Post'}
            {chase && ' · Chase'}
            {expiry !== 'never' && ` · Exp ${expiry}`}
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
              className={cn('transition-transform', showAdvanced && 'rotate-180')}><polyline points="6 9 12 15 18 9" /></svg>
          </span>
        </button>
        {showAdvanced && (
          <div className="px-2.5 py-2 space-y-2 border-t border-border-subtle">
            <div className="flex items-center gap-1">
              <div className="flex flex-1 gap-px bg-background rounded-md border border-border overflow-hidden">
                {(['gtc', 'ioc', 'fok'] as const).map((tifVal) => (
                  <button key={tifVal} onClick={() => setTrade({ tif: tifVal })}
                    title={`${TIF_LABEL[tifVal].long} — ${TIF_LABEL[tifVal].help}`}
                    aria-label={TIF_LABEL[tifVal].long}
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
            <p className="text-[10px] text-dim leading-snug">
              {TIF_LABEL[trade.tif as 'gtc' | 'ioc' | 'fok']?.long}: {TIF_LABEL[trade.tif as 'gtc' | 'ioc' | 'fok']?.help}.
            </p>
            <div className="flex items-center gap-4 flex-wrap">
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
          </div>
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
      {isConnected && !isSpot && collateral <= 0 && !trade.reduceOnly && (
        <div className="rounded-lg border border-yellow/30 bg-yellow/5 px-3 py-2 text-[11px] leading-relaxed text-foreground/85" data-testid="no-collateral-hint">
          No collateral yet — an order needs margin escrowed on the order book first.{' '}
          <button type="button" onClick={requestDeposit} className="underline text-primary hover:text-primary-hover font-medium">Deposit MRSN or USDC</button>
          {walletMrsn < 1 && (
            <> · <a href={faucetHref} target="_blank" rel="noopener noreferrer" className="underline text-primary hover:text-primary-hover font-medium">claim 1,001 MRSN</a></>
          )}
        </div>
      )}
      <button
        data-submit-order
        // Without collateral the button is not dead: it opens the deposit panel
        // (a disabled button with a not-allowed cursor explained nothing).
        onClick={(!isSpot && collateral <= 0 && !trade.reduceOnly) ? () => requestDeposit() : handleSubmit}
        disabled={loading || !isConnected}
        className={cn(
          // On phones the form lives in a bottom sheet: keep the action in view
          // while the fields above scroll (sticky within the sheet's scroller).
          'w-full py-2.5 min-h-[44px] md:min-h-0 text-[11px] font-extrabold uppercase tracking-[0.2em] transition-colors disabled:cursor-not-allowed mt-0.5 sticky bottom-0 md:static z-10',
          !isConnected
            ? 'bg-surface-2 text-dim border border-border'
            : trade.side === 'buy'
              ? 'bg-green hover:bg-primary-bright text-[#02120a] shadow-[0_0_18px_rgba(43,217,106,0.25)]'
              : 'bg-red hover:bg-red/90 text-[#160503] shadow-[0_0_18px_rgba(255,77,61,0.2)]'
        )}
      >
        {loading
          ? t('trade.placing', 'Placing…')
          : !isConnected
            ? t('common.connectWallet', 'Connect Wallet')
            : (!isSpot && collateral <= 0 && !trade.reduceOnly)
              ? 'Deposit collateral first'
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
          {!isSpot && orderSummary.preSwitchOversized && (
            <p className="text-[10px] leading-snug text-yellow" data-testid="pre-switch-margin-warning">
              Larger than the margin that applies from block {protocol?.switches?.settlementHeight?.toLocaleString() || '1,605,600'} (Sun 20 Sep): positions above
              {' '}{Math.round(10000 / (protocol?.settlementInitialMarginBps || 1000))}× collateral cannot be opened after the switch, and a position whose equity is under 5% of its
              notional at that block is closed by the liquidation keeper. Deposit more collateral or reduce the size.
            </p>
          )}
          <div className="flex items-center justify-between text-[10px]" title={feesCharged ? 'Maker/taker fee at your 30-day volume tier' : 'The testnet charges no trading fee; the planned schedule starts at 0% maker / 0.035% taker'}>
            <span className="text-dim">{feesCharged ? 'Est. Fee' : 'Fee'}</span>
            <span className="font-mono text-dim">{feesCharged ? `${formatNumber(orderSummary.fee, 4)} ${market.quote}` : '0 (testnet)'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
