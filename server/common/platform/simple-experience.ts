/**
 * Simple experience (the default product surface).
 *
 * The streamlined 3-entry layout is ON by default. It can be switched off in
 * two explicit ways, both of which are opt-in:
 *   - SQUABBLE_SIMPLE_EXPERIENCE=false  (environment / power-user override)
 *   - an experience_preferences row with enabled=false (in-app toggle)
 *
 * Previously the flag defaulted to OFF and had to be enabled with
 * SQUABBLE_SIMPLE_EXPERIENCE=true, which hid the simplified product from
 * every new user.
 */
export function simpleExperienceEnabled(preferenceEnabled?: boolean | null): boolean {
  if (process.env.SQUABBLE_SIMPLE_EXPERIENCE === 'false') return false;
  return preferenceEnabled ?? true;
}

/** Whether the environment-level override alone disables the simple experience. */
export function simpleExperienceEnvironmentEnabled(): boolean {
  return process.env.SQUABBLE_SIMPLE_EXPERIENCE !== 'false';
}
