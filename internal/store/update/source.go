package update

import (
	"cmp"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// ErrNoRelease means the repository has no published release. A check that gets it is
// successful and finds nothing to install.
var ErrNoRelease = errors.New("no published release")

// Channel is the release channel the updater follows (the update.channel setting).
type Channel string

// Channels. Stable is a release promoted on purpose (a full GitHub release); tip is the
// newest build of main (a prerelease vX.Y.Z-tip.N published on every push).
const (
	ChannelStable Channel = "stable"
	ChannelTip    Channel = "tip"
)

// ParseChannel maps a setting value to a Channel; anything but "tip" is stable.
func ParseChannel(s string) Channel {
	if Channel(s) == ChannelTip {
		return ChannelTip
	}
	return ChannelStable
}

// Source reports the latest release tag of a channel.
type Source interface {
	// Latest returns the tag of the channel's latest release, e.g. "v0.2.0" or
	// "v0.3.0-tip.4", as published (it is validated by the caller). Stable is the
	// newest full release; tip returns the highest semver tag on the newest page of
	// published releases (prerelease or not, falling back to older pages if page 1 has
	// none), so it is never below stable.
	Latest(ctx context.Context, ch Channel) (string, error)
	// NotesURL returns the release page for tag.
	NotesURL(tag string) string
}

// TokenSource resolves an optional GitHub API token (gh.TokenSource satisfies it).
// Errors wrapping gh.ErrNoToken fall back to anonymous requests.
type TokenSource interface {
	Token(ctx context.Context) (string, error)
}

// Defaults for GhSource.
const (
	// DefaultAPIURL is github.com's REST API root.
	DefaultAPIURL = "https://api.github.com"
	// DefaultTokenTTL is how long a resolved token (or absence of one) is reused
	// before consulting Tokens again, avoiding a subprocess on every check.
	DefaultTokenTTL = 15 * time.Minute
	// DefaultTipPageSize is how many releases the tip channel requests per page.
	// GitHub returns releases newest-first, so one page covers recent tips and stables.
	DefaultTipPageSize = 20

	sourceTimeout   = 30 * time.Second
	idleConnTimeout = 25 * time.Second
	maxReleaseBody  = 4 << 20 // 4 MiB
	maxTipPages     = 10
)

type etagEntry struct {
	etag string
	tag  string
}

// GhSource fetches the latest release tag from GitHub's REST API over a persistent
// keep-alive HTTP client with ETag / If-None-Match caching and a cached token provider
// (falling back to anonymous requests when no token is available).
//
// Stable calls GET /repos/<repo>/releases/latest. Tip calls
// GET /repos/<repo>/releases?per_page=<TipPageSize> (sorted newest-first by GitHub)
// and only follows Link rel="next" if a page contains no usable non-draft release.
// Safe for concurrent use; do not copy after first use.
type GhSource struct {
	// Repo is "owner/name".
	Repo string
	// Gh is the gh executable used to resolve a token when Tokens is nil;
	// gh.LookPath() when empty.
	Gh string
	// BaseURL is the GitHub API root without a trailing slash; DefaultAPIURL when empty.
	BaseURL string
	// Tokens resolves an optional GitHub API token; defaults to gh.GhToken{Path: Gh}.
	Tokens TokenSource
	// Client sends HTTP requests; a keep-alive client is created lazily when nil.
	Client *http.Client
	// UserAgent identifies requests to GitHub; "code-foundry" when empty.
	UserAgent string
	// TokenTTL is how long a resolved token is cached; DefaultTokenTTL when zero.
	TokenTTL time.Duration
	// TipPageSize is how many releases to request per page on the tip channel;
	// DefaultTipPageSize when zero.
	TipPageSize int
	// Now is injectable for tests; time.Now when nil.
	Now func() time.Time

	mu       sync.Mutex
	client   *http.Client
	token    string
	tokenAt  time.Time
	hasToken bool
	etags    map[Channel]etagEntry
}

var _ Source = (*GhSource)(nil)

func newHTTPClient() *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConns = 4
	t.MaxIdleConnsPerHost = 2
	t.IdleConnTimeout = idleConnTimeout
	t.TLSHandshakeTimeout = 10 * time.Second
	t.ResponseHeaderTimeout = sourceTimeout
	t.ExpectContinueTimeout = 0
	t.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	t.ForceAttemptHTTP2 = true
	return &http.Client{Transport: t}
}

func (s *GhSource) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *GhSource) baseURL() string {
	return strings.TrimSuffix(cmp.Or(s.BaseURL, DefaultAPIURL), "/")
}

func (s *GhSource) tokenTTL() time.Duration {
	if s.TokenTTL > 0 {
		return s.TokenTTL
	}
	return DefaultTokenTTL
}

func (s *GhSource) tipPageSize() int {
	if s.TipPageSize > 0 {
		return s.TipPageSize
	}
	return DefaultTipPageSize
}

func (s *GhSource) httpClient() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client == nil {
		s.client = newHTTPClient()
	}
	return s.client
}

func (s *GhSource) tokenSource() TokenSource {
	if s.Tokens != nil {
		return s.Tokens
	}
	return gh.GhToken{Path: s.Gh}
}

func (s *GhSource) cachedETag(ch Channel) etagEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.etags[ch]
}

func (s *GhSource) storeETag(ch Channel, etag, tag string) {
	if etag == "" || tag == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.etags == nil {
		s.etags = map[Channel]etagEntry{}
	}
	s.etags[ch] = etagEntry{etag: etag, tag: tag}
}

// resolveToken returns the cached token, or resolves one from tokenSource when none is
// cached, it has aged past TokenTTL, or force is set. ErrNoToken caches an empty token
// so anonymous requests proceed without re-spawning gh on every check.
func (s *GhSource) resolveToken(ctx context.Context, force bool) (string, error) {
	now := s.now()
	ttl := s.tokenTTL()
	s.mu.Lock()
	if !force && s.hasToken && now.Sub(s.tokenAt) < ttl {
		tok := s.token
		s.mu.Unlock()
		return tok, nil
	}
	s.mu.Unlock()

	tok, err := s.tokenSource().Token(ctx)
	if err != nil {
		if errors.Is(err, gh.ErrNoToken) {
			s.mu.Lock()
			s.token, s.tokenAt, s.hasToken = "", s.now(), true
			s.mu.Unlock()
			return "", nil
		}
		return "", err
	}
	s.mu.Lock()
	s.token, s.tokenAt, s.hasToken = tok, s.now(), true
	s.mu.Unlock()
	return tok, nil
}

type httpResponse struct {
	status int
	header http.Header
	body   []byte
}

func (s *GhSource) get(ctx context.Context, what, rawURL, ifNoneMatch string) (httpResponse, error) {
	tok, err := s.resolveToken(ctx, false)
	if err != nil {
		return httpResponse{}, fmt.Errorf("github api %s: %w", what, err)
	}
	res, err := s.send(ctx, what, rawURL, tok, ifNoneMatch)
	if err != nil || res.status != http.StatusUnauthorized || tok == "" {
		return res, err
	}
	// Token was rejected: refresh once, then fall back to anonymous for public repos.
	fresh, err := s.resolveToken(ctx, true)
	if err != nil {
		return httpResponse{}, fmt.Errorf("github api %s: %w", what, err)
	}
	if fresh != "" && fresh != tok {
		retry, rerr := s.send(ctx, what, rawURL, fresh, ifNoneMatch)
		if rerr != nil || retry.status != http.StatusUnauthorized {
			return retry, rerr
		}
		res = retry
	}
	anon, aerr := s.send(ctx, what, rawURL, "", ifNoneMatch)
	if aerr == nil && (anon.status == http.StatusNotModified || (anon.status >= 200 && anon.status < 300)) {
		return anon, nil
	}
	return res, nil
}

func (s *GhSource) send(ctx context.Context, what, rawURL, tok, ifNoneMatch string) (httpResponse, error) {
	cctx, cancel := context.WithTimeout(ctx, sourceTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return httpResponse{}, fmt.Errorf("github api %s: build request: %w", what, err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", cmp.Or(s.UserAgent, "code-foundry"))
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	resp, err := s.httpClient().Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return httpResponse{}, fmt.Errorf("github api %s: %w", what, ctxErr)
		}
		if cctxErr := cctx.Err(); cctxErr != nil {
			return httpResponse{}, fmt.Errorf("github api %s: %w", what, cctxErr)
		}
		return httpResponse{}, fmt.Errorf("github api repos/%s/%s: %w", s.Repo, what, err)
	}
	body, rerr := io.ReadAll(io.LimitReader(resp.Body, maxReleaseBody))
	resp.Body.Close()
	if rerr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return httpResponse{}, fmt.Errorf("github api %s: %w", what, ctxErr)
		}
		return httpResponse{}, fmt.Errorf("github api repos/%s/%s: read body: %w", s.Repo, what, rerr)
	}
	return httpResponse{status: resp.StatusCode, header: resp.Header, body: body}, nil
}

type releaseJSON struct {
	TagName string `json:"tag_name"`
	Draft   bool   `json:"draft"`
}

// Latest implements Source.
func (s *GhSource) Latest(ctx context.Context, ch Channel) (string, error) {
	if ch == ChannelTip {
		return s.latestTip(ctx)
	}
	return s.latestStable(ctx)
}

func (s *GhSource) latestStable(ctx context.Context) (string, error) {
	cached := s.cachedETag(ChannelStable)
	u := s.baseURL() + "/repos/" + s.Repo + "/releases/latest"
	res, err := s.get(ctx, "releases/latest", u, cached.etag)
	if err != nil {
		return "", err
	}
	if res.status == http.StatusNotModified && cached.tag != "" {
		return cached.tag, nil
	}
	if res.status == http.StatusNotFound {
		return "", fmt.Errorf("%w in %s (or no access)", ErrNoRelease, s.Repo)
	}
	if res.status < 200 || res.status >= 300 {
		return "", fmt.Errorf("github api repos/%s/releases/latest: %s", s.Repo, httpErrorMessage(res.status, res.body))
	}
	var rel releaseJSON
	if err := json.Unmarshal(res.body, &rel); err != nil {
		return "", fmt.Errorf("github api repos/%s/releases/latest: decode: %w", s.Repo, err)
	}
	tag := strings.TrimSpace(rel.TagName)
	if tag == "" {
		return "", fmt.Errorf("%w in %s", ErrNoRelease, s.Repo)
	}
	s.storeETag(ChannelStable, res.header.Get("ETag"), tag)
	return tag, nil
}

func (s *GhSource) latestTip(ctx context.Context) (string, error) {
	cached := s.cachedETag(ChannelTip)
	base := s.baseURL()
	nextURL := base + "/repos/" + s.Repo + "/releases?per_page=" + strconv.Itoa(s.tipPageSize())

	var page1ETag string
	for page := range maxTipPages {
		ifNoneMatch := ""
		if page == 0 {
			ifNoneMatch = cached.etag
		}
		res, err := s.get(ctx, "releases", nextURL, ifNoneMatch)
		if err != nil {
			return "", err
		}
		if page == 0 && res.status == http.StatusNotModified && cached.tag != "" {
			return cached.tag, nil
		}
		if res.status == http.StatusNotFound {
			return "", fmt.Errorf("%w in %s (or no access)", ErrNoRelease, s.Repo)
		}
		if res.status < 200 || res.status >= 300 {
			return "", fmt.Errorf("github api repos/%s/releases: %s", s.Repo, httpErrorMessage(res.status, res.body))
		}
		if page == 0 {
			page1ETag = res.header.Get("ETag")
		}
		var rels []releaseJSON
		if err := json.Unmarshal(res.body, &rels); err != nil {
			return "", fmt.Errorf("github api repos/%s/releases: decode: %w", s.Repo, err)
		}
		tags := make([]string, 0, len(rels))
		for _, r := range rels {
			if !r.Draft && r.TagName != "" {
				tags = append(tags, r.TagName)
			}
		}
		if tag, ok := HighestTag(tags); ok {
			// Only cache page 1's ETag when page 1 produced the winning tag; a tag from
			// a later page could become stale even if page 1 returns 304 Not Modified.
			if page == 0 {
				s.storeETag(ChannelTip, page1ETag, tag)
			}
			return tag, nil
		}
		nextURL = nextPageURL(res.header.Get("Link"), base)
		if nextURL == "" {
			break
		}
	}
	return "", fmt.Errorf("%w in %s", ErrNoRelease, s.Repo)
}

// nextPageURL extracts the rel="next" URL from an RFC 8288 Link header, returning ""
// unless it has the same scheme and host as baseURL.
func nextPageURL(linkHeader, baseURL string) string {
	if linkHeader == "" {
		return ""
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return ""
	}
	for part := range strings.SplitSeq(linkHeader, ",") {
		segs := strings.Split(strings.TrimSpace(part), ";")
		if len(segs) < 2 {
			continue
		}
		isNext := false
		for _, p := range segs[1:] {
			if strings.TrimSpace(p) == `rel="next"` {
				isNext = true
				break
			}
		}
		if !isNext {
			continue
		}
		raw := strings.TrimSpace(segs[0])
		if !strings.HasPrefix(raw, "<") || !strings.HasSuffix(raw, ">") {
			continue
		}
		raw = raw[1 : len(raw)-1]
		u, err := url.Parse(raw)
		if err != nil || !strings.EqualFold(u.Scheme, base.Scheme) || !strings.EqualFold(u.Host, base.Host) {
			continue
		}
		return u.String()
	}
	return ""
}

func httpErrorMessage(status int, body []byte) string {
	var env struct {
		Message string `json:"message"`
	}
	msg := ""
	if json.Unmarshal(body, &env) == nil {
		msg = firstLine(env.Message)
	}
	if msg == "" {
		msg = http.StatusText(status)
	}
	return fmt.Sprintf("%s (HTTP %d)", msg, status)
}

// HighestTag returns the highest version among tags by semver precedence, skipping
// tags that are not versions. ok is false when none is.
func HighestTag(tags []string) (tag string, ok bool) {
	var best Version
	for _, t := range tags {
		v, err := ParseVersion(t)
		if err != nil {
			continue
		}
		if !ok || v.Compare(best) > 0 {
			tag, best, ok = t, v, true
		}
	}
	return tag, ok
}

// NotesURL implements Source.
func (s *GhSource) NotesURL(tag string) string {
	return "https://github.com/" + s.Repo + "/releases/tag/" + tag
}

// DirSource reads a local release directory (see version.EnvReleaseDir): the latest
// stable tag is the content of <Dir>/latest, the latest tip tag that of
// <Dir>/latest-tip (scripts/release.sh --local writes both). Like GhSource (and
// install.sh --channel tip), tip is the higher semver of the two, so a stable promoted
// after the last tip wins; a missing file is skipped, and only a directory with
// neither has no tip release.
type DirSource struct {
	Dir string
}

// Latest implements Source.
func (s DirSource) Latest(_ context.Context, ch Channel) (string, error) {
	if ch != ChannelTip {
		return s.read("latest")
	}
	tip, tipErr := s.read("latest-tip")
	stable, stableErr := s.read("latest")
	switch {
	case tipErr != nil && !errors.Is(tipErr, ErrNoRelease):
		return "", tipErr
	case stableErr != nil && !errors.Is(stableErr, ErrNoRelease):
		return "", stableErr
	case tipErr != nil && stableErr != nil:
		return "", fmt.Errorf("%w in %s (no latest-tip or latest)", ErrNoRelease, s.Dir)
	case tipErr != nil:
		return stable, nil
	case stableErr != nil:
		return tip, nil
	}
	if Newer(stable, tip) {
		return stable, nil
	}
	return tip, nil
}

// read returns the tag in <Dir>/name; ErrNoRelease when the file does not exist.
func (s DirSource) read(name string) (string, error) {
	b, err := os.ReadFile(filepath.Join(s.Dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("%w in %s (no %s)", ErrNoRelease, s.Dir, name)
	}
	if err != nil {
		return "", fmt.Errorf("read %s: %w", name, err)
	}
	return strings.TrimSpace(string(b)), nil
}

// NotesURL implements Source.
func (s DirSource) NotesURL(tag string) string {
	return "file://" + filepath.Join(s.Dir, tag) + "/"
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(line)
}
