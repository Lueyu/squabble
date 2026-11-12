import type { AgentVersionConfig } from './agent-roster.interface';

/** Both personal conversations and team work execute the same saved preferences. */
export function agentWorkingInstructions(config: AgentVersionConfig): string {
  const preference = config.preferences.userPreferences;
  if (!preference) return config.instructions;
  const label = config.preferences.language === 'en' ? 'User preferences: ' : '用户明确设置的通用偏好：';
  return `${config.instructions}\n${label}${preference}`;
}
