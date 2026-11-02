package fsx

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fuzzy"
)

// File search for the composer's "@" completion and the file finder
// (FilesystemService.SearchFiles).

// Bounds and defaults of file search.
const (
	// MaxWalkEntries bounds the walk of a project without git.
	MaxWalkEntries = 50_000
	// MaxGitFiles bounds the files read from git ls-files.
	MaxGitFiles = 200_000
	// DefaultFileLimit and MaxFileLimit bound one search's matches.
	DefaultFileLimit = 50
	MaxFileLimit     = 200
	// MaxSearchSources bounds the checkouts of one search (below maxCachedCheckouts, so
	// one search never evicts its own lists).
	MaxSearchSources = 16
	// FileCacheTTL is how long a checkout's candidate list is reused.
	FileCacheTTL = 5 * time.Second
	// maxCachedCheckouts bounds the cache; the oldest entry goes first.
	maxCachedCheckouts = 32
)

// gitFilesTimeout bounds one git ls-files.
const gitFilesTimeout = 15 * time.Second

// gitEnv is base without the variables that would point git at another repository
// (a daemon started from a git hook inherits them), plus GIT_OPTIONAL_LOCKS=0 so
// listing never rewrites the index (which would fire the project store's watcher) and
// GIT_TERMINAL_PROMPT=0. The project store's runner does the same for its commands.
func gitEnv(base []string) []string {
	out := make([]string, 0, len(base)+2)
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		switch name {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
			"GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT":
			continue
		}
		out = append(out, kv)
	}
	return append(out, "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
}

// FileEntry is a file or directory of a checkout.
type FileEntry struct {
	// Path is relative to the checkout, "/"-separated, without "./" or a trailing "/".
	Path  string
	IsDir bool
}

// WithParentDirs returns files plus every directory they imply ("a/b/c.go" implies
// "a" and "a/b"), deduplicated, directories first in order of first appearance, then
// the files in their given order. Empty paths and leading "./" are dropped.
func WithParentDirs(files []string) []FileEntry {
	seen := make(map[string]bool, len(files)/4)
	var dirs []FileEntry
	out := make([]FileEntry, 0, len(files))
	for _, f := range files {
		f = strings.TrimPrefix(f, "./")
		f = strings.TrimSuffix(f, "/")
		if f == "" {
			continue
		}
		for i := 0; i < len(f); i++ {
			if f[i] != '/' {
				continue
			}
			d := f[:i]
			if !seen[d] {
				seen[d] = true
				dirs = append(dirs, FileEntry{Path: d, IsDir: true})
			}
		}
		out = append(out, FileEntry{Path: f})
	}
	return append(dirs, out...)
}

// GitFiles lists a git checkout's tracked files and its untracked files that are not
// ignored (git ls-files -co --exclude-standard), with their parent directories. At
// most MaxGitFiles files are read; truncated reports more.
func GitFiles(ctx context.Context, dir string) (entries []FileEntry, truncated bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, gitFilesTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "ls-files", "-co", "--exclude-standard", "-z")
	cmd.Env = gitEnv(os.Environ())
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	outb, err := cmd.Output()
	if err != nil {
		return nil, false, fmt.Errorf("fsx: git ls-files in %s: %w: %s", dir, err, strings.TrimSpace(stderr.String()))
	}
	var files []string
	seen := map[string]bool{} // -co can list a path twice (tracked and deleted-but-present)
	for _, p := range bytes.Split(outb, []byte{0}) {
		if len(p) == 0 {
			continue
		}
		s := string(p)
		if seen[s] {
			continue
		}
		if len(files) == MaxGitFiles {
			truncated = true
			break
		}
		seen[s] = true
		files = append(files, s)
	}
	return WithParentDirs(files), truncated, nil
}

// WalkFiles walks a checkout without git: files and directories, skipping .git,
// node_modules and every directory whose name starts with "." (dotfiles are kept),
// without following symlinks, at most max entries (zero: MaxWalkEntries). Unreadable
// directories are skipped.
func WalkFiles(ctx context.Context, dir string, max int) (entries []FileEntry, truncated bool, err error) {
	max = cmp.Or(max, MaxWalkEntries)
	errFull := errors.New("full")
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if p == dir {
			return err // the root itself must be readable
		}
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		name := d.Name()
		if d.IsDir() && (name == "node_modules" || strings.HasPrefix(name, ".")) {
			return fs.SkipDir
		}
		if len(entries) == max {
			truncated = true
			return errFull
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return nil
		}
		entries = append(entries, FileEntry{Path: filepath.ToSlash(rel), IsDir: d.IsDir()})
		return nil
	})
	if err != nil && !errors.Is(err, errFull) {
		return nil, false, fmt.Errorf("fsx: walk %s: %w", dir, err)
	}
	return entries, truncated, nil
}

// listTimeout bounds one listing (git ls-files, then the walk if git fails). A listing
// runs apart from the request that started it, so it finishes and fills the cache even
// when that request is cancelled (the composer cancels the previous search on each
// keystroke).
const listTimeout = 30 * time.Second

// FileIndex searches checkouts, caching each one's candidate list for TTL so typing
// does not re-run git on every keystroke. Concurrent misses for one checkout share a
// single listing. Safe for concurrent use. The zero value is not ready; use
// NewFileIndex.
type FileIndex struct {
	ttl time.Duration
	now func() time.Time
	log *slog.Logger
	// list produces a checkout's candidates (listFiles; tests replace it).
	list func(ctx context.Context, dir string, git bool) ([]FileEntry, error)

	mu       sync.Mutex
	entries  map[string]cachedFiles
	inflight map[string]*listing
}

type cachedFiles struct {
	key   string
	files []FileEntry
	paths []string // files[i].Path, for fuzzy.RankSources
	// filePaths are the paths of the files alone (no directories); fileIdx[i] is
	// filePaths[i]'s index in files.
	filePaths []string
	fileIdx   []int
	created   time.Time
}

// listing is one in-flight listing of a checkout; c and err are set before done closes.
type listing struct {
	done chan struct{}
	c    cachedFiles
	err  error
}

// NewFileIndex returns an index with FileCacheTTL. A nil log discards.
func NewFileIndex(log *slog.Logger) *FileIndex {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	x := &FileIndex{ttl: FileCacheTTL, now: time.Now, log: log, entries: map[string]cachedFiles{}, inflight: map[string]*listing{}}
	x.list = x.listFiles
	return x
}

// Source is one checkout of a search.
type Source struct {
	// Dir is absolute, symlinks resolved.
	Dir string
	// Git: list git's view (falling back to the walk when git ls-files fails), else walk.
	Git bool
	// Name is the checkout's project name, which query words may match instead of the
	// path when a search has several sources (fuzzy.Splits).
	Name string
}

// Match is one result of SearchSources.
type Match struct {
	FileEntry
	// Source indexes the sources passed to SearchSources.
	Source int
	// PathPositions and NamePositions are the rune indices of Path and of the source's
	// Name that the query matched (fuzzy.Hit).
	PathPositions, NamePositions []int
}

// Search is SearchSources over the one checkout dir.
func (x *FileIndex) Search(ctx context.Context, dir string, git bool, query string, limit int) (matches []FileEntry, truncated bool, err error) {
	ms, truncated, err := x.SearchSources(ctx, []Source{{Dir: dir, Git: git}}, query, limit, false)
	if err != nil {
		return nil, false, err
	}
	matches = make([]FileEntry, len(ms))
	for i, m := range ms {
		matches[i] = m.FileEntry
	}
	return matches, truncated, nil
}

// SearchSources fuzzy-matches query against the files and directories (only the files
// when filesOnly) of every source checkout and ranks them in one list
// (fuzzy.RankSources: best first, ties to the earlier source). limit is clamped to
// [1, MaxFileLimit] with zero meaning DefaultFileLimit. The checkouts are listed
// concurrently. When ctx ends first, SearchSources returns its error at once; the
// listings go on (at most listTimeout) and fill the cache for the next search.
func (x *FileIndex) SearchSources(ctx context.Context, sources []Source, query string, limit int, filesOnly bool) (matches []Match, truncated bool, err error) {
	if limit <= 0 {
		limit = DefaultFileLimit
	}
	limit = min(limit, MaxFileLimit)
	pending := make([]*listing, len(sources))
	for i, src := range sources {
		pending[i] = x.start(ctx, src.Dir, src.Git)
	}
	lists := make([]cachedFiles, len(sources))
	ranked := make([]fuzzy.Source, len(sources))
	for i, l := range pending {
		select {
		case <-l.done:
		case <-ctx.Done():
			return nil, false, ctx.Err()
		}
		if l.err != nil { // with several checkouts, say which one
			return nil, false, fmt.Errorf("list %s: %w", sources[i].Dir, l.err)
		}
		lists[i] = l.c
		ranked[i] = fuzzy.Source{Name: sources[i].Name, Paths: l.c.paths}
		if filesOnly {
			ranked[i].Paths = l.c.filePaths
		}
	}
	hits, truncated := fuzzy.RankSources(ranked, query, limit)
	matches = make([]Match, len(hits))
	for i, h := range hits {
		c, idx := lists[h.Source], h.Index
		if filesOnly {
			idx = c.fileIdx[idx]
		}
		matches[i] = Match{FileEntry: c.files[idx], Source: h.Source, PathPositions: h.PathPositions, NamePositions: h.NamePositions}
	}
	return matches, truncated, nil
}

// start returns the listing of dir: a finished one holding the cached list when it is
// fresh, else the one in flight for it, starting one if there is none.
func (x *FileIndex) start(ctx context.Context, dir string, git bool) *listing {
	key := fmt.Sprintf("%t:%s", git, dir)
	now := x.now()
	x.mu.Lock()
	defer x.mu.Unlock()
	if c, ok := x.entries[key]; ok && now.Sub(c.created) < x.ttl {
		l := &listing{done: make(chan struct{}), c: c}
		close(l.done)
		return l
	}
	l, ok := x.inflight[key]
	if !ok {
		l = &listing{done: make(chan struct{})}
		x.inflight[key] = l
		go x.fill(context.WithoutCancel(ctx), key, dir, git, l)
	}
	return l
}

// fill lists dir, caches the list under key on success, and finishes l.
func (x *FileIndex) fill(ctx context.Context, key, dir string, git bool, l *listing) {
	ctx, cancel := context.WithTimeout(ctx, listTimeout)
	defer cancel()
	files, err := x.list(ctx, dir, git)
	var c cachedFiles
	if err == nil {
		// Stamp the entry when the listing is done: one slower than the TTL (a huge
		// project) would otherwise be cached already expired and re-run on every keystroke.
		now := x.now()
		c = cachedFiles{key: key, files: files, paths: make([]string, len(files)), created: now}
		for i, f := range files {
			c.paths[i] = f.Path
			if !f.IsDir {
				c.filePaths = append(c.filePaths, f.Path)
				c.fileIdx = append(c.fileIdx, i)
			}
		}
	}

	x.mu.Lock()
	delete(x.inflight, key)
	if err == nil {
		for k, e := range x.entries { // drop expired entries; bound the rest
			if c.created.Sub(e.created) >= x.ttl {
				delete(x.entries, k)
			}
		}
		if len(x.entries) >= maxCachedCheckouts {
			oldest := slices.MinFunc(slices.Collect(maps.Values(x.entries)), func(a, b cachedFiles) int {
				return a.created.Compare(b.created)
			})
			delete(x.entries, oldest.key)
		}
		x.entries[key] = c
	}
	x.mu.Unlock()
	l.c, l.err = c, err
	close(l.done)
}

// listFiles lists a checkout's candidates: git's view, else (no git, or git failed)
// the walk.
func (x *FileIndex) listFiles(ctx context.Context, dir string, git bool) ([]FileEntry, error) {
	var files []FileEntry
	var truncated bool
	var err error
	if git {
		files, truncated, err = GitFiles(ctx, dir)
		if err != nil {
			x.log.Debug("git ls-files failed; walking instead", "dir", dir, "err", err)
		}
	}
	if !git || err != nil {
		files, truncated, err = WalkFiles(ctx, dir, MaxWalkEntries)
		if err != nil {
			return nil, err
		}
	}
	if truncated {
		x.log.Info("file search candidates capped", "dir", dir, "entries", len(files))
	}
	return files, nil
}
