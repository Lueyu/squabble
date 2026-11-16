const { randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');

const KNOWN_DEMO_SECRET = 'change-me-in-production-0123456789abcdef';

/** Keep an automatically generated encryption key stable across app rebuilds. */
function ensureSettingsKey(explicitKey, keyFile) {
  if (explicitKey) {
    if (explicitKey.length < 16 || explicitKey === KNOWN_DEMO_SECRET) {
      throw new Error('SETTINGS_ENCRYPTION_KEY must be a private value of at least 16 characters');
    }
    return explicitKey;
  }

  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  let stored;
  try {
    stored = readFileSync(keyFile, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const generated = randomBytes(32).toString('hex');
    try {
      writeFileSync(keyFile, `${generated}\n`, { flag: 'wx', mode: 0o600 });
      stored = generated;
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      stored = readFileSync(keyFile, 'utf8').trim();
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(stored)) {
    throw new Error(
      'Saved settings encryption key is invalid; restore the settings-secrets volume',
    );
  }
  return stored;
}

module.exports = { ensureSettingsKey };
