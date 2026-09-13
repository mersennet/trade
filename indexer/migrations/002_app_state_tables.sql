-- Application-state tables (vault, staking, points, competitions, builder
-- codes, bridge chains, auth magic links, oracle cache, etc.) that the API
-- expects but were never part of the original indexer schema. All tables use
-- IF NOT EXISTS so this migration is safe to re-apply.

-- ─── Vault (yield strategy LP) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vault_state (
    id            SMALLINT PRIMARY KEY DEFAULT 1,
    total_shares  NUMERIC(78, 8) NOT NULL DEFAULT 0,
    total_tvl     NUMERIC(78, 8) NOT NULL DEFAULT 0,
    total_pnl     NUMERIC(78, 8) NOT NULL DEFAULT 0,
    apy_7d        NUMERIC(20, 6) NOT NULL DEFAULT 0,
    apy_30d       NUMERIC(20, 6) NOT NULL DEFAULT 0,
    depositors    INTEGER         NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO vault_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS vault_deposits (
    id              BIGSERIAL PRIMARY KEY,
    address         TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('deposit','withdraw')),
    amount          NUMERIC(78, 8) NOT NULL,
    shares          NUMERIC(78, 8) NOT NULL,
    vault_tvl_after NUMERIC(78, 8) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vault_deposits_address ON vault_deposits (address, created_at DESC);

-- ─── Staking (MRSN in, USDC rewards out) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS staking_state (
    id                          SMALLINT PRIMARY KEY DEFAULT 1,
    total_staked                NUMERIC(78, 8) NOT NULL DEFAULT 0,
    total_rewards_distributed   NUMERIC(78, 8) NOT NULL DEFAULT 0,
    reward_rate                 NUMERIC(20, 8) NOT NULL DEFAULT 0,
    stakers_count               INTEGER         NOT NULL DEFAULT 0,
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO staking_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS staking_balance (
    address              TEXT PRIMARY KEY,
    staked               NUMERIC(78, 8) NOT NULL DEFAULT 0,
    rewards_pending      NUMERIC(78, 8) NOT NULL DEFAULT 0,
    unbonding            NUMERIC(78, 8) NOT NULL DEFAULT 0,
    unbond_available_at  TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staking (
    id          BIGSERIAL PRIMARY KEY,
    address     TEXT NOT NULL,
    action      TEXT NOT NULL CHECK (action IN ('stake','unstake','claim')),
    amount      NUMERIC(78, 8) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staking_address ON staking (address, created_at DESC);

-- ─── Points / loyalty ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS points (
    id          BIGSERIAL PRIMARY KEY,
    address     TEXT NOT NULL,
    season      INTEGER NOT NULL DEFAULT 1,
    point_type  TEXT NOT NULL,
    amount      NUMERIC(20, 4) NOT NULL DEFAULT 0,
    reason      TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_points_address_season ON points (address, season);

CREATE TABLE IF NOT EXISTS points_balance (
    address           TEXT NOT NULL,
    season            INTEGER NOT NULL DEFAULT 1,
    total_points      NUMERIC(20, 4) NOT NULL DEFAULT 0,
    trading_points    NUMERIC(20, 4) NOT NULL DEFAULT 0,
    lp_points         NUMERIC(20, 4) NOT NULL DEFAULT 0,
    referral_points   NUMERIC(20, 4) NOT NULL DEFAULT 0,
    tier              TEXT NOT NULL DEFAULT 'Bronze',
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (address, season)
);
-- Verified node runners (awarded daily by the API, see routes/nodes.js).
ALTER TABLE points_balance ADD COLUMN IF NOT EXISTS node_points NUMERIC(20, 4) NOT NULL DEFAULT 0;

-- ─── Competitions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competitions (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    comp_type    TEXT NOT NULL DEFAULT 'pnl',
    start_at     TIMESTAMPTZ NOT NULL,
    end_at       TIMESTAMPTZ NOT NULL,
    prize_pool   NUMERIC(78, 4) NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'upcoming',
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS competition_entries (
    id              BIGSERIAL PRIMARY KEY,
    competition_id  BIGINT REFERENCES competitions(id) ON DELETE CASCADE,
    address         TEXT NOT NULL,
    pnl             NUMERIC(78, 4) NOT NULL DEFAULT 0,
    roi             NUMERIC(20, 4) NOT NULL DEFAULT 0,
    volume          NUMERIC(78, 4) NOT NULL DEFAULT 0,
    rank            INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (competition_id, address)
);

-- ─── Builder codes (referral / fee-share) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS builder_codes (
    code               TEXT PRIMARY KEY,
    owner              TEXT NOT NULL,
    label              TEXT,
    fee_share_bps      INTEGER NOT NULL DEFAULT 100,
    total_volume       NUMERIC(78, 4) NOT NULL DEFAULT 0,
    total_fees_earned  NUMERIC(78, 4) NOT NULL DEFAULT 0,
    total_orders       INTEGER NOT NULL DEFAULT 0,
    active             BOOLEAN NOT NULL DEFAULT true,
    created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Bridge chains (curated list for /bridge UI) ──────────────────────────
CREATE TABLE IF NOT EXISTS bridge_chains (
    name             TEXT PRIMARY KEY,
    chain_id         INTEGER,
    deposit_address  TEXT,
    confirmations    INTEGER NOT NULL DEFAULT 12,
    status           TEXT NOT NULL DEFAULT 'active'
);

-- ─── API keys ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
    id           BIGSERIAL PRIMARY KEY,
    address      TEXT NOT NULL,
    label        TEXT,
    key_hash     TEXT NOT NULL UNIQUE,
    permissions  TEXT[] NOT NULL DEFAULT ARRAY['read'],
    rate_limit   INTEGER NOT NULL DEFAULT 100,
    active       BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_keys_address ON api_keys (address);

-- ─── Auth magic links ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_magic_links (
    token       TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    used        BOOLEAN NOT NULL DEFAULT false,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Oracle price cache (for /oracle/prices) ─────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_prices (
    symbol      TEXT PRIMARY KEY,
    price       NUMERIC(78, 8) NOT NULL DEFAULT 0,
    confidence  NUMERIC(20, 8) NOT NULL DEFAULT 0,
    sources     INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Market metadata (some routes JOIN against this) ─────────────────────
CREATE TABLE IF NOT EXISTS markets (
    id            INTEGER PRIMARY KEY,
    symbol        TEXT NOT NULL,
    base          TEXT NOT NULL,
    quote         TEXT NOT NULL,
    max_leverage  INTEGER NOT NULL DEFAULT 10,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO markets (id, symbol, base, quote, max_leverage) VALUES
    (1, 'MRSN/USDC', 'MRSN', 'USDC', 50),
    (2, 'BTC/USDC',  'BTC',  'USDC', 100),
    (3, 'ETH/USDC',  'ETH',  'USDC', 50),
    (4, 'SOL/USDC',  'SOL',  'USDC', 20),
    (5, 'ARB/USDC',  'ARB',  'USDC', 20)
ON CONFLICT (id) DO NOTHING;

-- ─── Market listing votes ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_proposal_votes (
    id           BIGSERIAL PRIMARY KEY,
    proposal_id  BIGINT NOT NULL,
    voter        TEXT NOT NULL,
    direction    TEXT NOT NULL CHECK (direction IN ('for','against')),
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (proposal_id, voter)
);

-- ─── 24h ticker cache (drives % change in market tabs) ───────────────────
CREATE TABLE IF NOT EXISTS market_ticker_24h (
    market_id      INTEGER PRIMARY KEY,
    open_24h       NUMERIC(78, 8) NOT NULL DEFAULT 0,
    high_24h       NUMERIC(78, 8) NOT NULL DEFAULT 0,
    low_24h        NUMERIC(78, 8) NOT NULL DEFAULT 0,
    volume_24h     NUMERIC(78, 8) NOT NULL DEFAULT 0,
    change_24h_pct NUMERIC(20, 6) NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);
