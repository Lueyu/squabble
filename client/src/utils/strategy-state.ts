import type { BuilderProfile } from '@shared/api.interface';
import type { StrategyMarketRuntime } from '@shared/strategy.interface';

/** A cached response must not imply a current monitoring heartbeat. */
export function strategyDisplayState(profile: Pick<BuilderProfile, 'status' | 'version' | 'config'>,
  market: StrategyMarketRuntime, runtimeVersion: number, now = Date.now()):
  StrategyMarketRuntime['state'] | 'disabled' | 'outdated' | 'offline' {
  if (!profile.config.automation?.enabled) return 'disabled';
  if (profile.status !== 'active') return 'stopped';
  if (profile.version !== runtimeVersion) return 'outdated';
  if (market.state === 'monitoring') {
    const checkedAt = market.lastCheckAt ? Date.parse(market.lastCheckAt) : NaN;
    const maxAge = Math.max(180, profile.config.automation.monitorSeconds * 3) * 1000;
    if (!Number.isFinite(checkedAt) || now - checkedAt > maxAge || checkedAt > now + 60000) return 'offline';
  }
  return market.state;
}
