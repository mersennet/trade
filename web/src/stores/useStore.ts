'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Market, Position, Order, Ticker } from '@/lib/api';

interface WalletState {
  address: string | null;
  provider: unknown;
  signer: unknown;
  balance: string;
  collateral: string;
}

interface TradeState {
  side: 'buy' | 'sell';
  orderType: 'limit' | 'market' | 'stop' | 'twap' | 'scale' | 'trailing';
  price: string;
  size: string;
  leverage: number;
  tif: 'gtc' | 'ioc' | 'fok';
  reduceOnly: boolean;
  tpEnabled: boolean;
  tpPrice: string;
  slPrice: string;
}

/** An order the user just submitted that hasn't appeared in the API's order
 * list yet — shown in the Orders tab immediately with a "Pending" marker so
 * the terminal feels instant instead of silent until the next poll. */
export interface PendingOrder {
  tempId: string;
  owner: string;
  market_id: number;
  side: 'buy' | 'sell';
  price: string;
  size: string;
  tif: string;
  ts: number;
}

/** Notification-center entry. Lives in the store (not a per-component hook)
 * so order fills, bracket fires and transfer results can all publish to the
 * same feed the bell reads. */
export interface AppNotification {
  id: string;
  type: 'fill' | 'liquidation' | 'info' | 'warning';
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
}

/** A client-side price alert: fires a browser + in-app notification when the
 * mark crosses the target, then removes itself. */
export interface PriceAlert {
  id: string;
  marketId: number;
  direction: 'above' | 'below';
  price: number;
  created: number;
}

/** A TP/SL bracket on an open position. Brackets are watched and executed
 * CLIENT-SIDE (the chain has no server-side auto-execution since the auth
 * hardening): while the user's session is open, the app watches the mark
 * price and submits a signed reduce-only IOC when a trigger crosses. */
export interface Bracket {
  id: string;
  owner: string;
  marketId: number;
  isLong: boolean;
  size: string;
  tp: string | null;
  sl: string | null;
  ts: number;
}

interface AppState {
  theme: 'dark' | 'light';
  market: Market;
  tickers: Record<number, Ticker>;
  wallet: WalletState;
  trade: TradeState;
  positions: Position[];
  orders: Order[];
  pendingOrders: PendingOrder[];
  favorites: number[];
  /** Recently viewed market ids, most recent first (persisted, max 5). */
  recentMarkets: number[];
  soundEnabled: boolean;
  skipConfirm: boolean;
  oneClickEnabled: boolean;
  deadManEnabled: boolean;
  marginMode: 'cross' | 'isolated' | 'portfolio';
  sessionKey: string | null;
  slippage: number;
  showSettings: boolean;
  gaslessEnabled: boolean;
  paperMode: boolean;
  tradeMode: 'perps' | 'spot';
  /** Shielded trading: route orders through the ZK privacy layer. Only
   *  engageable once the privacy hard fork is active on the chain. */
  privateMode: boolean;
  privacyForkActive: boolean;
  /** Timestamp of the last "Deposit" request from the header — AccountPanel
   * watches it and opens its transfer panel in deposit mode. */
  depositRequestTs: number;
  /** Client-side TP/SL brackets (persisted per wallet). */
  brackets: Bracket[];
  /** Notification center feed (persisted, capped at 50). */
  notifications: AppNotification[];
  /** Client-side price alerts (persisted). */
  priceAlerts: PriceAlert[];
  /** Wallet connected but on the wrong chain — drives the WrongNetwork modal. */
  wrongChain: boolean;

  setTheme: (t: 'dark' | 'light') => void;
  setMarket: (m: Market) => void;
  updateTicker: (id: number, t: Ticker) => void;
  setWallet: (w: Partial<WalletState>) => void;
  setTrade: (t: Partial<TradeState>) => void;
  setPositions: (p: Position[]) => void;
  setOrders: (o: Order[]) => void;
  addPendingOrder: (o: PendingOrder) => void;
  removePendingOrder: (tempId: string) => void;
  toggleFavorite: (id: number) => void;
  setSoundEnabled: (v: boolean) => void;
  setSkipConfirm: (v: boolean) => void;
  setOneClick: (v: boolean) => void;
  setDeadMan: (v: boolean) => void;
  setMarginMode: (m: 'cross' | 'isolated' | 'portfolio') => void;
  setSessionKey: (k: string | null) => void;
  setSlippage: (v: number) => void;
  setShowSettings: (v: boolean) => void;
  setGasless: (v: boolean) => void;
  setPaperMode: (v: boolean) => void;
  setTradeMode: (m: 'perps' | 'spot') => void;
  setPrivateMode: (v: boolean) => void;
  setPrivacyForkActive: (v: boolean) => void;
  requestDeposit: () => void;
  setBracket: (b: Bracket) => void;
  removeBracket: (id: string) => void;
  addNotification: (type: AppNotification['type'], title: string, message: string) => void;
  markAllRead: () => void;
  clearAllNotifications: () => void;
  addPriceAlert: (a: PriceAlert) => void;
  removePriceAlert: (id: string) => void;
  setWrongChain: (v: boolean) => void;
}

// Must match API market id 1 (chain.js MARKETS[0]) — MRSN/USD, 50x. A mismatch
// here makes a fresh session render the wrong symbol/logo/leverage over MRSN data.
const defaultMarket: Market = { id: 1, symbol: 'MRSN/USD', base: 'MRSN', quote: 'USD', fundingRate: 0.0001, maxLeverage: 50 };

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      theme: 'dark',
      market: defaultMarket,
      tickers: {},
      wallet: { address: null, provider: null, signer: null, balance: '0', collateral: '0' },
      trade: {
        side: 'buy', orderType: 'limit', price: '', size: '', leverage: 2,
        tif: 'gtc', reduceOnly: false, tpEnabled: false, tpPrice: '', slPrice: '',
      },
      positions: [],
      orders: [],
      pendingOrders: [],
      favorites: [],
      recentMarkets: [],
      soundEnabled: false,
      skipConfirm: false,
      oneClickEnabled: false,
      deadManEnabled: false,
      marginMode: 'cross',
      sessionKey: null,
      slippage: 0.5,
      showSettings: false,
      gaslessEnabled: false,
      paperMode: false,
      tradeMode: 'perps',
      privateMode: false,
      privacyForkActive: false,
      depositRequestTs: 0,
      brackets: [],
      notifications: [],
      priceAlerts: [],
      wrongChain: false,

      setTheme: (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        set({ theme });
      },
      setMarket: (market) => set((s) => ({
        market,
        recentMarkets: [market.id, ...s.recentMarkets.filter((id) => id !== market.id)].slice(0, 5),
      })),
      updateTicker: (id, t) => set((s) => ({ tickers: { ...s.tickers, [id]: t } })),
      setWallet: (w) => set((s) => ({ wallet: { ...s.wallet, ...w } })),
      setTrade: (t) => set((s) => ({ trade: { ...s.trade, ...t } })),
      setPositions: (positions) => set({ positions }),
      setOrders: (orders) => set({ orders }),
      addPendingOrder: (o) => set((s) => ({ pendingOrders: [...s.pendingOrders, o] })),
      removePendingOrder: (tempId) => set((s) => ({ pendingOrders: s.pendingOrders.filter((o) => o.tempId !== tempId) })),
      toggleFavorite: (id) => set((s) => ({
        favorites: s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [...s.favorites, id],
      })),
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
      setSkipConfirm: (skipConfirm) => set({ skipConfirm }),
      setOneClick: (oneClickEnabled) => set({ oneClickEnabled }),
      setDeadMan: (deadManEnabled) => set({ deadManEnabled }),
      setMarginMode: (marginMode) => set({ marginMode }),
      setSessionKey: (sessionKey) => set({ sessionKey }),
      setSlippage: (slippage) => set({ slippage }),
      setShowSettings: (showSettings) => set({ showSettings }),
      setGasless: (gaslessEnabled) => set({ gaslessEnabled }),
      setPaperMode: (paperMode) => set({ paperMode }),
      setTradeMode: (tradeMode) => set({ tradeMode }),
      setPrivateMode: (privateMode) => set({ privateMode }),
      setPrivacyForkActive: (privacyForkActive) => set((s) => ({
        privacyForkActive,
        // Never leave private mode engaged if the fork isn't live.
        privateMode: privacyForkActive ? s.privateMode : false,
      })),
      requestDeposit: () => set({ depositRequestTs: Date.now() }),
      // One bracket per wallet+market: setting replaces any previous one.
      setBracket: (b) => set((s) => ({
        brackets: [
          ...s.brackets.filter((x) => !(x.owner === b.owner && x.marketId === b.marketId)),
          b,
        ],
      })),
      removeBracket: (id) => set((s) => ({ brackets: s.brackets.filter((x) => x.id !== id) })),
      addNotification: (type, title, message) => set((s) => ({
        notifications: [
          { id: `${Date.now()}-${Math.random()}`, type, title, message, timestamp: Date.now(), read: false },
          ...s.notifications,
        ].slice(0, 50),
      })),
      markAllRead: () => set((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) })),
      clearAllNotifications: () => set({ notifications: [] }),
      addPriceAlert: (a) => set((s) => ({ priceAlerts: [...s.priceAlerts, a] })),
      removePriceAlert: (id) => set((s) => ({ priceAlerts: s.priceAlerts.filter((x) => x.id !== id) })),
      setWrongChain: (wrongChain) => set({ wrongChain }),
    }),
    {
      name: 'mersennet-trade-store',
      partialize: (state) => ({
        theme: state.theme,
        favorites: state.favorites,
        recentMarkets: state.recentMarkets,
        soundEnabled: state.soundEnabled,
        skipConfirm: state.skipConfirm,
        oneClickEnabled: state.oneClickEnabled,
        deadManEnabled: state.deadManEnabled,
        marginMode: state.marginMode,
        slippage: state.slippage,
        gaslessEnabled: state.gaslessEnabled,
        paperMode: state.paperMode,
        brackets: state.brackets,
        notifications: state.notifications,
        priceAlerts: state.priceAlerts,
      }),
    }
  )
);
