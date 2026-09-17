// Same-origin by default — Caddy on trade.mersennet.com proxies /api and /ws
// to the Mersennet Trade API service.
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api/v1';
const WS_BASE =
  process.env.NEXT_PUBLIC_WS_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
    : 'ws://localhost:4005/ws');

// Requests that hang (network stall, dead upstream) would otherwise spin
// forever. Abort after a fixed timeout so callers surface an error instead.
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Share one in-flight request and its result for `ttlMs` across components:
 * several widgets poll the same endpoint on their own timers, which multiplied
 * identical requests (the two status chips alone hit /stats 16× per 30 s).
 */
const memoCache = new Map<string, { at: number; p: Promise<unknown> }>();
function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memoCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.p as Promise<T>;
  const p = fn().catch((e) => { memoCache.delete(key); throw e; });
  memoCache.set(key, { at: now, p });
  return p;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: options?.signal ?? controller.signal,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // Keep the server's remediation hint (e.g. node verification) on the error.
    throw Object.assign(new Error(err.error || res.statusText), { hint: err.hint as string | undefined });
  }
  return res.json();
}

export const api = {
  getMarkets: () => apiFetch<{ markets: Market[] }>('/markets'),
  getOrderBook: (id: number) => apiFetch<{ orderbook: OrderBook }>(`/markets/${id}/orderbook`),
  getTicker: (id: number) => apiFetch<Ticker>(`/markets/${id}/ticker`),
  getCandles: (id: number, resolution = '1h', from?: number, to?: number) => {
    const params = new URLSearchParams({ resolution });
    if (from) params.set('from', from.toString());
    if (to) params.set('to', to.toString());
    return apiFetch<{ candles: Candle[] }>(`/candles/${id}?${params}`);
  },
  getTrades: (marketId: number, limit = 50) =>
    apiFetch<{ trades: Trade[]; total: number }>(`/trades/${marketId}?limit=${limit}`),
  getPositions: (addr: string) => apiFetch<{ positions: Position[]; collateral: number }>(`/positions/${addr}`),
  getOrders: (addr: string) => apiFetch<{ orders: Order[] }>(`/orders/${addr}`),
  getOrderHistory: (addr: string, limit = 50) =>
    apiFetch<{ orders: Order[] }>(`/orders/${addr}/history?limit=${limit}`),
  submitOrder: (data: OrderSubmit | SignedOrderSubmit) =>
    apiFetch<{ result: unknown }>('/orders', { method: 'POST', body: JSON.stringify(data) }),
  // NOTE: on-chain orders are cancelled with a signed tx via
  // cancelOrderOnChain (lib/orderSigning.ts) — there is no server-side cancel.
  getCollateral: (addr: string) =>
    apiFetch<{ collateral: number; free: number; collateralRaw: string; decimals: number }>(`/collateral/${addr}`),
  // The collateral endpoints return calldata + the raw amount; the FRONTEND
  // then prompts the wallet to sign the approval + deposit/withdraw txs.
  // Use `useVault()` (lib/vault.ts) instead of calling these directly.
  buildDeposit: (owner: string, amount: string) =>
    apiFetch<{
      tx: { to: string; data: string; value: string };
      approve: { token: string; spender: string; amount: string };
      amountRaw: string; decimals: number;
    }>('/collateral/deposit', { method: 'POST', body: JSON.stringify({ owner, amount }) }),
  buildWithdraw: (owner: string, amount: string) =>
    apiFetch<{
      tx: { to: string; data: string; value: string };
      amountRaw: string; decimals: number;
    }>('/collateral/withdraw', { method: 'POST', body: JSON.stringify({ owner, amount }) }),
  // NOTE: cancel-all only clears server-side conditional orders and is used by
  // the dead-man switch via sendBeacon (DeadManSwitch.tsx), not through here.
  getConditionalOrders: (addr: string) =>
    apiFetch<{ orders: ConditionalOrder[] }>(`/orders/${addr}/conditional`),
  cancelConditional: (orderId: number) =>
    apiFetch<{ result: unknown }>(`/orders/${orderId}/cancel-conditional`, { method: 'POST' }),
  getFundingHistory: (marketId: number) =>
    apiFetch<{ rates: FundingRate[] }>(`/markets/${marketId}/funding-history`),
  exportTrades: (address: string) => {
    window.open(`${API_BASE}/trades/export/${address}`, '_blank');
  },
  exportOrders: (address: string) => {
    window.open(`${API_BASE}/trades/export-orders/${address}`, '_blank');
  },
  getFeeTiers: () => apiFetch<{ feeTiers: FeeTier[] }>('/stats'),
  getLeaderboard: (period = 'alltime', sort = 'pnl', limit = 50) =>
    apiFetch<LeaderboardResponse>(`/leaderboard?period=${period}&sort=${sort}&limit=${limit}`),
  getTraderProfile: (addr: string) => apiFetch<TraderProfile>(`/leaderboard/trader/${addr}`),
  getPoints: (addr: string, season = 1) => apiFetch<PointsResponse>(`/points/${addr}?season=${season}`),
  // Verified node runners
  getMyNodes: (addr: string) => apiFetch<{ nodes: VerifiedNode[]; pointsPerDay: number; latest_sha?: string | null }>(`/nodes/mine/${addr}`),
  probeNode: (host: string) => apiFetch<{ reachable: boolean; identity?: string | null; height?: number | null; version?: string | null; error?: string }>(`/nodes/probe?host=${encodeURIComponent(host)}`),
  getVerifiedNodes: () => apiFetch<{ nodes: VerifiedNode[]; total: number; active: number; pointsPerDay: number }>('/nodes/verified'),
  verifyNode: (body: { host: string; wallet: string; signature: string }) =>
    apiFetch<{ ok: boolean; identity: string; height: number; version: string; pointsPerDay: number }>('/nodes/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  getPointsLeaderboard: (season = 1) => apiFetch<{ leaderboard: PointsEntry[] }>(`/points/leaderboard/season/${season}`),
  getVaultState: () => apiFetch<VaultState>('/vault/state'),
  getVaultUser: (addr: string) => apiFetch<VaultUserState>(`/vault/user/${addr}`),
  vaultDeposit: (address: string, amount: number) =>
    apiFetch<{ shares: number }>('/vault/deposit', { method: 'POST', body: JSON.stringify({ address, amount }) }),
  vaultWithdraw: (address: string, shares: number) =>
    apiFetch<{ amount: number }>('/vault/withdraw', { method: 'POST', body: JSON.stringify({ address, shares }) }),
  getStakingState: () => apiFetch<StakingState>('/staking/state'),
  getStakingUser: (addr: string) => apiFetch<StakingUserState>(`/staking/user/${addr}`),
  stake: (address: string, amount: number) =>
    apiFetch<{ staked: number }>('/staking/stake', { method: 'POST', body: JSON.stringify({ address, amount }) }),
  unstake: (address: string, amount: number) =>
    apiFetch<{ unstaked: number }>('/staking/unstake', { method: 'POST', body: JSON.stringify({ address, amount }) }),
  claimRewards: (address: string) =>
    apiFetch<{ claimed: number }>('/staking/claim', { method: 'POST', body: JSON.stringify({ address }) }),
  getCompetitions: (status?: string) =>
    apiFetch<{ competitions: Competition[] }>(`/competitions${status ? `?status=${status}` : ''}`),
  getCompetition: (id: number) => apiFetch<CompetitionDetail>(`/competitions/${id}`),
  joinCompetition: (id: number, address: string) =>
    apiFetch<{ joined: boolean }>(`/competitions/${id}/join`, { method: 'POST', body: JSON.stringify({ address }) }),
  getBuilderCodes: () => apiFetch<{ codes: BuilderCode[] }>('/builder-codes'),
  getBuilderCodesByOwner: (address: string) => apiFetch<{ codes: BuilderCode[] }>(`/builder-codes/owner/${address}`),
  createBuilderCode: (owner: string, label?: string, code?: string) =>
    apiFetch<{ code: string }>('/builder-codes', { method: 'POST', body: JSON.stringify({ owner, label, code }) }),
  getStats: () => memo('stats', 5_000, () => apiFetch<ProtocolStats>('/stats')),
  /** Cheap RPC-backed head/interval reading for status chips (no DB aggregates). */
  getChainHealth: () => memo('chain-health', 2_000, () => apiFetch<ChainHealth>('/health/chain')),
  getBalance: (addr: string) => apiFetch<{ balance: string }>(`/balance/${addr}`),
  getHealth: () => apiFetch<{ status: string }>('/health'),
  getApiKeys: (address: string) =>
    apiFetch<{ keys: ApiKey[] }>(`/api-keys/${address}`),
  createApiKey: (address: string, label?: string) =>
    apiFetch<{ key: string; label: string; permissions: string[] }>('/api-keys', {
      method: 'POST', body: JSON.stringify({ address, label }),
    }),
  deleteApiKey: (id: number) =>
    apiFetch<{ success: boolean }>(`/api-keys/${id}`, { method: 'DELETE' }),
  getProposals: (status?: string) =>
    apiFetch<{ proposals: GovernanceProposal[] }>(`/governance/proposals${status && status !== 'all' ? `?status=${status}` : ''}`),
  getProposal: (id: number) =>
    apiFetch<{ proposal: GovernanceProposal; votes: GovernanceVote[] }>(`/governance/proposals/${id}`),
  voteOnProposal: (id: number, voter: string, direction: 'for' | 'against') =>
    apiFetch<{ success: boolean; votingPower: number }>(`/governance/proposals/${id}/vote`, {
      method: 'POST', body: JSON.stringify({ voter, direction }),
    }),
  createProposal: (title: string, description: string, proposer: string, end_days?: number) =>
    apiFetch<{ proposal: GovernanceProposal }>('/governance/proposals', {
      method: 'POST', body: JSON.stringify({ title, description, proposer, end_days }),
    }),
  getVotingPower: (address: string) =>
    apiFetch<{ address: string; votingPower: number }>(`/governance/voting-power/${address}`),

  // TWAP / Algorithmic orders
  submitTwap: (data: { owner: string; market_id: number; side: string; total_size: number; price_limit?: number; slices: number; duration_ms: number; order_type: string }) =>
    apiFetch<{ order: TwapOrder }>('/orders/twap', { method: 'POST', body: JSON.stringify(data) }),
  getTwapOrders: (address: string) =>
    apiFetch<{ orders: TwapOrder[] }>(`/orders/twap/${address}`),
  cancelTwap: (id: number) =>
    apiFetch<{ cancelled: boolean }>(`/orders/twap/${id}`, { method: 'DELETE' }),

  // Spot trading
  getSpotMarkets: () => apiFetch<{ markets: SpotMarket[] }>('/spot'),
  getSpotOrderbook: (pair: string) => apiFetch<{ orderbook: { bids: [number, number][]; asks: [number, number][] } }>(`/spot/orderbook/${encodeURIComponent(pair)}`),
  submitSpotOrder: (data: { owner: string; pair: string; side: string; price: number; size: number }) =>
    apiFetch<{ order: SpotOrder }>('/spot/order', { method: 'POST', body: JSON.stringify(data) }),
  cancelSpotOrder: (id: number) => apiFetch<{ cancelled: boolean }>(`/spot/order/${id}`, { method: 'DELETE' }),
  getSpotTrades: (pair: string) => apiFetch<{ trades: SpotTrade[] }>(`/spot/trades/${encodeURIComponent(pair)}`),
  getSpotBalances: (address: string) => apiFetch<{ balances: SpotBalance[] }>(`/spot/balances/${address}`),

  // Options
  getOptionChains: () => apiFetch<{ chains: OptionChain[] }>('/options/chains'),
  getOptionChain: (underlying: string) => apiFetch<{ contracts: OptionContract[] }>(`/options/chain/${underlying}`),
  submitOptionOrder: (data: { owner: string; contract_id: number; side: string; size: number; price: number }) =>
    apiFetch<{ order: unknown }>('/options/order', { method: 'POST', body: JSON.stringify(data) }),
  getOptionPositions: (address: string) => apiFetch<{ positions: OptionPosition[] }>(`/options/positions/${address}`),
  getOptionGreeks: (contractId: number) => apiFetch<OptionGreeks>(`/options/greeks/${contractId}`),
  getOptionGreeksBulk: (underlying: string) =>
    apiFetch<{ greeks: OptionGreeks[] }>(`/options/greeks?underlying=${encodeURIComponent(underlying)}`),

  // Pre-launch
  getPrelaunchMarkets: () => apiFetch<{ markets: PrelaunchMarket[] }>('/prelaunch'),
  submitPrelaunchOrder: (data: { owner: string; market_id: number; side: string; price: number; size: number }) =>
    apiFetch<{ order: unknown }>('/prelaunch/order', { method: 'POST', body: JSON.stringify(data) }),
  getPrelaunchPositions: (address: string) => apiFetch<{ positions: PrelaunchPosition[] }>(`/prelaunch/positions/${address}`),

  // Whales
  getWhaleActivity: (minValue?: number) => apiFetch<{ trades: WhaleTrade[] }>(`/whales/activity${minValue ? `?min_value=${minValue}` : ''}`),
  getWhaleWallets: () => apiFetch<{ wallets: WhaleWallet[] }>('/whales/wallets'),
  getWhaleAlerts: (address: string) => apiFetch<{ alerts: WhaleAlert[] }>(`/whales/alerts/${address}`),
  createWhaleAlert: (data: { address: string; market_id?: number; threshold: number }) =>
    apiFetch<{ alert: WhaleAlert }>('/whales/alerts', { method: 'POST', body: JSON.stringify(data) }),

  // AI Agents
  getAgents: (address: string) => apiFetch<{ agents: TradingAgent[] }>(`/agents/${address}`),
  createAgent: (data: { owner: string; name: string; strategy: string; markets: number[]; params: Record<string, number>; risk_limits: Record<string, number> }) =>
    apiFetch<{ agent: TradingAgent }>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: number, data: Partial<TradingAgent>) =>
    apiFetch<{ agent: TradingAgent }>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  startAgent: (id: number, owner: string) =>
    apiFetch<{ agent: TradingAgent }>(`/agents/${id}/start`, { method: 'POST', body: JSON.stringify({ owner }) }),
  stopAgent: (id: number, owner: string) =>
    apiFetch<{ agent: TradingAgent }>(`/agents/${id}/stop`, { method: 'POST', body: JSON.stringify({ owner }) }),
  getAgentPerformance: (id: number) => apiFetch<AgentPerformance>(`/agents/${id}/performance`),

  // OTC/RFQ
  submitRfq: (data: { address: string; market: string; side: string; size: number }) =>
    apiFetch<{ quote: OtcQuote }>('/otc/rfq', { method: 'POST', body: JSON.stringify(data) }),
  getOtcQuotes: (address: string) => apiFetch<{ quotes: OtcQuote[] }>(`/otc/quotes/${address}`),
  acceptOtcQuote: (id: number, address: string) =>
    apiFetch<{ accepted: boolean; trade: OtcTrade }>(`/otc/accept/${id}`, { method: 'POST', body: JSON.stringify({ address }) }),
  getOtcHistory: (address: string) => apiFetch<{ history: OtcTrade[] }>(`/otc/history/${address}`),

  // Bridge
  getBridgeChains: () => apiFetch<{ chains: BridgeChain[] }>('/bridge/chains'),
  initBridgeDeposit: (data: { address: string; chain: string; amount: number; tx_hash: string }) =>
    apiFetch<{ deposit: BridgeDeposit }>('/bridge/deposit', { method: 'POST', body: JSON.stringify(data) }),
  getBridgeDeposits: (address: string) => apiFetch<{ deposits: BridgeDeposit[] }>(`/bridge/deposits/${address}`),
  getBridgeStatus: (txHash: string) => apiFetch<{ deposit: BridgeDeposit }>(`/bridge/status/${txHash}`),

  // Market listing
  getMarketProposals: () => apiFetch<{ proposals: MarketProposal[] }>('/market-listing/proposals'),
  proposeMarket: (data: { proposer: string; symbol: string; base: string; quote: string; max_leverage: number }) =>
    apiFetch<{ proposal: MarketProposal }>('/market-listing/propose', { method: 'POST', body: JSON.stringify(data) }),
  voteOnMarketProposal: (id: number, voter: string, direction: 'for' | 'against') =>
    apiFetch<{ success: boolean }>(`/market-listing/proposals/${id}/vote`, { method: 'POST', body: JSON.stringify({ voter, direction }) }),

  // Oracle
  getOraclePrices: () => apiFetch<{ prices: OraclePrice[] }>('/oracle/prices'),
  getOracleHealth: () => apiFetch<{ status: string; sources: number; stale: string[] }>('/oracle/health'),

  // Paper trading
  initPaper: (address: string) => apiFetch<{ balance: number }>(`/paper/init/${address}`, { method: 'POST' }),
  getPaperBalance: (address: string) => apiFetch<{ balance: number; equity: number }>(`/paper/balance/${address}`),
  submitPaperOrder: (data: { owner: string; market_id: number; side: string; price: number; size: number; leverage: number }) =>
    apiFetch<{ order: unknown }>('/paper/order', { method: 'POST', body: JSON.stringify(data) }),
  getPaperPositions: (address: string) => apiFetch<{ positions: PaperPosition[] }>(`/paper/positions/${address}`),
  getPaperTrades: (address: string) => apiFetch<{ trades: PaperTrade[] }>(`/paper/trades/${address}`),

  // Funding arb
  getFundingComparison: () => apiFetch<{ comparison: FundingComparison[] }>('/funding-arb/comparison'),
  getFundingOpportunities: () => apiFetch<{ opportunities: FundingOpportunity[] }>('/funding-arb/opportunities'),

  // Portfolio margin
  getPortfolioMargin: (address: string) => apiFetch<PortfolioMarginData>(`/positions/${address}?mode=portfolio`),

  // Email login is "coming soon" in the wallet menu — magic-link client
  // methods will be added alongside the server implementation, not before.
};

export function createWsConnection() {
  return new WebSocket(WS_BASE);
}

export interface Market { id: number; symbol: string; base: string; quote: string; fundingRate: number; maxLeverage: number; }
export interface OrderBook { bids: [number, number][]; asks: [number, number][]; }
export interface Ticker { marketId: number; bestBid: number; bestAsk: number; markPrice: number; volume24h: number; trades24h: number; change24h?: number; oracleMarkUsd?: number; oracleAgeSec?: number; openInterest?: number; longAccounts?: number; shortAccounts?: number; }
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number; }
export interface Trade { id: number; block: number; time: string; marketId: number; taker: string; maker: string; side: string; price: number; size: number; }
export interface Position {
  marketId: number;
  symbol: string;
  size: string;
  entryPrice: string;
  markPrice?: number;
  unrealizedPnl?: number;
  liquidationPrice?: number;
  margin?: number;
  maintenanceMargin?: number;
  leverage?: number;
  fundingRate?: number;
  notional?: number;
}
export interface Order { id?: number; order_id?: number; owner?: string; market_id?: number; side: string; price: string; size: string; status?: string; tif?: string; }
export interface ConditionalOrder {
  id: number; owner: string; market_id: number; side: string; size: string;
  order_type: string; trigger_price: string | null; limit_price: string | null;
  trailing_pct: number | null; tp_price: string | null; sl_price: string | null;
  leverage: number; reduce_only: boolean; status: string; created_at: string;
}
export interface OrderSubmit {
  owner: string;
  market_id: number;
  side: string;
  price: string;
  size: string;
  tif?: string;
  builder_code?: string;
  leverage?: number;
  order_type?: string;
  tp_price?: string;
  sl_price?: string;
  trigger_price?: string;
  trailing_pct?: string;
  reduce_only?: boolean;
}
/** Signed limit/market orders go through the on-chain settlement contract. */
export interface SignedOrderSubmit {
  order: {
    trader: string;
    marketId: number;
    isBuy: boolean;
    price: string;     // raw uint128 string (USD * 1e8)
    size: string;      // raw uint256 string (base * 1e18)
    expiry: number;
    nonce: number;
    salt: string;
  };
  signature: string;
  // Metadata, not signed:
  tif?: string;
  leverage?: number;
  order_type?: string;
  tp_price?: string;
  sl_price?: string;
  reduce_only?: boolean;
}
export interface LeaderboardResponse { traders: LeaderboardEntry[]; total: number; period: string; }
export interface LeaderboardEntry { rank: number; address: string; pnl: number; pnlPct: number; volume: number; trades: number; wins: number; losses: number; winRate: string; }
/** Raw leaderboard row per period — pg returns NUMERIC columns as strings. */
export interface TraderStatRow {
  period?: string;
  pnl?: number | string;
  pnl_pct?: number | string;
  volume?: number | string;
  trade_count?: number | string;
  win_count?: number | string;
  loss_count?: number | string;
  best_trade?: number | string;
  worst_trade?: number | string;
  max_drawdown?: number | string;
}
export interface TraderProfile { address: string; stats: Record<string, TraderStatRow>; recentTrades: Trade[]; }
export interface PointsResponse { address: string; totalPoints: number; tradingPoints: number; lpPoints: number; referralPoints: number; nodePoints?: number; tier: string; rank: number; history: { point_type: string; amount: number; reason: string; created_at: string }[]; }
export interface PointsEntry { rank: number; address: string; totalPoints: number; tier: string; }
export interface VerifiedNode { identity: string; operator?: string; host: string; version: string; height: number; first_verified_at: string; last_seen_at: string; active: boolean; registration_proof?: string | null; build_sha?: string | null; outdated?: boolean; }
export interface VaultState { totalShares: number; totalTvl: number; totalPnl: number; apy7d: number; apy30d: number; depositors: number; }
export interface VaultUserState { address: string; shares: number; value: number; shareOfVault: string; history: unknown[]; }
export interface StakingState { totalStaked: number; totalRewardsDistributed: number; rewardRate: number; stakersCount: number; }
export interface StakingUserState { address: string; staked: number; rewardsPending: number; unbonding: number; unbondAvailableAt: string | null; }
export interface Competition { id: number; name: string; description: string; comp_type: string; start_at: string; end_at: string; prize_pool: number; status: string; }
export interface CompetitionDetail { competition: Competition; standings: { address: string; pnl: number; roi: number; volume: number; rank: number }[]; }
export interface BuilderCode { code: string; owner: string; label: string; fee_share_bps: number; total_volume: number; total_fees_earned: number; total_orders: number; }
export interface ChainHealth { ok: boolean; head: number; headAgeSec: number; avgBlockMs: number; window: number; timestamp: number; }
export interface ProtocolStats { volume24h: number; volume7d: number; totalTrades: number; uniqueTraders: number; markets: number; blockHeight: number; vaultTvl: number; totalStaked: number; insuranceFund: number; feeTiers?: FeeTier[]; feesCharged?: boolean; }
export interface FundingRate { timestamp: string; rate: number; marketId: number; }
export interface FeeTier { name: string; minVolume: number; makerFee: number; takerFee: number; }
export interface GovernanceProposal { id: number; title: string; description: string; for_votes: number; against_votes: number; status: string; end_time: string; created_at: string; }
export interface GovernanceVote { voter: string; direction: string; voting_power: number; created_at: string; }
export interface ApiKey { id: number; label: string; permissions: string[]; rate_limit: number; active: boolean; created_at: string; last_used_at: string | null; }

export interface TwapOrder { id: number; owner: string; market_id: number; side: string; total_size: number; executed_size: number; price_limit: number; slices: number; interval_ms: number; order_type: string; status: string; created_at: string; }
export interface SpotMarket { id: number; pair: string; base: string; quote: string; status: string; }
export interface SpotOrder { id: number; owner: string; pair: string; side: string; price: number; size: number; filled: number; status: string; created_at: string; }
export interface SpotTrade { id: number; pair: string; buyer: string; seller: string; price: number; size: number; created_at: string; }
export interface SpotBalance { asset: string; available: number; locked: number; }
export interface OptionChain { underlying: string; expiry: string; contracts: number; min_strike: number; max_strike: number; }
export interface OptionContract { id: number; underlying: string; strike: number; expiry: string; option_type: 'call' | 'put'; mark_price: number; iv: number; }
export interface OptionPosition { id: number; contract_id: number; underlying: string; strike: number; expiry: string; option_type: string; size: number; entry_price: number; mark_price: number; pnl: number; }
export interface OptionGreeks { contractId?: number; delta: number; gamma: number; theta: number; vega: number; rho?: number; iv: number; }
export interface PrelaunchMarket { id: number; symbol: string; token_name: string; launch_date: string; status: string; last_price: number; volume: number; }
export interface PrelaunchPosition { id: number; market_id: number; symbol: string; side: string; size: number; entry_price: number; mark_price: number; pnl: number; }
export interface WhaleTrade { id: number; market_id: number; symbol: string; side: string; price: number; size: number; value: number; taker: string; time: string; }
export interface WhaleWallet { address: string; volume: number; trades: number; pnl: number | null; last_active: string; }
export interface WhaleAlert { id: number; address: string; market_id: number | null; threshold: number; created_at: string; }
export interface TradingAgent { id: number; owner: string; name: string; strategy: string; markets: number[]; params: Record<string, number>; risk_limits: Record<string, number>; status: string; pnl: number; trades: number; created_at: string; }
export interface AgentPerformance { totalTrades: number; totalPnl: number; winRate: number; avgTrade: number; maxDrawdown: number; sharpe: number; trades: { time: string; pnl: number; market_id: number; side: string }[]; }
export interface RfqRequest { id: number; requester: string; market_id: number; side: string; size: number; status: string; created_at: string; }
export interface OtcQuote { id: number; address: string; quoter: string; market: string; side: string; size: number; quote_price: number; reference_price: number; status: string; expires_at: string; created_at: string; }
export interface OtcTrade { id: number; quote_id: number; address: string; quoter: string; market: string; side: string; size: number; price: number; status: string; created_at: string; }
export interface BridgeChain { name: string; chain_id: number | null; deposit_address: string; confirmations: number; status: string; }
export interface BridgeDeposit { id: number; address: string; chain: string; amount: number; tx_hash: string; status: string; created_at: string; confirmed_at: string | null; }
export interface MarketProposal { id: number; proposer: string; symbol: string; base: string; quote: string; max_leverage: number; stake_amount: number; votes_for: number; votes_against: number; status: string; created_at: string; }
export interface OraclePrice { symbol: string; price: number; confidence: number; sources: number; updated_at: string; }
export interface PaperPosition { id: number; market_id: number; side: string; size: number; entry_price: number; mark_price: number; pnl: number; leverage: number; }
export interface PaperTrade { id: number; market_id: number; side: string; price: number; size: number; pnl: number; created_at: string; }
export interface FundingComparison { symbol: string; mersennetTrade: number; hyperliquid: number; dydx: number; binance: number; }
export interface FundingOpportunity { symbol: string; long_exchange: string; short_exchange: string; spread: number; annualized: number; }
export interface PortfolioMarginData { totalCollateral: number; totalMarginUsed: number; marginRatio: number; availableMargin: number; healthFactor: number; positions: Position[]; spotBalances: SpotBalance[]; }
