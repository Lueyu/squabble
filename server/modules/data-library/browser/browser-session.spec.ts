import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreSourceBrowserStorageState } from './browser-session';

test('domain cookies can cover subdomains, while host-only, sibling and lookalike cookies cannot', () => {
  const source = new URL('https://sub.public.site/article');
  const state = restoreSourceBrowserStorageState(JSON.stringify({
    cookies: [
      { name: 'covering-domain', domain: '.public.site' },
      { name: 'exact-host', domain: 'sub.public.site' },
      { name: 'parent-host-only', domain: 'public.site' },
      { name: 'sibling', domain: '.sibling.public.site' },
      { name: 'lookalike', domain: '.public.site.other.site' },
    ],
    origins: [
      { origin: 'https://sub.public.site', localStorage: [] },
      { origin: 'http://sub.public.site', localStorage: [] },
      { origin: 'https://public.site', localStorage: [] },
    ],
  }), source)!;
  assert.deepEqual(state.cookies.map(cookie => cookie.name), ['covering-domain', 'exact-host']);
  assert.deepEqual(state.origins.map(origin => origin.origin), ['https://sub.public.site']);
});
