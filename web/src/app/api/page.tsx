'use client';
import { cn } from '@/lib/utils';
import { API_BASE } from '@/lib/api';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'wss://trade.mersennet.com/ws';

const ENDPOINTS = [
  { method: 'GET', path: '/markets', desc: 'List all markets' },
  { method: 'GET', path: '/markets/:id/orderbook', desc: 'Get order book' },
  { method: 'GET', path: '/markets/:id/ticker', desc: 'Get ticker data' },
  { method: 'GET', path: '/candles/:id?resolution=1h', desc: 'Get OHLCV candles' },
  { method: 'GET', path: '/trades/:marketId', desc: 'Get recent trades' },
  { method: 'GET', path: '/positions/:address', desc: 'Get open positions' },
  { method: 'GET', path: '/orders/:address', desc: 'Get open orders' },
  { method: 'GET', path: '/collateral/:address', desc: 'Get collateral balance' },
  { method: 'POST', path: '/collateral/deposit', desc: 'Build depositCollateral calldata to sign (no state change)' },
  { method: 'GET', path: '/leaderboard', desc: 'Get leaderboard rankings' },
  { method: 'GET', path: '/points/:address', desc: 'Get points balance' },
  { method: 'GET', path: '/vault/state', desc: 'Get vault TVL and APY' },
  { method: 'GET', path: '/staking/state', desc: 'Get staking stats' },
  { method: 'GET', path: '/competitions', desc: 'List competitions' },
  { method: 'GET', path: '/builder-codes', desc: 'List builder codes' },
  { method: 'GET', path: '/stats', desc: 'Protocol statistics' },
  { method: 'GET', path: '/protocol', desc: 'Live CLOB parameters: margin bps, wei per collateral unit, armed switch heights, per-market price scale' },
  { method: 'GET', path: '/protocol/switches', desc: 'Upcoming protocol switches with ETAs from the observed block time' },
  { method: 'GET', path: '/protocol/upgrades', desc: 'Protocol upgrades: upcoming (live + announced estimate) and completed (actual activation time vs the estimate on record)' },
  { method: 'GET', path: '/nodes/builds', desc: 'Build/version of every reachable node vs the current release' },
  { method: 'GET', path: '/spot', desc: 'List spot markets' },
  { method: 'POST', path: '/spot/order', desc: 'Place spot order (preview — writes disabled)' },
  { method: 'GET', path: '/options/chains', desc: 'Option chains' },
  { method: 'POST', path: '/options/order', desc: 'Place option order (preview — writes disabled)' },
  { method: 'GET', path: '/prelaunch', desc: 'Pre-launch markets' },
  { method: 'GET', path: '/whales/activity', desc: 'Whale activity feed' },
  { method: 'POST', path: '/agents', desc: 'Create AI trading agent (preview — writes disabled)' },
  { method: 'POST', path: '/otc/rfq', desc: 'Request for quote (preview — writes disabled)' },
  { method: 'GET', path: '/bridge/chains', desc: 'Bridge chains (disabled — bridge not live)' },
  { method: 'GET', path: '/oracle/prices', desc: 'Oracle price feeds' },
  { method: 'POST', path: '/paper/order', desc: 'Paper trade order (preview — writes disabled)' },
  { method: 'GET', path: '/funding-arb/comparison', desc: 'Funding rate comparison' },
  { method: 'GET', path: '/health', desc: 'Health check' },
];

const WS_CHANNELS = [
  { channel: 'ticker:{marketId}', desc: 'Real-time price updates' },
  { channel: 'orderbook:{marketId}', desc: 'Live order book updates' },
  { channel: 'trades:{marketId}', desc: 'Real-time trade stream' },
  { channel: 'blocks', desc: 'New block notifications' },
];

export default function ApiPage() {
  return (
    <div className="page-shell space-y-8">
      <div className="text-center mb-8">
        <h1 className="page-title">Mersennet Trade API</h1>
        <p className="page-sub">REST + WebSocket API for trading bots and integrations</p>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {[
          { label: 'Base URL', value: API_BASE },
          { label: 'WebSocket', value: WS_URL },
          { label: 'Rate Limit', value: '600 requests/min per IP (read), 60/min (write)' },
        ].map((item) => (
          <div key={item.label} className="bg-surface border border-border rounded-xl p-4">
            <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">{item.label}</p>
            <p className="text-sm text-foreground font-mono break-all">{item.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Quick Start</h3>
        <p className="text-xs text-dim mb-3">
          Market data is served over REST/WebSocket, but <span className="text-foreground">orders are signed
          transactions</span> to the on-chain CLOB precompile — the API rejects unsigned order submission
          with <code className="bg-surface-2 px-1 py-0.5 rounded font-mono">SIGNED_ORDER_REQUIRED</code>.
          The TypeScript SDK (<code className="bg-surface-2 px-1 py-0.5 rounded font-mono">@mersennet/sdk</code>)
          is not yet published to npm — build it from the monorepo&apos;s <code className="bg-surface-2 px-1 py-0.5 rounded font-mono">sdk-ts/</code> package.
        </p>
        <pre className="bg-surface-2 rounded-lg p-4 text-xs text-foreground overflow-x-auto font-mono">
{`// Place an order: signed tx to the CLOB precompile (ethers v6)
import { ethers } from 'ethers';

const RPC_URL = 'https://rpc.mersennet.com';
const CLOB_PRECOMPILE = '0x0000000000000000000000000000000000000100';
const CLOB_ABI = [
  'function placeOrder(uint64 marketId, bool isBuy, uint256 price, uint256 size, uint8 tif) returns (uint256 orderId, uint256 filled, uint256 remaining)',
  'function cancelOrder(uint256 orderId) returns (bool success)',
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const clob = new ethers.Contract(CLOB_PRECOMPILE, CLOB_ABI, wallet);

// Buy 1 unit at price 65000 on market 1. tif: 0 = Gtc, 1 = Ioc, 2 = Fok.
// Prices/sizes are plain integer chain units (no decimal scaling).
// Explicit gasLimit: eth_estimateGas reverts for accounts without collateral.
const tx = await clob.placeOrder(1, true, 65000, 1, 0, { gasLimit: 300_000 });
await tx.wait();

// Market data: plain REST reads (no signing)
const markets = await fetch('https://trade.mersennet.com/markets').then(r => r.json());

// WebSocket stream
const ws = new WebSocket('${WS_URL}');
ws.onopen = () => ws.send(JSON.stringify({ action: 'subscribe', channel: 'ticker:1' }));
ws.onmessage = (e) => console.log(JSON.parse(e.data));`}
        </pre>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">REST Endpoints</h3>
        </div>
        <div className="divide-y divide-border">
          {ENDPOINTS.map((e) => (
            <div key={e.path} className="flex items-center px-4 py-2.5 text-sm hover:bg-surface-2 transition-colors duration-200">
              <span className={cn(
                'w-16 text-xs font-bold',
                e.method === 'GET' ? 'text-green' : e.method === 'POST' ? 'text-primary' : 'text-red'
              )}>
                {e.method}
              </span>
              <span className="flex-1 font-mono text-xs text-foreground">{e.path}</span>
              <span className="text-xs text-dim">{e.desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Responses &amp; errors</h3>
        </div>
        <div className="divide-y divide-border text-xs">
          {[
            ['200', 'JSON body. Market ids are numeric (see /markets); candles also accept a symbol such as MRSN-USD.'],
            ['400', '{ "error": "Invalid parameter", "detail"?: string } — a non-numeric id, malformed timestamp or out-of-range number.'],
            ['404', '{ "error": "Not found" } — unknown route or market.'],
            ['429', '{ "error": "Too many requests…" } — per-IP budget exhausted; RateLimit-Remaining / RateLimit-Reset headers say when to retry.'],
            ['500', '{ "error": "Internal error" } — logged server-side; report persistent ones via Feedback.'],
          ].map(([code, text]) => (
            <div key={code} className="flex items-start gap-3 px-4 py-2.5">
              <span className={cn('w-10 font-mono font-bold', code === '200' ? 'text-green' : code === '500' ? 'text-red' : 'text-yellow')}>{code}</span>
              <span className="text-dim font-mono break-words">{text}</span>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-border text-xs text-dim">
          WebSocket: frames up to 16 KiB, at most 64 channels per connection; the server closes with 1009 (frame too large) or 1013 (busy — retry with backoff).
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">WebSocket Channels</h3>
        </div>
        <div className="divide-y divide-border">
          {WS_CHANNELS.map((c) => (
            <div key={c.channel} className="flex items-center px-4 py-2.5 text-sm">
              <span className="flex-1 font-mono text-xs text-cyan">{c.channel}</span>
              <span className="text-xs text-dim">{c.desc}</span>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-border">
          <pre className="text-xs text-dim font-mono">
{`// Subscribe: { "action": "subscribe", "channel": "ticker:1" }
// Unsubscribe: { "action": "unsubscribe", "channel": "ticker:1" }`}
          </pre>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-4 space-y-2">
        <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Authentication</h3>
        <p className="text-sm text-dim">
          No API key. Every read endpoint is public (600 requests per minute per IP). Everything that changes state — orders, collateral,
          agent keys, staking, vault deposits — is a transaction you sign with your own wallet and send to the chain; this API never holds
          keys and cannot act for you. For bots, use the <a href="https://docs.mersennet.com/developers/sdks/javascript/" target="_blank" rel="noopener" className="text-primary hover:underline">TypeScript</a>,{' '}
          <a href="https://docs.mersennet.com/developers/sdks/python/" target="_blank" rel="noopener" className="text-primary hover:underline">Python</a> or{' '}
          <a href="https://docs.mersennet.com/developers/sdks/go/" target="_blank" rel="noopener" className="text-primary hover:underline">Go</a> SDK, or sign <code className="bg-surface-2 px-1.5 py-0.5 rounded text-xs font-mono text-foreground">placeOrder</code> calldata yourself (see <a href="https://docs.mersennet.com/developers/tutorials/trade-via-sdk/" target="_blank" rel="noopener" className="text-primary hover:underline">Trade via SDK</a>).
        </p>
      </div>
    </div>
  );
}
