package gh

import (
	"fmt"
	"net/url"
	"strings"
)

// ParseRepoRef reads a github.com repository reference: "owner/name", or an
// https://github.com/owner/name URL with an optional ".git", trailing slash, or further
// path (a browser URL such as .../tree/main). "github.com/owner/name" without a scheme
// is a URL too. SSH URLs, http://, and other hosts are refused with a message saying
// what is accepted; every error wraps ErrInvalidArgument. owner and name keep their
// case. gui/frontend/src/lib/githubRef.ts applies the same rules in the dialog.
func ParseRepoRef(ref string) (owner, name string, err error) {
	s := strings.TrimSpace(ref)
	invalid := func(format string, a ...any) (string, string, error) {
		return "", "", fmt.Errorf("%w: %s", ErrInvalidArgument, fmt.Sprintf(format, a...))
	}
	const want = "use owner/repo or https://github.com/owner/repo"
	switch {
	case s == "":
		return invalid("no repository given; %s", want)
	case strings.HasPrefix(s, "git@") || strings.HasPrefix(strings.ToLower(s), "ssh://"):
		return invalid("SSH URLs are not supported; %s", want)
	}
	var segs []string
	if scheme, rest, ok := strings.Cut(s, "://"); ok {
		if !strings.EqualFold(scheme, "https") {
			return invalid("only https:// URLs are supported; %s", want)
		}
		u, perr := url.Parse("https://" + rest)
		if perr != nil {
			return invalid("not a URL: %q", s)
		}
		if !isGitHubHost(u.Host) {
			return invalid("only github.com repositories are supported, not %s", u.Host)
		}
		segs = pathSegments(u.Path)
	} else {
		segs = pathSegments(s)
		if len(segs) > 0 && strings.Contains(segs[0], ".") {
			// "github.com/owner/name": a URL without its scheme.
			if !isGitHubHost(segs[0]) {
				return invalid("only github.com repositories are supported, not %s", segs[0])
			}
			segs = segs[1:]
		} else if len(segs) != 2 || strings.ContainsAny(s, " \t") {
			return invalid("%q is not owner/repo; %s", s, want)
		}
	}
	if len(segs) < 2 {
		return invalid("%q does not name a repository; %s", s, want)
	}
	owner, name = segs[0], strings.TrimSuffix(segs[1], ".git")
	if _, err := NormalizeSlug(owner + "/" + name); err != nil {
		return invalid("%q is not a valid owner/repo", owner+"/"+name)
	}
	return owner, name, nil
}

func isGitHubHost(host string) bool {
	h := strings.ToLower(host)
	return h == "github.com" || h == "www.github.com"
}

// pathSegments splits a path on "/" and drops empty segments (leading, trailing and
// doubled slashes), and a query or fragment.
func pathSegments(p string) []string {
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	var out []string
	for seg := range strings.SplitSeq(p, "/") {
		if seg != "" {
			out = append(out, seg)
		}
	}
	return out
}
