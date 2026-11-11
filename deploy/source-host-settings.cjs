function registry(value) {
  try {
    const entries = value ? JSON.parse(value) : [];
    if (!Array.isArray(entries) || entries.length > 20) throw new Error('shape');
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.endpoint !== 'string') throw new Error('entry');
      const url = new URL(entry.endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || entry.endpoint.length > 500) throw new Error('endpoint');
    }
    return entries;
  } catch { throw new Error('EXISTING_MCP_REGISTRY_INVALID'); }
}

function origins(value) {
  try {
    const entries = (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
    for (const entry of entries) {
      const url = new URL(entry);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('origin');
    }
    return entries.map(entry => new URL(entry).origin);
  } catch { throw new Error('EXISTING_DOCUMENT_ORIGINS_INVALID'); }
}

/** Only the stable managed AKTools entry is replaced; custom exact bindings stay. */
function mergeSourceHostSettings(existing, managed) {
  const previous = registry(existing.TOOL_MCP_LOCAL_SERVICES_JSON);
  const bundled = registry(managed.TOOL_MCP_LOCAL_SERVICES_JSON);
  const merged = [...previous.filter(entry => entry.id !== 'aktools'), ...bundled];
  if (merged.length > 20) throw new Error('EXISTING_MCP_REGISTRY_INVALID');
  const allowed = [...new Set([...origins(existing.DOCUMENT_ALLOWED_ORIGINS), ...origins(managed.DOCUMENT_ALLOWED_ORIGINS)])];
  return { ...managed, TOOL_MCP_LOCAL_SERVICES_JSON: JSON.stringify(merged), DOCUMENT_ALLOWED_ORIGINS: allowed.join(',') };
}

function environmentValue(value) {
  for (const quote of ["'", '"', '`']) if (!value.includes(quote)) return `${quote}${value}${quote}`;
  throw new Error('BUNDLE_SETTING_CANNOT_BE_QUOTED');
}

module.exports = { mergeSourceHostSettings, environmentValue };
