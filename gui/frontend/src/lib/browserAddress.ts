/**
 * The page's address as the Browser tab's bar shows it while nobody edits it. Who the page is comes
 * from Chrome's origin, never from reading the address: a path of `/%zz` or a host with `{` in it
 * are things a URL parser refuses and Chrome does not, and an address that says about:blank can be
 * another site's page. The registrable domain is the part a page cannot choose freely, so the bar
 * gives up anything else first: the path, then the host from the left.
 * `login.bank.com.evil.co` clipped from the right would read as the bank.
 */
export interface AddressParts {
  /** The scheme and any subdomains, which clip from the left. */
  lead: string;
  /** The registrable domain, and a port. */
  site: string;
  /** Path, query and fragment, or an address the origin is not at the front of. These go first. */
  rest: string;
  /** Nobody can say who this page is, and `site` says so. */
  unknown: boolean;
}

/** What the bar says of a page with no origin to name: a data: page, a sandbox. */
export const UNKNOWN_SITE = "Unknown site";

/** Null only with no address at all. Every page has a site in the bar, or says it cannot tell. */
export function addressParts(url: string, origin: string, site: string): AddressParts | null {
  if (!url) return null;
  if (!origin) return { lead: "", site: UNKNOWN_SITE, rest: ` ${url}`, unknown: true };
  const head = origin.indexOf("://") + 3;
  const port = /:\d+$/.exec(origin)?.[0] ?? "";
  const host = origin.slice(head, origin.length - port.length);
  const known = site !== "" && (host === site || host.endsWith(`.${site}`));
  const domain = known ? site : host;
  const here = url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`) || url.startsWith(`${origin}#`);
  const rest = here ? url.slice(origin.length) : ` ${url}`;
  return {
    lead: origin.slice(0, head) + host.slice(0, host.length - domain.length),
    site: domain + port,
    rest: rest === "/" ? "" : rest,
    unknown: false,
  };
}
