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

// File search for the composer's "@" completion (FilesystemService.SearchFiles).

// Bounds and defaults of file search.
const (
	// MaxWalkEntries bounds the walk of a project without git.
	MaxWalkEntries = 50_000
	// MaxGitFiles bounds the files read from git ls-files.
	MaxGitFiles = 200_000
	// DefaultFileLimit and MaxFileLimit bound one search's matches.
	DefaultFileLimit = 50
	MaxFileLimit     = 200
	// FileCacheTTL is how long a checkout's candidate list is reused.
	FileCacheTTL = 5 * time.Second
	// maxCachedCheckouts bounds the cache; the oldest entry goes first.
	maxCachedCheckouts = 32
)

// gitFilesTimeout bounds one git ls-files.
const gitFilesTimeout = 15 * time.Second

// gitEnv is base without the variables that would point git at another repository
// (a daemon started from a git hook inherits them), plus GIT_OPTIONAL_LOCKS=0 so
// listing never rewrites the index (which would fire the repo store's watcher) and
// GIT_TERMINAL_PROMPT=0. The repo store's runner does the same for its commands.
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

// FileIndex searches checkouts, caching each one's candidate list for TTL so typing
// does not re-run git on every keystroke. Safe for concurrent use. The zero value is
// not ready; use NewFileIndex.
type FileIndex struct {
	ttl time.Duration
	now func() time.Time
	log *slog.Logger

	mu      sync.Mutex
	entries map[string]cachedFiles
}

type cachedFiles struct {
	key     string
	files   []FileEntry
	paths   []string // files[i].Path, for fuzzy.Rank
	created time.Time
}

// NewFileIndex returns an index with FileCacheTTL. A nil log discards.
func NewFileIndex(log *slog.Logger) *FileIndex {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &FileIndex{ttl: FileCacheTTL, now: time.Now, log: log, entries: map[string]cachedFiles{}}
}

// Search fuzzy-matches query against the files and directories of the checkout dir
// (absolute, symlinks resolved): git's view when git is true, else a bounded walk.
// When git ls-files fails (say .git is broken) the walk is used. limit is clamped to
// [1, MaxFileLimit] with zero meaning DefaultFileLimit.
func (x *FileIndex) Search(ctx context.Context, dir string, git bool, query string, limit int) (matches []FileEntry, truncated bool, err error) {
	if limit <= 0 {
		limit = DefaultFileLimit
	}
	limit = min(limit, MaxFileLimit)
	c, err := x.candidates(ctx, dir, git)
	if err != nil {
		return nil, false, err
	}
	ranked, truncated := fuzzy.Rank(c.paths, strings.TrimSpace(query), limit)
	matches = make([]FileEntry, len(ranked))
	for i, r := range ranked {
		matches[i] = c.files[r.Index]
	}
	return matches, truncated, nil
}

func (x *FileIndex) candidates(ctx context.Context, dir string, git bool) (cachedFiles, error) {
	key := fmt.Sprintf("%t:%s", git, dir)
	now := x.now()
	x.mu.Lock()
	c, ok := x.entries[key]
	x.mu.Unlock()
	if ok && now.Sub(c.created) < x.ttl {
		return c, nil
	}

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
			return cachedFiles{}, err
		}
	}
	if truncated {
		x.log.Info("file search candidates capped", "dir", dir, "entries", len(files))
	}
	// Stamp the entry when the listing is done: one slower than the TTL (a huge repo)
	// would otherwise be cached already expired and re-run on every keystroke.
	now = x.now()
	c = cachedFiles{key: key, files: files, paths: make([]string, len(files)), created: now}
	for i, f := range files {
		c.paths[i] = f.Path
	}

	x.mu.Lock()
	defer x.mu.Unlock()
	for k, e := range x.entries { // drop expired entries; bound the rest
		if now.Sub(e.created) >= x.ttl {
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
	return c, nil
}
