# Changelog

## v1.0.0-beta.1 — 2026-08-10

First public-release candidate of the Mersennet Trade terminal (testnet).

### Trading
- Perpetuals on 5 markets (MRSN, BTC, ETH, SOL, ARB — /USD quoted) with
  cross/isolated margin, up to 50× leverage.
- Order types: limit, market (marketable IOC priced through the live book),
  stop, trailing, TWAP, scale. Client-side TP/SL brackets.
- All order placement, cancellation, and collateral movement is
  wallet-signed on-chain (CLOB precompile at 0x…0100). The gasless relayer
  and unsigned API mutation paths are retired.
- Truthful fill reporting: toasts reflect actual fills (full / partial /
  resting / no-fill) measured against pre-trade state.

### Wallets
- Injected wallets (MetaMask, Rabby — including Rabby's non-standard
  unrecognized-chain error), WalletConnect (Reown), silent reconnect on
  refresh, wrong-network recovery modal, account switching.

### Terminal UX
- WS-first order book with VWAP sweep preview, price grouping, size-unit
  toggle, non-crossing grouped display; sparse books center on the spread.
- Chart: candles/line/area, 8 indicators, drawing tools, depth + heatmap
  modes. Toolbar wraps at narrow widths.
- Positions: partial-close chips, inline TP/SL editor, share cards,
  history with block links. Portfolio PnL from indexed cash flows.
- Onboarding: welcome checklist, product tour, getting-started card.
- i18n: EN, ES, 中文, 한국어, 日本語. Light/dark themes. Mobile bottom-sheet
  layout.

### Platform
- Points program (season 1), leaderboard, referrals, vault, analytics,
  options chain (beta), OTC RFQ, governance preview pages.
- Branded 404/error pages; security headers on all domains; nightly
  Postgres backups with offsite copy; Docker log rotation.

### Known limitations (testnet)
- Email login disabled (wallet-only).
- Bridge endpoints disabled (no live bridge).
- Options/OTC/governance are preview surfaces; liquidity is bot-provided.
- ethers v5 retained (v6 migration planned; ws/elliptic advisories
  accepted and tracked).
