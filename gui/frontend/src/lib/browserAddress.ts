/**
 * The page's address as the Browser tab's bar shows it while nobody edits it. The host is what
 * says where the page is, and its registrable domain the part a page cannot choose freely, so the
 * bar gives up anything else first: the path, then the host from the left. `login.bank.com.evil.co`
 * clipped from the right would read as the bank.
 */
export interface AddressParts {
  /** The scheme and any subdomains, which clip from the left. */
  lead: string;
  /** The registrable domain, and a port. */
  site: string;
  /** Path, query and fragment, which go first. */
  rest: string;
}

/** Null when the address has no host to name: about:blank, data:. */
export function addressParts(url: string, site: string): AddressParts | null {
  if (!site) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname;
  if (!host) return null;
  const known = host === site || host.endsWith(`.${site}`);
  const domain = known ? site : host;
  const port = u.port ? `:${u.port}` : "";
  return {
    lead: `${u.protocol}//${host.slice(0, host.length - domain.length)}`,
    site: domain + port,
    rest: `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`,
  };
}
