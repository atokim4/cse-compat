import type { SearchQuery } from "./types.js";

function hostMatches(host: string, siteHost: string): boolean {
  return host === siteHost || host.endsWith(`.${siteHost}`);
}

/** `site` is a hostname with an optional port and path prefix (`docs.example/guides`). Subdomains match. */
export function siteMatches(url: URL, site: string): boolean {
  const slash = site.indexOf("/");
  const siteHost = slash === -1 ? site : site.slice(0, slash);
  const host = siteHost.includes(":") ? url.host : url.hostname;
  return hostMatches(host, siteHost) && (slash === -1 || url.pathname.startsWith(site.slice(slash)));
}

/**
 * Whether a page is inside the query's site restrictions (engine sites, siteSearch, excluded sites).
 * Web backends get these as `site:` operators, which upstream engines honour loosely, so their hits are
 * checked again with this before they are served.
 */
export function withinSites(page: string, query: Pick<SearchQuery, "includeSites" | "requiredSite" | "excludeSites">): boolean {
  let url: URL;
  try {
    url = new URL(page);
  } catch {
    return false;
  }
  if (query.includeSites.length > 0 && !query.includeSites.some((s) => siteMatches(url, s))) return false;
  if (query.requiredSite !== undefined && !siteMatches(url, query.requiredSite)) return false;
  return !query.excludeSites.some((s) => siteMatches(url, s));
}
