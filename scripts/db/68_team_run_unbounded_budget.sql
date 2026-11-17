-- An unset monetary cap is unknown, never a zero-cost reservation.
-- Existing positive reservations and every finite per-run call limit remain unchanged.
ALTER TABLE team_run_cycles ALTER COLUMN reserved_cost_usd DROP NOT NULL;
