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

interface AppState {
  theme: 'dark' | 'light';
  market: Market;
  tickers: Record<number, Ticker>;
  wallet: WalletState;
  trade: TradeState;
  positions: Position[];
  orders: Order[];
  favorites: number[];
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

  setTheme: (t: 'dark' | 'light') => void;
  setMarket: (m: Market) => void;
  updateTicker: (id: number, t: Ticker) => void;
  setWallet: (w: Partial<WalletState>) => void;
  setTrade: (t: Partial<TradeState>) => void;
  setPositions: (p: Position[]) => void;
  setOrders: (o: Order[]) => void;
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
}

// Must match API market id 1 (chain.js MARKETS[0]) — MRSN/USDC, 50x. A mismatch
// here makes a fresh session render the wrong symbol/logo/leverage over MRSN data.
const defaultMarket: Market = { id: 1, symbol: 'MRSN/USDC', base: 'MRSN', quote: 'USDC', fundingRate: 0.0001, maxLeverage: 50 };

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
      favorites: [],
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

      setTheme: (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        set({ theme });
      },
      setMarket: (market) => set({ market }),
      updateTicker: (id, t) => set((s) => ({ tickers: { ...s.tickers, [id]: t } })),
      setWallet: (w) => set((s) => ({ wallet: { ...s.wallet, ...w } })),
      setTrade: (t) => set((s) => ({ trade: { ...s.trade, ...t } })),
      setPositions: (positions) => set({ positions }),
      setOrders: (orders) => set({ orders }),
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
    }),
    {
      name: 'mersennet-trade-store',
      partialize: (state) => ({
        theme: state.theme,
        favorites: state.favorites,
        soundEnabled: state.soundEnabled,
        skipConfirm: state.skipConfirm,
        oneClickEnabled: state.oneClickEnabled,
        deadManEnabled: state.deadManEnabled,
        marginMode: state.marginMode,
        slippage: state.slippage,
        gaslessEnabled: state.gaslessEnabled,
        paperMode: state.paperMode,
      }),
    }
  )
);
