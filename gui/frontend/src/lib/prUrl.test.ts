import { describe, expect, it } from "vitest";
import { parsePullRequestUrl, type PullRequestUrl } from "./prUrl";

const pr = (slug: string, number: number): PullRequestUrl => ({ slug, number });

describe("parsePullRequestUrl", () => {
  const cases: [string, PullRequestUrl | null][] = [
    // The page and its tabs.
    ["https://github.com/owner/repo/pull/12", pr("owner/repo", 12)],
    ["https://github.com/owner/repo/pull/12/", pr("owner/repo", 12)],
    ["https://github.com/owner/repo/pull/12/files", pr("owner/repo", 12)],
    ["https://github.com/owner/repo/pull/12/files/", pr("owner/repo", 12)],
    ["https://github.com/owner/repo/pull/12/commits", pr("owner/repo", 12)],
    ["https://github.com/owner/repo/pull/12/checks", pr("owner/repo", 12)],
    ["https://github.com/owner/repo/pull/12/changes", pr("owner/repo", 12)],
    // Query and fragment.
    ["https://github.com/owner/repo/pull/12#discussion_r123", pr("owner/repo", 12)],
    ["https://github.com/owner/repo/pull/12#issuecomment-456789", pr("owner/repo", 12)],
    ["https://github.com/owner/repo/pull/12/files?w=1#diff-abc", pr("owner/repo", 12)],
    ["https://github.com/owner/repo/pull/12?notification_referrer_id=x", pr("owner/repo", 12)],
    // Hosts, schemes and the slug's case (kept as written).
    ["https://www.github.com/owner/repo/pull/3", pr("owner/repo", 3)],
    ["HTTPS://GitHub.COM/Octo-Org/Hello.World/pull/3", pr("Octo-Org/Hello.World", 3)],
    ["http://github.com/owner/repo/pull/3", pr("owner/repo", 3)],
    ["https://github.com/a/b_c-d.e/pull/9999999", pr("a/b_c-d.e", 9999999)],
    // Other GitHub pages.
    ["https://github.com/owner/repo/issues/12", null],
    ["https://github.com/owner/repo/commit/abc123", null],
    ["https://github.com/owner/repo/compare/main...feature", null],
    ["https://github.com/owner/repo/pulls", null],
    ["https://github.com/owner/repo/pull", null],
    ["https://github.com/owner/repo/pull/", null],
    ["https://github.com/owner/repo", null],
    ["https://github.com/owner/repo/pull/12/files/abc", null],
    ["https://github.com/owner/repo/pull/12/merge", null],
    ["https://github.com/owner/repo/pull/12/commits/abc123", null],
    ["https://github.com/pull/12", null],
    // Malformed numbers.
    ["https://github.com/owner/repo/pull/0", null],
    ["https://github.com/owner/repo/pull/012", null],
    ["https://github.com/owner/repo/pull/-1", null],
    ["https://github.com/owner/repo/pull/1.5", null],
    ["https://github.com/owner/repo/pull/12abc", null],
    ["https://github.com/owner/repo/pull/99999999999", null],
    // Owners and names GitHub would not accept.
    ["https://github.com/-owner/repo/pull/1", null],
    ["https://github.com/own_er/repo/pull/1", null],
    ["https://github.com/owner/re%20po/pull/1", null],
    ["https://github.com/owner/../pull/1", null],
    [`https://github.com/${"a".repeat(40)}/repo/pull/1`, null],
    // Other hosts, schemes, ports and credentials.
    ["https://gitlab.com/owner/repo/pull/1", null],
    ["https://github.com.evil.example/owner/repo/pull/1", null],
    ["https://gist.github.com/owner/repo/pull/1", null],
    ["https://api.github.com/owner/repo/pull/1", null],
    ["https://github.com:8443/owner/repo/pull/1", null],
    ["https://user@github.com/owner/repo/pull/1", null],
    ["ftp://github.com/owner/repo/pull/1", null],
    ["javascript:alert(1)//github.com/owner/repo/pull/1", null],
    // Not a URL.
    ["github.com/owner/repo/pull/1", null],
    ["owner/repo#1", null],
    ["", null],
  ];
  it.each(cases)("%s", (url, want) => {
    expect(parsePullRequestUrl(url)).toEqual(want);
  });
});
