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
bots/     Market-maker, taker, liquidator and vault-manager bots
smoke/    Pre-release browser smoke (Playwright) run against a preview build
```

### Chain integration

- **Network**: Mersennet testnet — chain ID `131071`, native token `MRSN`
- **RPC**: `https://rpc.mersennet.com` (WS `wss://rpc.mersennet.com`), overridable via `RPC_URL` / `WS_URL`
- **Order book**: `mersennet_orders_*` JSON-RPC (`getOrderBook`, `getOpenOrders`,
  `submitOrder`, `cancelOrder`) + `eth_call` against the precompile for
  per-account reads (`getPosition`, `getCollateral`, `getBestBidAsk`)
- **Direct wallet path**: `web/src/lib/orderSigning.ts` encodes
  `placeOrder(uint64,bool,uint256,uint256,uint8)` transactions straight to the
  precompile for fully on-chain, wallet-signed order placement
- **Units**: prices, sizes, and collateral are plain integer chain units
  (no decimal scaling), matching the chain engine's `notional = price × size`
  margin math

### Unified margin account

Every address has **one cross-margin account** on the chain, shared by all
markets and products — there are no per-market or per-product sub-accounts at
the protocol level:

- **Perps** — all perp positions in all markets draw margin from the same
  account. Equity = collateral + unrealized PnL across every open position;
  initial margin is checked on order placement, maintenance margin on
  withdrawals and liquidation.
- **Spot** — spot fills settle against the same native-token balance and
  collateral account.
- **Earn / staking** — delegated stake (staking precompile `0x…0400`) is held
  in the staking escrow; rewards claim straight back to the wallet's native
  balance, where they can be deposited as trading collateral with one call.
- **Multi-collateral** — besides native MRSN, tokens registered in the
  chain's collateral registry (e.g. USDC) can be deposited via
  `depositTokenCollateral`. Each asset has a haircut weight (bps) and a
  value rate; weighted values are summed into the same account equity used
  for perp margin.

The "sub-accounts" feature in the terminal is a client-side organizational
layer (separate keys), not separate margin pools.

### Order types

- **Chain-native**: limit / market, `GTC` / `IOC` / `FOK`, **post-only**
  (rejects instead of taking) and **good-till-date** (auto-cancels on-chain at
  a block height — works with the tab closed).
- **Client/keeper-side**: TWAP and scale (API slicer), stop and trailing
  triggers, and **chase** (client keeper re-pegs a post-only order to the top
  of the book via the one-click session key until it fills).
- **Permissionless listing**: anyone can create a market on-chain via
  `createMarket(symbol, tick, lot)` for a 100 MRSN listing fee.

## Quick start

```bash
cp api/.env.example .env      # set POSTGRES_PASSWORD, JWT_SECRET, ADMIN_API_KEY, REPORT_SECRET
docker compose up -d --build
```

Brings up Postgres, the API (`:4005`), the indexer, and the web app (`:3000`)
against the public testnet (`RPC_URL` defaults to `https://rpc.mersennet.com`).
The bots under `bots/` start with `--profile bots` and each need a funded key
(`MM_PRIVATE_KEY`). In production, Caddy on `trade.mersennet.com` serves the web
app and proxies `/api` + `/ws` to the API service; the deployment tooling for the
Mersennet-run instance (hosts, standby, release gate) is not part of this repository.

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

## Contributing

Pull requests are welcome. The first one asks you to sign the
[Contributor License Agreement](CLA.md) (one comment on the PR). Security
issues: see [SECURITY.md](SECURITY.md) — please do not open a public issue.

## License

[Business Source License 1.1](LICENSE). Production use is granted for
interacting with a Mersennet network — including running your own terminal,
API or indexer against it; use for other networks or as a competing hosted
service needs a commercial license (licensing@mersennet.com). Converts to
Apache 2.0 on 2030-09-30.
