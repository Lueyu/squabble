export type AuthMode = 'local' | 'account';

// Routes only mount after the server confirms its mode. Account is the safe
// default for isolated consumers and existing account-mode integrations.
let authMode: AuthMode = 'account';

export function getAuthMode(): AuthMode {
  return authMode;
}

export function setAuthMode(mode: AuthMode): void {
  authMode = mode;
}
