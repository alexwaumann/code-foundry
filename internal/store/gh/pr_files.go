package gh

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// A pull request's diff and its files at a commit, for the file viewer's PR scope
// (GetPullRequestDiff, GetPullRequestFile). Served from local git clones via
// Options.LocalGit when the required objects are present locally, then (for diffs) from
// the bounded SQLite cache (gh_pr_diffs), and otherwise fetched via REST GETs in a custom
// media type through the paced worker.

// LocalGitProvider serves pull request diffs and commit files from locally cloned
// repositories when the required git objects are present on disk. When ok is false
// (repository not registered locally, missing commits, shallow boundary, partial clone
// missing objects, etc.), Store falls back seamlessly to SQLite and GitHub REST.
type LocalGitProvider interface {
	LocalPRDiff(ctx context.Context, slug, baseSHA, headSHA string, maxBytes int) (diff []byte, truncated bool, ok bool)
	LocalPRFile(ctx context.Context, slug, commitSHA, filePath string, maxBytes int) (contents []byte, truncated, binary, notFound, ok bool)
}

const (
	// PullRequestDiffMax caps GetPullRequestDiff's text.
	PullRequestDiffMax = 4 << 20
	// PullRequestFileMax caps GetPullRequestFile's contents.
	PullRequestFileMax = 1 << 20
	// diffCacheMax bounds the diffs kept (one per pull request).
	diffCacheMax = 16
	// fileCacheMax and fileCacheBytes bound the files kept.
	fileCacheMax   = 128
	fileCacheBytes = 16 << 20

	acceptDiff = "application/vnd.github.v3.diff"
	acceptRaw  = "application/vnd.github.raw+json"
)

// PullRequestDiff is a pull request's unified diff.
type PullRequestDiff struct {
	Diff string
	// HeadSHA and BaseSHA are the cached pull request's when the diff was fetched
	// (empty when it was not cached).
	HeadSHA, BaseSHA string
	Truncated        bool
	FetchedAt        time.Time
}

// PullRequestFile is one file at a commit.
type PullRequestFile struct {
	Contents  []byte
	Truncated bool
	Binary    bool
	NotFound  bool
}

// prFilesCache holds diffs per pull request and files per (repository, commit, path).
// Zero value is ready.
type prFilesCache struct {
	mu        sync.Mutex
	diffs     map[fullKey]PullRequestDiff
	diffOrder []fullKey // least recently fetched first
	files     map[fileKey]PullRequestFile
	fileOrder []fileKey // least recently used first
	fileBytes int
}

type fileKey struct{ slug, ref, path string }

// PullRequestDiff implements Service. The diff for the pull request's cached head and
// base commits (from FullPullRequest or polled summary) is served from memory unless
// refresh is set; on a memory miss (with !refresh), local git is tried first, then the
// bounded SQLite cache (gh_pr_diffs), and finally GitHub REST (which persists to SQLite).
// A pull request whose head is not cached is always fetched from GitHub.
func (s *Store) PullRequestDiff(ctx context.Context, slug string, number int, refresh bool) (PullRequestDiff, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return PullRequestDiff{}, err
	}
	var head, base string
	if e, ok := s.cachedFull(ctx, k); ok {
		head, base = e.d.PullRequest.HeadSHA, e.d.PullRequest.BaseSHA
	}
	if head == "" || base == "" {
		if p, ok := s.summaries.get(k); ok && p.HeadSHA != "" {
			if head == "" {
				head, base = p.HeadSHA, p.BaseSHA
			} else if p.HeadSHA == head && base == "" {
				base = p.BaseSHA
			}
		}
	}
	if !refresh && head != "" {
		if d, ok := s.prFiles.diff(k); ok && d.HeadSHA == head && d.BaseSHA == base {
			return d, nil
		}
		if s.opts.LocalGit != nil && IsCommitSHA(base) && IsCommitSHA(head) {
			localSlug := s.localRepoSlug(k.slug)
			if diff, truncated, ok := s.opts.LocalGit.LocalPRDiff(ctx, localSlug, strings.ToLower(base), strings.ToLower(head), PullRequestDiffMax); ok {
				body := trimDiffLines(diff, truncated)
				d := PullRequestDiff{Diff: string(body), HeadSHA: head, BaseSHA: base, Truncated: truncated, FetchedAt: s.opts.Now()}
				s.prFiles.putDiff(k, d)
				return d, nil
			}
			if err := ctx.Err(); err != nil {
				return PullRequestDiff{}, err
			}
		}
		if row, found, err := s.cache.loadPRDiff(ctx, k.slug, k.number); err != nil {
			s.log.Warn("gh diff cache read failed", "slug", k.slug, "number", k.number, "err", err)
		} else if found && row.HeadSHA == head && row.BaseSHA == base {
			s.prFiles.putDiff(k, row)
			return row, nil
		}
	}
	rr, ok := s.opts.Runner.(RawRESTRunner)
	if !ok {
		return PullRequestDiff{}, errNoRawRunner
	}
	owner, name := splitSlug(k.slug)
	p := "repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name) + "/pulls/" + fmt.Sprint(k.number)
	return submitRead(ctx, s, "diff|"+k.String(), func(ctx context.Context) (PullRequestDiff, error) {
		res, err := s.restRaw(ctx, rr, p, nil, acceptDiff, PullRequestDiffMax)
		if err != nil {
			return PullRequestDiff{}, err
		}
		body := trimDiffLines(res.Body, res.Truncated)
		d := PullRequestDiff{Diff: string(body), HeadSHA: head, BaseSHA: base, Truncated: res.Truncated, FetchedAt: s.opts.Now()}
		s.prFiles.putDiff(k, d)
		if head != "" {
			if err := s.cache.savePRDiff(ctx, k.slug, k.number, d); err != nil {
				s.log.Warn("gh diff cache write failed", "slug", k.slug, "number", k.number, "err", err)
			}
		}
		return d, nil
	})
}

// PullRequestFile implements Service. ref must be a full commit SHA, so a cached
// file never goes stale. Local git is tried before GitHub REST when Options.LocalGit is
// configured.
func (s *Store) PullRequestFile(ctx context.Context, slug, ref, filePath string) (PullRequestFile, error) {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return PullRequestFile{}, err
	}
	if !IsCommitSHA(ref) {
		return PullRequestFile{}, fmt.Errorf("%w: ref %q is not a full commit SHA", ErrInvalidArgument, ref)
	}
	clean := path.Clean(filePath)
	if filePath == "" || strings.HasPrefix(clean, "/") || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return PullRequestFile{}, fmt.Errorf("%w: path %q must be repository-relative", ErrInvalidArgument, filePath)
	}
	fk := fileKey{slug: key, ref: strings.ToLower(ref), path: clean}
	if f, ok := s.prFiles.file(fk); ok {
		return f, nil
	}
	if s.opts.LocalGit != nil {
		localSlug := s.localRepoSlug(key)
		if contents, truncated, binary, notFound, ok := s.opts.LocalGit.LocalPRFile(ctx, localSlug, fk.ref, clean, PullRequestFileMax); ok {
			f := PullRequestFile{Contents: contents, Truncated: truncated, Binary: binary, NotFound: notFound}
			s.prFiles.putFile(fk, f)
			return f, nil
		}
		if err := ctx.Err(); err != nil {
			return PullRequestFile{}, err
		}
	}
	rr, ok := s.opts.Runner.(RawRESTRunner)
	if !ok {
		return PullRequestFile{}, errNoRawRunner
	}
	owner, name := splitSlug(key)
	segs := strings.Split(clean, "/")
	for i, sg := range segs {
		segs[i] = url.PathEscape(sg)
	}
	p := "repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name) + "/contents/" + strings.Join(segs, "/")
	return submitRead(ctx, s, "file|"+key+"|"+fk.ref+"|"+clean, func(ctx context.Context) (PullRequestFile, error) {
		res, err := s.restRaw(ctx, rr, p, map[string]string{"ref": fk.ref}, acceptRaw, PullRequestFileMax)
		var f PullRequestFile
		switch {
		case errors.Is(err, ErrNotFound):
			f.NotFound = true
		case err != nil:
			return PullRequestFile{}, err
		case strings.HasPrefix(res.ContentType, "application/json"):
			// A directory's listing, or a submodule's description: not a file.
			f.NotFound = true
		default:
			f = PullRequestFile{Contents: res.Body, Truncated: res.Truncated, Binary: fsx.LooksBinary(res.Body)}
		}
		s.prFiles.putFile(fk, f)
		return f, nil
	})
}

func (s *Store) localRepoSlug(slug string) string {
	if snap := s.Snapshot(); snap != nil {
		return snap.LocalRepo(slug)
	}
	return slug
}

func trimDiffLines(body []byte, truncated bool) []byte {
	if truncated { // keep whole lines
		if i := bytes.LastIndexByte(body, '\n'); i >= 0 {
			body = body[:i+1]
		}
	}
	return body
}

// restRaw sends one paced raw REST GET and applies its global effects (auth state,
// rate-limit and network pauses), like restWrite. Worker goroutine only.
func (s *Store) restRaw(ctx context.Context, rr RawRESTRunner, p string, params map[string]string, accept string, limit int64) (RawResponse, error) {
	if err := s.admit(ctx, true); err != nil {
		return RawResponse{}, err
	}
	start := s.opts.Now()
	res, err := rr.RESTRaw(ctx, p, params, accept, limit)
	s.lastEnd = s.opts.Now()
	s.log.Debug("gh request", "rest", p, "accept", accept, "bytes", len(res.Body), "truncated", res.Truncated,
		"dur", s.lastEnd.Sub(start).Round(time.Millisecond).String(), "err", err)
	s.noteResult(ctx, err, nil)
	return res, err
}

func (c *prFilesCache) diff(k fullKey) (PullRequestDiff, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	d, ok := c.diffs[k]
	return d, ok
}

func (c *prFilesCache) putDiff(k fullKey, d PullRequestDiff) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.diffs == nil {
		c.diffs = map[fullKey]PullRequestDiff{}
	}
	c.diffs[k] = d
	c.diffOrder = append(removeKey(c.diffOrder, k), k)
	for len(c.diffOrder) > diffCacheMax {
		delete(c.diffs, c.diffOrder[0])
		c.diffOrder = c.diffOrder[1:]
	}
}

func (c *prFilesCache) file(k fileKey) (PullRequestFile, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	f, ok := c.files[k]
	if ok {
		c.fileOrder = append(removeKey(c.fileOrder, k), k)
	}
	return f, ok
}

func (c *prFilesCache) putFile(k fileKey, f PullRequestFile) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.files == nil {
		c.files = map[fileKey]PullRequestFile{}
	}
	if old, ok := c.files[k]; ok {
		c.fileBytes -= len(old.Contents)
	}
	c.files[k] = f
	c.fileBytes += len(f.Contents)
	c.fileOrder = append(removeKey(c.fileOrder, k), k)
	for len(c.fileOrder) > 1 && (len(c.fileOrder) > fileCacheMax || c.fileBytes > fileCacheBytes) {
		c.fileBytes -= len(c.files[c.fileOrder[0]].Contents)
		delete(c.files, c.fileOrder[0])
		c.fileOrder = c.fileOrder[1:]
	}
}

func removeKey[K comparable](s []K, k K) []K {
	for i, v := range s {
		if v == k {
			return append(s[:i], s[i+1:]...)
		}
	}
	return s
}
