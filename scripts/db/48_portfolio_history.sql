-- Additive public market-data caches. No portfolio, order or saved NAV rows are rewritten.
CREATE TABLE IF NOT EXISTS portfolio_history_prices (
  symbol text NOT NULL, market text NOT NULL, currency text NOT NULL,
  price_date date NOT NULL, close numeric NOT NULL CHECK (close > 0), source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_history_price_key ON portfolio_history_prices(symbol, price_date);
CREATE TABLE IF NOT EXISTS portfolio_history_fx (
  currency text NOT NULL, rate_date date NOT NULL, usd_rate numeric NOT NULL CHECK (usd_rate > 0), source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_history_fx_key ON portfolio_history_fx(currency, rate_date);
CREATE TABLE IF NOT EXISTS portfolio_history_fetches (
  resource text PRIMARY KEY, lease_token text, lease_until timestamptz, next_attempt_at timestamptz NOT NULL,
  completed_at timestamptz, error text, coverage jsonb
);
