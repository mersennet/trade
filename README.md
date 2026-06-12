# Mersennet Trade

Perpetuals trading terminal for **Mersennet** — the zero-knowledge L1 with a native
on-chain central limit order book (CLOB). Matching, margin, and collateral accounting
run inside the chain's **Mersennet order-book engine** (precompile `0x…0100`); there is no
off-chain sequencer and no external settlement contracts.

Live at **[trade.mersennet.com](https://trade.mersennet.com)**.

## Architecture

```
web/      Next.js 16 trading terminal (charts, order entry, portfolio, leaderboard)
api/      REST + WebSocket API (Express + Postgres) — proxies chain reads, manages
          conditional/TWAP orders, candles, leaderboard, points
indexer/  Tails chain events (eth_subscribe + mersennet_subscribe) into Postgres
bots/     Market-maker bot
scripts/  Postgres backup + health watchdog
```

### Chain integration

- **Network**: Mersennet testnet — chain ID `131071`, native token `MRSN`
- **RPC**: `http://46.225.30.187:8545` (WS `:8546`), overridable via `RPC_URL` / `WS_URL`
- **Order book**: `mersennet_orders_*` JSON-RPC (`getOrderBook`, `getOpenOrders`,
  `submitOrder`, `cancelOrder`) + `eth_call` against the precompile for
  per-account reads (`getPosition`, `getCollateral`, `getBestBidAsk`)
- **Direct wallet path**: `web/src/lib/orderSigning.ts` encodes
  `placeOrder(uint64,bool,uint256,uint256,uint8)` transactions straight to the
  precompile for fully on-chain, wallet-signed order placement
- **Units**: prices, sizes, and collateral are plain integer chain units
  (no decimal scaling), matching the chain engine's `notional = price × size`
  margin math

## Quick start

```bash
docker compose up -d --build
```

Brings up Postgres, the API (`:4005`), the indexer, and the web app (`:3000`).
In production, Caddy on `trade.mersennet.com` serves the web app and proxies
`/api` + `/ws` to the API service.

### Development

```bash
# API
cd api && npm install && npm start

# Web
cd web && npm install && npm run dev

# Indexer
cd indexer && npm install && node index.js
```

## Ecosystem

- [mersennet.com](https://mersennet.com) — project site
- [docs.mersennet.com](https://docs.mersennet.com) — protocol documentation
- [explorer.mersennet.com](https://explorer.mersennet.com) — block explorer
- [faucet.mersennet.com](https://faucet.mersennet.com) — testnet MRSN faucet
