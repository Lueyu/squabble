const { ensureSettingsKey } = require('./ensure-settings-key.cjs');
const { ensureJwtSecret } = require('./ensure-jwt-secret.cjs');

process.umask(0o077);
if (process.env.PUBLIC_DEPLOYMENT === 'true') {
  const jwt = process.env.JWT_SECRET || '';
  const settings = process.env.SETTINGS_ENCRYPTION_KEY || '';
  const pg = process.env.POSTGRES_PASSWORD || '';
  if (
    jwt.length < 32 ||
    settings.length < 32 ||
    pg.length < 32 ||
    jwt === settings ||
    [jwt, settings, pg].some((value) => value.startsWith('replace-with-')) ||
    jwt === 'change-me-in-production-0123456789abcdef'
  ) {
    process.stderr.write(
      'Cannot start public deployment: use independent random database, JWT, and settings secrets (at least 32 characters).\n',
    );
    process.exit(1);
  }
}
try {
  process.env.JWT_SECRET = ensureJwtSecret(process.env.JWT_SECRET, '/app/.secrets/jwt.key');
  process.env.SETTINGS_ENCRYPTION_KEY = ensureSettingsKey(
    process.env.SETTINGS_ENCRYPTION_KEY,
    '/app/.secrets/settings.key',
  );
  if (process.env.SQUABBLE_UPDATE_MODE === 'docker') {
    ensureJwtSecret('', '/app/.secrets/update-token');
  }
} catch (error) {
  process.stderr.write(`Cannot start Squabble: ${error.message}\n`);
  process.exit(1);
}

require('../dist/server/main.js');
