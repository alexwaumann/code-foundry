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
// (GetPullRequestDiff, GetPullRequestFile). Both are REST GETs in a custom media type
// through the paced worker, cached in memory only.

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

// PullRequestDiff implements Service. The diff for the pull request's cached head
// commit (FullPullRequest's, from memory or SQLite) is served from memory unless
// refresh is set; a pull request whose head is not cached is always fetched.
func (s *Store) PullRequestDiff(ctx context.Context, slug string, number int, refresh bool) (PullRequestDiff, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return PullRequestDiff{}, err
	}
	var head, base string
	if e, ok := s.cachedFull(ctx, k); ok {
		head, base = e.d.PullRequest.HeadSHA, e.d.PullRequest.BaseSHA
	}
	if d, ok := s.prFiles.diff(k); ok && !refresh && head != "" && d.HeadSHA == head {
		return d, nil
	}
	rr, ok := s.opts.Runner.(RawRESTRunner)
	if !ok {
		return PullRequestDiff{}, errNoRawRunner
	}
	owner, name := splitSlug(k.slug)
	p := "repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name) + "/pulls/" + fmt.Sprint(k.number)
	return submitFunc(ctx, s, "diff|"+k.String(), func(ctx context.Context) (PullRequestDiff, error) {
		res, err := s.restRaw(ctx, rr, p, nil, acceptDiff, PullRequestDiffMax)
		if err != nil {
			return PullRequestDiff{}, err
		}
		body := res.Body
		if res.Truncated { // keep whole lines
			if i := bytes.LastIndexByte(body, '\n'); i >= 0 {
				body = body[:i+1]
			}
		}
		d := PullRequestDiff{Diff: string(body), HeadSHA: head, BaseSHA: base, Truncated: res.Truncated, FetchedAt: s.opts.Now()}
		s.prFiles.putDiff(k, d)
		return d, nil
	})
}

// PullRequestFile implements Service. ref must be a full commit SHA, so a cached
// file never goes stale.
func (s *Store) PullRequestFile(ctx context.Context, slug, ref, filePath string) (PullRequestFile, error) {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return PullRequestFile{}, err
	}
	if !isCommitSHA(ref) {
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
	return submitFunc(ctx, s, "file|"+key+"|"+fk.ref+"|"+clean, func(ctx context.Context) (PullRequestFile, error) {
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

// restRaw sends one paced raw REST GET and applies its global effects (auth state,
// rate-limit and network pauses), like restWrite. Worker goroutine only.
func (s *Store) restRaw(ctx context.Context, rr RawRESTRunner, p string, params map[string]string, accept string, limit int64) (RawResponse, error) {
	if err := s.pace(ctx); err != nil {
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
