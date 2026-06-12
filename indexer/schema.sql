-- Mersennet Trade indexer schema
-- Tables for historical chain event aggregation

CREATE TABLE IF NOT EXISTS indexer_state (
    id              SMALLINT PRIMARY KEY DEFAULT 1,
    last_block      BIGINT NOT NULL DEFAULT 0,
    last_indexed_at TIMESTAMPTZ
);
INSERT INTO indexer_state (id, last_block) VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS trades (
    id               BIGSERIAL PRIMARY KEY,
    block_number     BIGINT NOT NULL,
    block_timestamp  TIMESTAMPTZ NOT NULL,
    market_id        INTEGER NOT NULL,
    taker            TEXT NOT NULL,
    maker            TEXT NOT NULL,
    side             TEXT NOT NULL,
    price            NUMERIC(78, 0) NOT NULL,
    size             NUMERIC(78, 0) NOT NULL,
    UNIQUE (block_number, market_id, taker, maker, price, size)
);
CREATE INDEX IF NOT EXISTS idx_trades_market_time ON trades (market_id, block_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_taker      ON trades (taker, block_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_maker      ON trades (maker, block_timestamp DESC);

CREATE TABLE IF NOT EXISTS orders_history (
    order_id      TEXT PRIMARY KEY,
    block_number  BIGINT NOT NULL,
    owner         TEXT NOT NULL,
    market_id     INTEGER NOT NULL,
    side          TEXT NOT NULL,
    price         NUMERIC(78, 0) NOT NULL,
    size          NUMERIC(78, 0) NOT NULL,
    filled        NUMERIC(78, 0) NOT NULL DEFAULT 0,
    status        TEXT NOT NULL,
    tif           TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_owner ON orders_history (owner);

CREATE TABLE IF NOT EXISTS collateral_events (
    id            BIGSERIAL PRIMARY KEY,
    block_number  BIGINT NOT NULL,
    address       TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    amount        NUMERIC(78, 0) NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collateral_address ON collateral_events (address, block_number DESC);

CREATE TABLE IF NOT EXISTS liquidations (
    id            BIGSERIAL PRIMARY KEY,
    block_number  BIGINT NOT NULL,
    address       TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_liquidations_address ON liquidations (address);

CREATE TABLE IF NOT EXISTS candles (
    market_id    INTEGER NOT NULL,
    resolution   TEXT NOT NULL,
    open_time    TIMESTAMPTZ NOT NULL,
    open         NUMERIC(78, 0) NOT NULL,
    high         NUMERIC(78, 0) NOT NULL,
    low          NUMERIC(78, 0) NOT NULL,
    close        NUMERIC(78, 0) NOT NULL,
    volume       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    trade_count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (market_id, resolution, open_time)
);
CREATE INDEX IF NOT EXISTS idx_candles_market_res_time
    ON candles (market_id, resolution, open_time DESC);

-- pnl/volume/best_trade/worst_trade are stored as plain USD floats (not raw
-- 1e26-scaled integers). The indexer divides price*size by 1e26 before
-- writing, so columns need a fractional scale to keep cents-level precision.
CREATE TABLE IF NOT EXISTS leaderboard (
    address       TEXT NOT NULL,
    period        TEXT NOT NULL,
    pnl           NUMERIC(40, 8) NOT NULL DEFAULT 0,
    pnl_pct       NUMERIC(20, 4) NOT NULL DEFAULT 0,
    volume        NUMERIC(40, 8) NOT NULL DEFAULT 0,
    trade_count   INTEGER NOT NULL DEFAULT 0,
    win_count     INTEGER NOT NULL DEFAULT 0,
    loss_count    INTEGER NOT NULL DEFAULT 0,
    best_trade    NUMERIC(40, 8) NOT NULL DEFAULT 0,
    worst_trade   NUMERIC(40, 8) NOT NULL DEFAULT 0,
    max_drawdown  NUMERIC(20, 4) NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (address, period)
);
-- Idempotent column adds for existing deployments where the table was created
-- before these analytics columns were tracked.
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS pnl_pct      NUMERIC(20, 4) NOT NULL DEFAULT 0;
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS win_count    INTEGER        NOT NULL DEFAULT 0;
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS loss_count   INTEGER        NOT NULL DEFAULT 0;
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS best_trade   NUMERIC(40, 8) NOT NULL DEFAULT 0;
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS worst_trade  NUMERIC(40, 8) NOT NULL DEFAULT 0;
ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS max_drawdown NUMERIC(20, 4) NOT NULL DEFAULT 0;
-- Older deployments stored these as NUMERIC(78,0); widen them so post-1e26
-- divisions can keep cents precision instead of truncating to whole dollars.
ALTER TABLE leaderboard ALTER COLUMN pnl         TYPE NUMERIC(40, 8);
ALTER TABLE leaderboard ALTER COLUMN volume      TYPE NUMERIC(40, 8);
ALTER TABLE leaderboard ALTER COLUMN best_trade  TYPE NUMERIC(40, 8);
ALTER TABLE leaderboard ALTER COLUMN worst_trade TYPE NUMERIC(40, 8);

CREATE INDEX IF NOT EXISTS idx_leaderboard_period_pnl
    ON leaderboard (period, pnl DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_period_volume
    ON leaderboard (period, volume DESC);
