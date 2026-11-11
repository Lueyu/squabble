import type { Page, Route } from 'playwright-core';
import { publicSourceUrl, type ResolvePublic } from '../data-library.fetch';

/** All requests also traverse BrowserEgressProxy, which pins the validated public IP at CONNECT. */
export class BrowserNavigationPolicy {
  private requests = 0;
  constructor(private readonly resolve?: ResolvePublic, private readonly maxRequests = 160) {}

  async url(input: string): Promise<URL> {
    try { return (await publicSourceUrl(input, this.resolve)).url; }
    catch { throw new Error('BROWSER_BLOCKED'); }
  }

  async route(route: Route, page: Page | undefined): Promise<void> {
    const request = route.request();
    if (++this.requests > this.maxRequests) throw new Error('BROWSER_REQUEST_LIMIT');
    if (!['GET', 'HEAD'].includes(request.method())) { await route.abort('blockedbyclient'); return; }
    let current: Page;
    try { current = request.frame().page(); } catch { await route.abort('blockedbyclient'); return; }
    if (page && current !== page) { await route.abort('blockedbyclient'); return; }
    await this.url(request.url());
    if (['image', 'media', 'font'].includes(request.resourceType())) { await route.abort('blockedbyclient'); return; }
    await route.fallback();
  }
}

/** Deployer-owned evidence from actual backend network tests; never accepted from browser tool arguments. */
export interface RemoteBrowserNetworkVerification {
  deploymentId: string; policyVersion: 'squabble-public-pinned-v1'; expiresAt: string; evidenceArtifactId: string;
  controls: { navigation: boolean; redirects: boolean; subresources: boolean; downloads: boolean; dnsPinning: boolean; privateNetwork: boolean };
}
export function verifiedRemoteBrowserPolicy(proof: RemoteBrowserNetworkVerification | undefined, deploymentId: string): boolean {
  return Boolean(proof && deploymentId && proof.deploymentId === deploymentId && proof.policyVersion === 'squabble-public-pinned-v1'
    && proof.evidenceArtifactId && Number.isFinite(Date.parse(proof.expiresAt)) && Date.parse(proof.expiresAt) > Date.now()
    && ['navigation', 'redirects', 'subresources', 'downloads', 'dnsPinning', 'privateNetwork']
      .every(key => proof.controls?.[key as keyof RemoteBrowserNetworkVerification['controls']] === true));
}
