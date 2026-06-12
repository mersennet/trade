'use client';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { API_BASE, api, type ApiKey } from '@/lib/api';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'wss://trade.mersennet.com/ws';

const ENDPOINTS = [
  { method: 'GET', path: '/markets', desc: 'List all markets' },
  { method: 'GET', path: '/markets/:id/orderbook', desc: 'Get order book' },
  { method: 'GET', path: '/markets/:id/ticker', desc: 'Get ticker data' },
  { method: 'GET', path: '/candles/:id?resolution=1h', desc: 'Get OHLCV candles' },
  { method: 'GET', path: '/trades/:marketId', desc: 'Get recent trades' },
  { method: 'GET', path: '/positions/:address', desc: 'Get open positions' },
  { method: 'GET', path: '/orders/:address', desc: 'Get open orders' },
  { method: 'POST', path: '/orders', desc: 'Submit new order' },
  { method: 'DELETE', path: '/orders/:id', desc: 'Cancel order' },
  { method: 'GET', path: '/collateral/:address', desc: 'Get collateral balance' },
  { method: 'POST', path: '/collateral/deposit', desc: 'Deposit collateral' },
  { method: 'GET', path: '/leaderboard', desc: 'Get leaderboard rankings' },
  { method: 'GET', path: '/points/:address', desc: 'Get points balance' },
  { method: 'GET', path: '/vault/state', desc: 'Get vault TVL and APY' },
  { method: 'POST', path: '/vault/deposit', desc: 'Deposit to vault' },
  { method: 'GET', path: '/staking/state', desc: 'Get staking stats' },
  { method: 'POST', path: '/staking/stake', desc: 'Stake MRSN tokens' },
  { method: 'GET', path: '/competitions', desc: 'List competitions' },
  { method: 'GET', path: '/builder-codes', desc: 'List builder codes' },
  { method: 'GET', path: '/stats', desc: 'Protocol statistics' },
  { method: 'GET', path: '/spot', desc: 'List spot markets' },
  { method: 'POST', path: '/spot/order', desc: 'Place spot order' },
  { method: 'GET', path: '/options/chains', desc: 'Option chains' },
  { method: 'POST', path: '/options/order', desc: 'Place option order' },
  { method: 'GET', path: '/prelaunch', desc: 'Pre-launch markets' },
  { method: 'GET', path: '/whales/activity', desc: 'Whale activity feed' },
  { method: 'POST', path: '/agents', desc: 'Create AI trading agent' },
  { method: 'POST', path: '/otc/rfq', desc: 'Request for quote' },
  { method: 'GET', path: '/bridge/chains', desc: 'Supported bridge chains' },
  { method: 'GET', path: '/oracle/prices', desc: 'Oracle price feeds' },
  { method: 'POST', path: '/paper/order', desc: 'Paper trade order' },
  { method: 'GET', path: '/funding-arb/comparison', desc: 'Funding rate comparison' },
  { method: 'POST', path: '/orders/twap', desc: 'Submit TWAP order' },
  { method: 'GET', path: '/health', desc: 'Health check' },
];

const WS_CHANNELS = [
  { channel: 'ticker:{marketId}', desc: 'Real-time price updates' },
  { channel: 'orderbook:{marketId}', desc: 'Live order book updates' },
  { channel: 'trades:{marketId}', desc: 'Real-time trade stream' },
  { channel: 'blocks', desc: 'New block notifications' },
];

export default function ApiPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (address) api.getApiKeys(address).then((r) => setKeys(r.keys)).catch(() => {});
  }, [address]);

  const handleCreate = async () => {
    if (!address) return;
    setCreating(true);
    try {
      const res = await api.createApiKey(address, newLabel || undefined);
      setNewKey(res.key);
      setNewLabel('');
      toast('API key created! Copy it now; it won\'t be shown again.', 'success');
      api.getApiKeys(address).then((r) => setKeys(r.keys));
    } catch (e) { toast(`Failed: ${(e as Error).message}`, 'error'); }
    finally { setCreating(false); }
  };

  const handleRevoke = async (id: number) => {
    try {
      await api.deleteApiKey(id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
      toast('API key revoked', 'info');
    } catch (e) { toast(`Failed: ${(e as Error).message}`, 'error'); }
  };

  return (
    <div className="p-4 max-w-full space-y-8">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-foreground mb-2">Mersennet Trade API</h2>
        <p className="text-dim">REST + WebSocket API for trading bots and integrations</p>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {[
          { label: 'Base URL', value: API_BASE },
          { label: 'WebSocket', value: WS_URL },
          { label: 'Rate Limit', value: '300 requests/min (read), 60/min (write)' },
        ].map((item) => (
          <div key={item.label} className="bg-surface border border-border rounded-xl p-4">
            <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">{item.label}</p>
            <p className="text-sm text-foreground font-mono break-all">{item.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Quick Start</h3>
        <pre className="bg-surface-2 rounded-lg p-4 text-xs text-foreground overflow-x-auto font-mono">
{`// TypeScript
import { MersennetTradeClient } from '@mersennet-trade/sdk';
const client = new MersennetTradeClient('https://trade.mersennet.com');

const markets = await client.getMarkets();
const book = await client.getOrderBook(1);
const result = await client.submitOrder({
  owner: '0x...', market_id: 1, side: 'Buy',
  price: '65000', size: '1'
});

// WebSocket
client.connect();
client.subscribe('ticker:1', (data) => console.log(data));`}
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

      <div className="bg-surface border border-border rounded-xl p-4 space-y-4">
        <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">API Key Management</h3>
        <p className="text-sm text-dim">Include your API key in request headers: <code className="bg-surface-2 px-1.5 py-0.5 rounded text-xs font-mono text-foreground">X-API-Key: your-key</code></p>

        {isConnected ? (
          <>
            <div className="flex gap-2">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Key label (e.g. Trading Bot)"
                className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors"
              />
              <button
                onClick={handleCreate}
                disabled={creating}
                className="px-5 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-medium disabled:opacity-50 transition-all duration-200"
              >
                {creating ? 'Creating...' : 'Generate Key'}
              </button>
            </div>

            {newKey && (
              <div className="bg-green/5 border border-green/20 rounded-lg p-3">
                <p className="text-[10px] text-green uppercase tracking-wider font-medium mb-1">New API Key (copy now!)</p>
                <div className="flex gap-2 items-center">
                  <code className="flex-1 bg-surface-2 rounded px-3 py-2 text-xs font-mono text-foreground break-all">{newKey}</code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(newKey); toast('Copied!', 'success'); }}
                    className="px-3 py-2 bg-surface-2 text-dim hover:text-foreground rounded text-xs transition-colors shrink-0"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}

            {keys.length > 0 && (
              <div className="space-y-2">
                {keys.map((k) => (
                  <div key={k.id} className="flex items-center justify-between bg-surface-2 rounded-lg px-4 py-3">
                    <div>
                      <p className="text-xs font-medium text-foreground">{k.label}</p>
                      <p className="text-[10px] text-dim font-mono">
                        {k.permissions?.join(', ')} · Created {new Date(k.created_at).toLocaleDateString()}
                        {k.last_used_at && ` · Last used ${new Date(k.last_used_at).toLocaleDateString()}`}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRevoke(k.id)}
                      className={cn('px-3 py-1 rounded text-xs font-medium transition-colors', k.active ? 'bg-red/10 text-red hover:bg-red/20' : 'text-dim')}
                      disabled={!k.active}
                    >
                      {k.active ? 'Revoke' : 'Revoked'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-dim">Connect wallet to manage API keys</p>
        )}
      </div>
    </div>
  );
}
