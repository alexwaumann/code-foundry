// Package page keeps what the daemon knows about the HTML pages the GUI shows in frames
// with the bridge (docs/notes/page-ownership-daemon.md):
//
//   - who owns each page file: the thread that last showed it (view.inline,
//     view.open.page) or wrote it (Claude's Write, Edit, MultiEdit); latest wins. A file
//     in a thread's pages directory (<home>/pages/<thread id>/) is that thread's unless a
//     later thread showed or wrote it. A removed thread's records go with its threads row
//     (ON DELETE CASCADE), so a page never points at a thread that is gone;
//   - the user's answer for a page no thread owns: allowed or refused, kept per file and
//     never asked again when the file's content changes;
//   - the storage of an allowed page no thread owns (cf.storage without a thread), one
//     file per page, with the limits of a thread's (internal/pagestorage).
//
// Everything is keyed by the file's absolute path with its symlinks resolved. A file the
// preview refuses (Options.Guarded), one outside home and the pages root, and one that is
// not a regular .html or .htm file never gets an owner, an answer or storage.
package page

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/pagestorage"
)

var (
	// ErrInvalidArgument: a path that is not an absolute path to a regular .html or .htm
	// file under home (or the pages root), a bad storage key or value, a full storage.
	ErrInvalidArgument = errors.New("invalid argument")
	// ErrNotFound: no file at the path.
	ErrNotFound = errors.New("not found")
	// ErrGuarded: the file is in a folder the preview never serves.
	ErrGuarded = errors.New("guarded")
	// ErrNotAsked: a page no thread owns that the user has not answered for yet.
	ErrNotAsked = errors.New("not asked")
	// ErrRefused: a page no thread owns that the user did not allow.
	ErrRefused = errors.New("refused")
)

// Consent is the user's answer for a page no thread owns.
type Consent int

const (
	// NotAsked: no answer yet.
	NotAsked Consent = iota
	// Allowed: the user allowed the page the bridge.
	Allowed
	// Refused: the user did not allow it.
	Refused
)

func (c Consent) String() string {
	switch c {
	case Allowed:
		return "allowed"
	case Refused:
		return "refused"
	}
	return "not asked"
}

// How a thread came to own a page.
const (
	// Shown: the thread showed it (view.inline, view.open.page).
	Shown = "shown"
	// Written: the thread's Claude wrote or edited it.
	Written = "written"
)

// Access is what the daemon says about one page file.
type Access struct {
	// Path is the file's absolute path, symlinks resolved: the key of everything here.
	Path string
	// Owner is the owning thread's id: Recorded's, else PagesThread; "" for none.
	Owner string
	// Recorded is the thread recorded as having last shown or written the file, "" for
	// none, and How how ("shown", "written").
	Recorded, How string
	// PagesThread is the thread whose pages directory holds the file, "" for none (or one
	// that no longer exists).
	PagesThread string
	// Consent is the user's answer. It counts only while Owner is "".
	Consent Consent
}

// Allowed reports whether the page may use the bridge: a thread owns it, or the user
// allowed it.
func (a Access) Allowed() bool { return a.Owner != "" || a.Consent == Allowed }

// Options configure a Store.
type Options struct {
	DB *sql.DB
	// Home is the user's home directory (fsx.HomeRoot). Pages are under it.
	Home string
	// PagesRoot holds a pages directory per thread (paths.Paths.Pages).
	PagesRoot string
	// StorageRoot holds the storage of pages no thread owns, a directory per page
	// (paths.Paths.PageFileStorage). Empty: none kept.
	StorageRoot string
	// Guarded reports a path the preview never serves (preview.Grants.Guarded); asked of
	// both the path as given and its resolved one. Nil: none.
	Guarded func(path string) bool
	// ThreadExists reports whether a thread exists (not removed); a pages directory of a
	// thread that does not is no one's. Nil: every one does.
	ThreadExists func(id string) bool
	Log          *slog.Logger
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

// Store keeps pages' owners, the user's answers and the storage of pages no thread owns.
// Safe for concurrent use.
type Store struct {
	o       Options
	homes   []string // Home as given and resolved
	storeMu sync.Mutex
}

// New returns a Store and removes the storage of pages whose file is gone (Sweep).
func New(ctx context.Context, o Options) (*Store, error) {
	if o.DB == nil {
		return nil, errors.New("page: a database is required")
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	s := &Store{o: o, homes: spellings(o.Home)}
	s.Sweep(ctx)
	return s, nil
}

// spellings are p and its resolved path, without repeats; none for "".
func spellings(p string) []string {
	if p == "" {
		return nil
	}
	p = filepath.Clean(p)
	out := []string{p}
	if real, err := filepath.EvalSymlinks(p); err == nil && real != p {
		out = append(out, real)
	}
	return out
}

func within(roots []string, p string) bool {
	for _, r := range roots {
		if fsx.Within(r, p) && p != r {
			return true
		}
	}
	return false
}

// Resolve checks path and returns it with its symlinks resolved: an absolute path to a
// regular .html or .htm file under home or the pages root (both as spelled and resolved),
// not one the preview refuses. ErrInvalidArgument, ErrNotFound or ErrGuarded otherwise.
func (s *Store) Resolve(path string) (string, error) {
	if path == "" || !filepath.IsAbs(path) {
		return "", fmt.Errorf("%w: %q is not an absolute path", ErrInvalidArgument, path)
	}
	path = filepath.Clean(path)
	real, err := filepath.EvalSymlinks(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("%w: no file at %s", ErrNotFound, path)
	}
	if err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrInvalidArgument, path, err)
	}
	switch strings.ToLower(filepath.Ext(real)) {
	case ".html", ".htm":
	default:
		return "", fmt.Errorf("%w: %s is not an .html or .htm file", ErrInvalidArgument, path)
	}
	if s.o.Guarded != nil && (s.o.Guarded(path) || s.o.Guarded(real)) {
		return "", fmt.Errorf("%w: %s is in a protected folder (Code Foundry's own data, credentials or ~/Library)", ErrGuarded, path)
	}
	if !within(s.homes, real) && !within(s.pagesRoots(), real) {
		return "", fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, path)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrInvalidArgument, path, err)
	}
	if !fi.Mode().IsRegular() {
		return "", fmt.Errorf("%w: %s is not a file", ErrInvalidArgument, path)
	}
	return real, nil
}

// pagesRoots is the pages root as given and resolved, resolved at each ask: it is made
// when the first thread writes a page, maybe after New.
func (s *Store) pagesRoots() []string { return spellings(s.o.PagesRoot) }

// pagesThread is the thread whose pages directory holds real: the first directory under
// the pages root. "" for a file anywhere else, one directly in the root (the welcome
// page), and one whose thread does not exist.
func (s *Store) pagesThread(real string) string {
	for _, root := range s.pagesRoots() {
		rel, err := filepath.Rel(root, real)
		if err != nil || !filepath.IsLocal(rel) {
			continue
		}
		id, rest, ok := strings.Cut(filepath.ToSlash(rel), "/")
		if !ok || rest == "" {
			return ""
		}
		if s.o.ThreadExists != nil && !s.o.ThreadExists(id) {
			return ""
		}
		return id
	}
	return ""
}

// Record records thread id as the owner of the page at path, how ("shown", "written"):
// latest wins. A path Resolve refuses is not recorded (its error is returned); so is a
// thread that does not exist (the foreign key refuses it).
func (s *Store) Record(ctx context.Context, id, path, how string) error {
	real, err := s.Resolve(path)
	if err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("%w: no thread", ErrInvalidArgument)
	}
	if _, err := s.o.DB.ExecContext(ctx, `INSERT INTO page_owners (path, thread_id, how, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (path) DO UPDATE SET thread_id = excluded.thread_id, how = excluded.how, updated_at = excluded.updated_at`,
		real, id, how, s.o.Now().UnixMilli()); err != nil {
		return fmt.Errorf("page: record %s as %s's: %w", real, id, err)
	}
	return nil
}

// Access is what the daemon says about the page at path (see Access); Resolve's errors
// for a path it refuses.
func (s *Store) Access(ctx context.Context, path string) (Access, error) {
	real, err := s.Resolve(path)
	if err != nil {
		return Access{}, err
	}
	return s.access(ctx, real)
}

func (s *Store) access(ctx context.Context, real string) (Access, error) {
	a := Access{Path: real, PagesThread: s.pagesThread(real)}
	err := s.o.DB.QueryRowContext(ctx, `SELECT thread_id, how FROM page_owners WHERE path = ?`, real).Scan(&a.Recorded, &a.How)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Access{}, fmt.Errorf("page: owner of %s: %w", real, err)
	}
	if a.Recorded != "" && s.o.ThreadExists != nil && !s.o.ThreadExists(a.Recorded) {
		a.Recorded, a.How = "", "" // removed, its row not yet gone
	}
	a.Owner = a.Recorded
	if a.Owner == "" {
		a.Owner = a.PagesThread
	}
	var allowed sql.NullBool
	err = s.o.DB.QueryRowContext(ctx, `SELECT allowed FROM page_consent WHERE path = ?`, real).Scan(&allowed)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return Access{}, fmt.Errorf("page: consent of %s: %w", real, err)
	case allowed.Bool:
		a.Consent = Allowed
	default:
		a.Consent = Refused
	}
	return a, nil
}

// SetConsent records the user's answer for the page at path, allowed or not, and returns
// its access after. The answer is kept whether or not a thread owns the page now: it
// counts once none does.
func (s *Store) SetConsent(ctx context.Context, path string, allowed bool) (Access, error) {
	real, err := s.Resolve(path)
	if err != nil {
		return Access{}, err
	}
	if _, err := s.o.DB.ExecContext(ctx, `INSERT INTO page_consent (path, allowed, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (path) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at`,
		real, allowed, s.o.Now().UnixMilli()); err != nil {
		return Access{}, fmt.Errorf("page: consent of %s: %w", real, err)
	}
	return s.access(ctx, real)
}

// Allow returns the page's access when it may use the bridge without a thread: a thread
// owns it, or the user allowed it. ErrNotAsked or ErrRefused otherwise, and Resolve's
// errors.
func (s *Store) Allow(ctx context.Context, path string) (Access, error) {
	a, err := s.Access(ctx, path)
	if err != nil {
		return Access{}, err
	}
	switch {
	case a.Allowed():
		return a, nil
	case a.Consent == Refused:
		return Access{}, fmt.Errorf("%w: the user did not allow %s to use Code Foundry", ErrRefused, a.Path)
	}
	return Access{}, fmt.Errorf("%w: the user has not allowed %s to use Code Foundry yet", ErrNotAsked, a.Path)
}

// storageDir is the directory of the page at real's storage: a hash of its path, so any
// path makes a short safe name.
func (s *Store) storageDir(real string) string {
	if s.o.StorageRoot == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(real))
	return filepath.Join(s.o.StorageRoot, hex.EncodeToString(sum[:16]))
}

// pathFile names, in a page's storage directory, the page it is for (Sweep reads it).
const pathFile = "path"

// Storage is what the page at path keeps with cf.storage without a thread: key → the
// value's JSON text. Allow's errors for a page that may not.
func (s *Store) Storage(ctx context.Context, path string) (map[string]string, error) {
	a, err := s.Allow(ctx, path)
	if err != nil {
		return nil, err
	}
	s.storeMu.Lock()
	defer s.storeMu.Unlock()
	vals, err := pagestorage.Read(s.storageDir(a.Path), s.o.Log, "page", a.Path)
	if err != nil {
		return nil, fmt.Errorf("page: storage of %s: %w", a.Path, err)
	}
	return pagestorage.Text(vals), nil
}

// SetStorage sets key to value (JSON text) in the page at path's storage, or removes it
// when value is nil, and returns the storage after. ErrInvalidArgument as a thread's
// page storage refuses (internal/pagestorage), and Allow's errors.
func (s *Store) SetStorage(ctx context.Context, path, key string, value *string) (map[string]string, error) {
	if err := pagestorage.Check(key, value); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidArgument, err)
	}
	a, err := s.Allow(ctx, path)
	if err != nil {
		return nil, err
	}
	dir := s.storageDir(a.Path)
	if dir == "" {
		return nil, fmt.Errorf("%w: this daemon keeps no page storage", ErrInvalidArgument)
	}
	s.storeMu.Lock()
	defer s.storeMu.Unlock()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("page: storage of %s: %w", a.Path, err)
	}
	if err := pagestorage.WriteAtomic(filepath.Join(dir, pathFile), []byte(a.Path)); err != nil {
		return nil, fmt.Errorf("page: storage of %s: %w", a.Path, err)
	}
	vals, err := pagestorage.Set(dir, key, value, "page", s.o.Log, "page", a.Path)
	if errors.Is(err, pagestorage.ErrInvalid) {
		return nil, fmt.Errorf("%w: %w", ErrInvalidArgument, err)
	}
	if err != nil {
		return nil, fmt.Errorf("page: storage of %s: %w", a.Path, err)
	}
	return vals, nil
}

// SweepAfter is how long a page's storage is kept after its last write once its file is
// missing: long enough for a file that is only away (a branch not checked out, a volume
// not mounted) to come back to what it stored.
const SweepAfter = 30 * 24 * time.Hour

// goneLong reports whether the page at real does not exist and its storage in dir was
// last written more than SweepAfter ago (the path file is rewritten with every write).
func (s *Store) goneLong(real, dir string) bool {
	if _, err := os.Stat(real); !errors.Is(err, fs.ErrNotExist) {
		return false
	}
	fi, err := os.Stat(filepath.Join(dir, pathFile))
	return err == nil && s.o.Now().Sub(fi.ModTime()) > SweepAfter
}

// Sweep removes the storage of every page whose file does not exist (deleted or moved; a
// moved page starts empty at its new path) and that was last written more than SweepAfter
// ago, and of a directory that does not say whose it is. A file that cannot be looked at
// (no permission, its volume away) is not known to be gone: its storage stays. Owners and
// answers stay: they are rows, not files, and a file that comes back at its path is the
// same page. New runs it once.
func (s *Store) Sweep(_ context.Context) {
	if s.o.StorageRoot == "" {
		return
	}
	entries, err := os.ReadDir(s.o.StorageRoot)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.o.Log.Warn("read the pages' storage", "dir", s.o.StorageRoot, "err", err)
		}
		return
	}
	s.storeMu.Lock()
	defer s.storeMu.Unlock()
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(s.o.StorageRoot, e.Name())
		b, err := os.ReadFile(filepath.Join(dir, pathFile))
		keep := false
		if err == nil {
			real := string(b)
			keep = filepath.IsAbs(real) && s.storageDir(real) == dir && !s.goneLong(real, dir)
		}
		if keep {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			s.o.Log.Warn("remove a gone page's storage", "dir", dir, "err", err)
		}
	}
}
