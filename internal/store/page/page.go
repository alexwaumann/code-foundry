// Package page keeps what the daemon knows about the HTML pages the GUI shows in frames
// with the bridge (docs/notes/page-ownership-daemon.md, page-storage-per-file.md):
//
//   - who owns each page file: every thread that showed it (view.inline, view.open.page)
//     or wrote it (Claude's Write, Edit, MultiEdit), and the thread whose pages directory
//     (<home>/pages/<thread id>/) holds it. The first owner (that thread, else the one that
//     first showed or wrote the file) is the page's default, stable while it exists. A
//     removed thread's claims go with its threads row (ON DELETE CASCADE): the page keeps
//     its other owners, and is no thread's only once none is left;
//   - the user's answer for a page no thread owns: allowed or refused, kept per file and
//     never asked again when the file's content changes;
//   - every page's storage (cf.storage), one file per page whichever thread the page acts
//     for and whether or not a thread owns it (internal/pagestorage), carried over once
//     from the threads' own storage of before (carry.go).
//
// Everything is keyed by the file's absolute path with its symlinks resolved, spelled as
// its volume stores it (fsx.OnDiskPath): APFS ignores case and Unicode normalisation, so
// …/case/report.html and an NFC spelling of a folder Finder named NFD are one page. A row
// or a storage directory kept under another spelling of the file (by a daemon from before
// on-disk keys, docs/notes/page-path-identity.md) is still the file's: reads find it, and
// an answer or an owner is written to it too, so one never outlives another. A file the
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
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
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
	// Shown: the thread showed it (view.inline, view.open.page), the last it did with it.
	Shown = "shown"
	// Written: the thread's Claude wrote or edited it, the last it did with it.
	Written = "written"
	// PagesDirectory: the file is in the thread's pages directory, and the thread neither
	// showed nor wrote it.
	PagesDirectory = "pages-directory"
)

// Owner is one thread that owns a page, and how.
type Owner struct {
	Thread string
	// How is Shown, Written or PagesDirectory.
	How string
}

// Access is what the daemon says about one page file.
type Access struct {
	// Path is the file's absolute path, symlinks resolved, spelled as on disk
	// (fsx.OnDiskPath): the key of everything here.
	Path string
	// Owners are every existing thread that owns the page: PagesThread first, then the
	// threads that showed or wrote it by when they first did, oldest first (ties by id).
	Owners []Owner
	// Owner is the first owner's id (Owners[0]), the page's default thread; "" for none.
	Owner string
	// PagesThread is the thread whose pages directory holds the file, "" for none (or one
	// that no longer exists).
	PagesThread string
	// Consent is the user's answer. It counts only while Owner is "".
	Consent Consent
}

// Owns reports whether thread id is one of the page's owners.
func (a Access) Owns(id string) bool {
	return id != "" && slices.ContainsFunc(a.Owners, func(o Owner) bool { return o.Thread == id })
}

// How is how the first owner came to own the page; "" for no owner.
func (a Access) How() string {
	if len(a.Owners) == 0 {
		return ""
	}
	return a.Owners[0].How
}

// Changed is published on the bus (bus.Publish[page.Changed]) when the page at Path got
// a new owner (Record) or the user another answer (SetConsent), so every frame showing it
// reads its access again (docs/notes/page-access-live.md). A removed thread's pages lose
// that owner without one: the API's page source tells clients from thread.Removed.
type Changed struct {
	// Path is the page's resolved path (Access.Path).
	Path string
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
	// StorageRoot holds every page's storage, a directory per page file
	// (paths.Paths.PageFileStorage). Empty: none kept.
	StorageRoot string
	// ThreadStorageRoot holds each thread's own page storage of before storage was per
	// file (paths.Paths.PageStorage, <root>/<thread id>/storage.json): New carries it into
	// the pages' storage once (carry.go) and never writes it. Empty: nothing carried.
	ThreadStorageRoot string
	// Guarded reports a path the preview never serves (preview.Grants.Guarded); asked of
	// both the path as given and its resolved one. Nil: none.
	Guarded func(path string) bool
	// ThreadExists reports whether a thread exists (not removed); a pages directory of a
	// thread that does not is no one's. Nil: every one does.
	ThreadExists func(id string) bool
	Log          *slog.Logger
	// Bus hears Changed. Nil: nothing is published.
	Bus *bus.Bus
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

// Store keeps pages' owners, the user's answers and the pages' storage. Safe for
// concurrent use.
type Store struct {
	o       Options
	homes   []string // Home as given and resolved
	storeMu sync.Mutex
}

// New returns a Store. Before it returns it carries what is left to carry of the threads'
// own page storage into the pages' storage (carry), and removes the storage of pages
// whose file is gone (Sweep).
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
	s.carry(ctx)
	s.Sweep(ctx)
	return s, nil
}

// spellings are p, its resolved path and that spelled as on disk, without repeats; none
// for "".
func spellings(p string) []string {
	if p == "" {
		return nil
	}
	p = filepath.Clean(p)
	out := []string{p}
	if real, err := filepath.EvalSymlinks(p); err == nil {
		for _, q := range []string{real, fsx.OnDiskPath(real)} {
			if !slices.Contains(out, q) {
				out = append(out, q)
			}
		}
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

// Resolve checks path and returns it with its symlinks resolved, spelled as on disk
// (fsx.OnDiskPath): an absolute path to a regular .html or .htm file under home or the
// pages root (both as spelled and resolved), not one the preview refuses.
// ErrInvalidArgument, ErrNotFound or ErrGuarded otherwise.
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
	real = fsx.OnDiskPath(real)
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

// Record records thread id as an owner of the page at path, how ("shown", "written"): a
// thread already among its owners keeps its place and gets the new how. A path Resolve
// refuses is not recorded (its error is returned); so is a thread that does not exist
// (the foreign key refuses it).
func (s *Store) Record(ctx context.Context, id, path, how string) error {
	real, err := s.Resolve(path)
	if err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("%w: no thread", ErrInvalidArgument)
	}
	before, err := s.access(ctx, real)
	if err != nil {
		return err
	}
	now := s.o.Now().UnixMilli()
	if err := s.write(ctx, "page_owners", real, func(tx *sql.Tx, key string) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO page_owners (path, thread_id, how, first_at, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (path, thread_id) DO UPDATE SET how = excluded.how, updated_at = excluded.updated_at`,
			key, id, how, now, now)
		return err
	}); err != nil {
		return fmt.Errorf("page: record %s as %s's: %w", real, id, err)
	}
	// Only a new owner changes what a frame gets: a thread writing its own page again is no news.
	if !before.Owns(id) {
		s.publish(real)
	}
	return nil
}

func (s *Store) publish(real string) {
	if s.o.Bus != nil {
		bus.Publish(s.o.Bus, Changed{Path: real})
	}
}

// keys are the keys table (page_owners or page_consent) has rows of the page at real
// under: real, and any other spelling of the file (fsx.OtherSpelling), kept by a daemon
// from before keys were on-disk spellings. The newest row first; real first among rows
// of the same time.
func (s *Store) keys(ctx context.Context, q queryer, table, real string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT path FROM `+table+` WHERE path = ? OR path LIKE ? ESCAPE '\'
		ORDER BY updated_at DESC, path = ? DESC`, real, fsx.LikeSpellings(real), real)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		if (p == real || fsx.OtherSpelling(p, real)) && !slices.Contains(out, p) {
			out = append(out, p) // page_owners has a row per owner of a key
		}
	}
	return out, rows.Err()
}

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// write runs upsert, in one transaction, for real and for every other key table has rows
// of the same file under (keys): an answer or an owner given under any spelling is the
// file's under all of them, whichever row a read finds first.
func (s *Store) write(ctx context.Context, table, real string, upsert func(tx *sql.Tx, key string) error) error {
	tx, err := s.o.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	keys, err := s.keys(ctx, tx, table, real)
	if err != nil {
		return err
	}
	if !slices.Contains(keys, real) {
		keys = append(keys, real)
	}
	for _, k := range keys {
		if err := upsert(tx, k); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// newest is the key of table's newest row for the page at real (keys), "" for none.
func (s *Store) newest(ctx context.Context, table, real string) (string, error) {
	keys, err := s.keys(ctx, s.o.DB, table, real)
	if err != nil || len(keys) == 0 {
		return "", err
	}
	return keys[0], nil
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
	owners, err := s.owners(ctx, real)
	if err != nil {
		return Access{}, fmt.Errorf("page: owners of %s: %w", real, err)
	}
	if a.PagesThread != "" {
		// The thread whose pages directory holds the page comes first, as it made it.
		first := Owner{Thread: a.PagesThread, How: PagesDirectory}
		if i := slices.IndexFunc(owners, func(o Owner) bool { return o.Thread == a.PagesThread }); i >= 0 {
			first = owners[i]
			owners = slices.Delete(owners, i, i+1)
		}
		owners = slices.Insert(owners, 0, first)
	}
	a.Owners = owners
	if len(owners) > 0 {
		a.Owner = owners[0].Thread
	}
	var allowed sql.NullBool
	key, err := s.newest(ctx, "page_consent", real)
	if err == nil {
		err = sql.ErrNoRows
		if key != "" {
			err = s.o.DB.QueryRowContext(ctx, `SELECT allowed FROM page_consent WHERE path = ?`, key).Scan(&allowed)
		}
	}
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

// owners are the threads recorded as having shown or written the page at real, under any
// key of the file (keys), that still exist: by when each first did, oldest first (ties by
// id), each with how it last did.
func (s *Store) owners(ctx context.Context, real string) ([]Owner, error) {
	keys, err := s.keys(ctx, s.o.DB, "page_owners", real)
	if err != nil || len(keys) == 0 {
		return nil, err
	}
	q := `SELECT thread_id, how, first_at, updated_at FROM page_owners WHERE path IN (?` + strings.Repeat(", ?", len(keys)-1) + `)`
	args := make([]any, len(keys))
	for i, k := range keys {
		args[i] = k
	}
	rows, err := s.o.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	type claim struct {
		how           string
		first, latest int64
	}
	by := map[string]*claim{}
	for rows.Next() {
		var id, how string
		var first, latest int64
		if err := rows.Scan(&id, &how, &first, &latest); err != nil {
			return nil, err
		}
		c := by[id]
		if c == nil {
			by[id] = &claim{how: how, first: first, latest: latest}
			continue
		}
		c.first = min(c.first, first)
		if latest > c.latest {
			c.how, c.latest = how, latest
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(by))
	for id := range by {
		if s.o.ThreadExists == nil || s.o.ThreadExists(id) { // removed, its rows not yet gone
			ids = append(ids, id)
		}
	}
	slices.SortFunc(ids, func(a, b string) int {
		if d := by[a].first - by[b].first; d != 0 {
			return int(min(max(d, -1), 1))
		}
		return strings.Compare(a, b)
	})
	out := make([]Owner, len(ids))
	for i, id := range ids {
		out[i] = Owner{Thread: id, How: by[id].how}
	}
	return out, nil
}

// SetConsent records the user's answer for the page at path, allowed or not, and returns
// its access after. The answer is kept whether or not a thread owns the page now: it
// counts once none does. It is the file's under every spelling (write), so "Stop
// allowing" given under one is never undone by an older answer under another.
func (s *Store) SetConsent(ctx context.Context, path string, allowed bool) (Access, error) {
	real, err := s.Resolve(path)
	if err != nil {
		return Access{}, err
	}
	before, err := s.access(ctx, real)
	if err != nil {
		return Access{}, err
	}
	now := s.o.Now().UnixMilli()
	if err := s.write(ctx, "page_consent", real, func(tx *sql.Tx, key string) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO page_consent (path, allowed, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (path) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at`,
			key, allowed, now)
		return err
	}); err != nil {
		return Access{}, fmt.Errorf("page: consent of %s: %w", real, err)
	}
	after, err := s.access(ctx, real)
	if err == nil && after.Consent != before.Consent {
		s.publish(real)
	}
	return after, err
}

// Allow returns the page's access when it may use the bridge (storage, fetch): a thread
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

// storageOf is the storage directory of the page at real and the key it is kept under
// (its path file's): real's own when it has one or none of the file's other spellings
// has one, else the newest written of those (a daemon from before on-disk keys kept it
// under the spelling it was given). "" for none kept. Called with storeMu held.
func (s *Store) storageOf(real string) (dir, key string) {
	dir = s.storageDir(real)
	if dir == "" {
		return "", ""
	}
	if _, err := os.Stat(dir); err == nil {
		return dir, real
	}
	entries, err := os.ReadDir(s.o.StorageRoot)
	if err != nil {
		return dir, real
	}
	var newest time.Time
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		d := filepath.Join(s.o.StorageRoot, e.Name())
		f := filepath.Join(d, pathFile)
		b, err := os.ReadFile(f)
		if err != nil || s.storageDir(string(b)) != d || !fsx.OtherSpelling(string(b), real) {
			continue
		}
		if fi, err := os.Stat(f); err == nil && fi.ModTime().After(newest) {
			newest, dir, key = fi.ModTime(), d, string(b)
		}
	}
	if key == "" {
		key = real
	}
	return dir, key
}

// Storage is what the page at path keeps with cf.storage, whichever thread it acts for:
// key → the value's JSON text. Allow's errors for a page that may not.
func (s *Store) Storage(ctx context.Context, path string) (map[string]string, error) {
	a, err := s.Allow(ctx, path)
	if err != nil {
		return nil, err
	}
	s.storeMu.Lock()
	defer s.storeMu.Unlock()
	dir, _ := s.storageOf(a.Path)
	vals, err := pagestorage.Read(dir, s.o.Log, "page", a.Path)
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
	if s.o.StorageRoot == "" {
		return nil, fmt.Errorf("%w: this daemon keeps no page storage", ErrInvalidArgument)
	}
	s.storeMu.Lock()
	defer s.storeMu.Unlock()
	dir, keptAs := s.storageOf(a.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("page: storage of %s: %w", a.Path, err)
	}
	// The key its directory is named for, so Sweep keeps it (an older spelling's too).
	if err := pagestorage.WriteAtomic(filepath.Join(dir, pathFile), []byte(keptAs)); err != nil {
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
