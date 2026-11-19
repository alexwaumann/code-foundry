package page

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/pagestorage"
)

// The carry-over (docs/notes/page-storage-per-file.md). Before storage was per page file,
// a thread's pages kept cf.storage in one blob per thread (<ThreadStorageRoot>/<thread
// id>/storage.json), and nothing says which page wrote which key. Migration 0068 lists in
// page_storage_carry the pages each thread's blob may hold data of: the pages it owns, the
// pages its conversation showed (record: it becomes their owner here too, as it showed them
// before owners were kept) and every page in its pages directory (path ""). carry copies the
// whole blob into each of those pages' storage, merged with what the page's storage already
// holds (a page no thread owned kept its own), and crosses the rows off. The blobs are read,
// never written or removed: an older GUI still reads them (ThreadService.PageStorage), and
// they go with their thread as before.
//
// What wins a key two of them hold: the one whose file was written last (its storage.json's
// modification time), the page's own storage among equals. The merged storage is kept under
// the limit by leaving out the keys of the oldest first; a page's storage that the merge
// changed is first copied to BeforeCarryFile, once.

// BeforeCarryFile is the copy, in a page's storage directory, of what its storage held
// before the carry-over changed it.
const BeforeCarryFile = "storage.before-carry.json"

// carryPagesMax bounds the pages walked in one thread's pages directory.
const carryPagesMax = 10000

type carryRow struct {
	path, thread string
	record       bool
	at           int64
}

// carrySource is one storage carried into a page: a thread's blob, or the page's own.
type carrySource struct {
	vals map[string]json.RawMessage
	at   time.Time
	own  bool
}

// carry carries every row of page_storage_carry (above). A failure to read the list is
// logged and left for the next start; a page whose storage cannot be written keeps its rows.
func (s *Store) carry(ctx context.Context) {
	if s.o.StorageRoot == "" {
		return
	}
	todo, err := s.carryRows(ctx)
	if err != nil {
		s.o.Log.Warn("read the page storage left to carry over", "err", err)
		return
	}
	if len(todo) == 0 {
		return
	}
	start := time.Now()
	blobs := map[string]*carrySource{}
	blob := func(id string) *carrySource {
		if b, ok := blobs[id]; ok {
			return b
		}
		blobs[id] = s.threadBlob(id)
		return blobs[id]
	}
	type page struct {
		srcs []*carrySource
		rows []carryRow
	}
	pages := map[string]*page{}
	var order []string
	var noPage []carryRow
	for _, r := range todo {
		reals := s.carryPages(ctx, r)
		if len(reals) == 0 {
			noPage = append(noPage, r)
			continue
		}
		b := blob(r.thread)
		for _, real := range reals {
			p := pages[real]
			if p == nil {
				p = &page{}
				pages[real] = p
				order = append(order, real)
			}
			p.rows = append(p.rows, r)
			if b != nil && !slices.Contains(p.srcs, b) {
				p.srcs = append(p.srcs, b)
			}
		}
	}
	done := noPage
	carried := 0
	for _, real := range order {
		p := pages[real]
		if len(p.srcs) > 0 {
			changed, err := s.carryInto(real, p.srcs)
			if err != nil {
				s.o.Log.Warn("carry a thread's page storage over to its page", "page", real, "err", err)
				continue // its rows stay: the next start carries it again
			}
			if changed {
				carried++
			}
		}
		done = append(done, p.rows...)
	}
	if err := s.carryDone(ctx, done); err != nil {
		s.o.Log.Warn("cross off the carried page storage", "err", err)
	}
	s.o.Log.Info("carried the threads' page storage over to their pages", "rows", len(todo), "pages", len(order), "changed", carried, "took", time.Since(start))
}

func (s *Store) carryRows(ctx context.Context) ([]carryRow, error) {
	rows, err := s.o.DB.QueryContext(ctx, `SELECT path, thread_id, record, at FROM page_storage_carry ORDER BY thread_id, path`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []carryRow
	for rows.Next() {
		var r carryRow
		if err := rows.Scan(&r.path, &r.thread, &r.record, &r.at); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) carryDone(ctx context.Context, done []carryRow) error {
	if len(done) == 0 {
		return nil
	}
	tx, err := s.o.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, r := range done {
		if _, err := tx.ExecContext(ctx, `DELETE FROM page_storage_carry WHERE path = ? AND thread_id = ?`, r.path, r.thread); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// carryPages are the page keys row r carries into: its page resolved (a page the thread
// showed before owners were kept is recorded as the thread's first), or every page in the
// thread's pages directory. A page the thread owns that is away now (its branch not checked
// out) keeps its row's key, which was resolved when it was recorded: its storage waits there
// as any missing page's does (Sweep). None for a path that is no page.
func (s *Store) carryPages(ctx context.Context, r carryRow) []string {
	if r.path == "" {
		return s.pagesDirPages(r.thread)
	}
	real, err := s.Resolve(r.path)
	switch {
	case err == nil:
		if r.record {
			s.claim(ctx, real, r.thread, r.at)
		}
		return []string{real}
	case errors.Is(err, ErrNotFound) && !r.record:
		return []string{r.path}
	}
	s.o.Log.Debug("no page to carry a thread's storage into", "path", r.path, "thread", r.thread, "err", err)
	return nil
}

// claim records thread id as an owner of the page at real, shown at at (unix ms), unless it
// already is one: a page its conversation showed before owners were kept.
func (s *Store) claim(ctx context.Context, real, id string, at int64) {
	err := s.write(ctx, "page_owners", real, func(tx *sql.Tx, key string) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO page_owners (path, thread_id, how, first_at, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (path, thread_id) DO NOTHING`, key, id, Shown, at, at)
		return err
	})
	if err != nil {
		s.o.Log.Warn("record a page a thread showed before owners were kept", "page", real, "thread", id, "err", err)
	}
}

// pagesDirPages are the pages (resolved keys) in thread id's pages directory.
func (s *Store) pagesDirPages(id string) []string {
	if s.o.PagesRoot == "" || id == "" || strings.ContainsAny(id, `/\`) {
		return nil
	}
	var out []string
	_ = filepath.WalkDir(filepath.Join(s.o.PagesRoot, id), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return filepath.SkipDir
		}
		if len(out) >= carryPagesMax {
			return fs.SkipAll
		}
		switch strings.ToLower(filepath.Ext(p)) {
		case ".html", ".htm":
		default:
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if real, err := s.Resolve(p); err == nil && !slices.Contains(out, real) {
			out = append(out, real)
		}
		return nil
	})
	return out
}

// threadBlob is thread id's own page storage and when it was last written; nil when it has
// none (or it is empty, or cannot be read: then logged).
func (s *Store) threadBlob(id string) *carrySource {
	if s.o.ThreadStorageRoot == "" || id == "" || strings.ContainsAny(id, `/\`) {
		return nil
	}
	dir := filepath.Join(s.o.ThreadStorageRoot, id)
	fi, err := os.Stat(filepath.Join(dir, pagestorage.File))
	if err != nil {
		return nil
	}
	vals, err := pagestorage.Read(dir, s.o.Log, "thread", id)
	if err != nil {
		s.o.Log.Warn("read a thread's page storage to carry it over", "thread", id, "err", err)
		return nil
	}
	if len(vals) == 0 {
		return nil
	}
	return &carrySource{vals: vals, at: fi.ModTime()}
}

// carryInto merges srcs into the storage of the page at real (above) and reports whether
// that changed it.
func (s *Store) carryInto(real string, srcs []*carrySource) (bool, error) {
	s.storeMu.Lock()
	defer s.storeMu.Unlock()
	dir, keptAs := s.storageOf(real)
	cur, err := pagestorage.Read(dir, s.o.Log, "page", real)
	if err != nil {
		return false, err
	}
	stored := filepath.Join(dir, pagestorage.File)
	own := &carrySource{vals: cur, own: true}
	fi, err := os.Stat(stored)
	if err == nil {
		own.at = fi.ModTime()
	}
	merged := mergeCarry(append(slices.Clone(srcs), own))
	if sameStorage(merged, cur) {
		return false, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false, err
	}
	if fi != nil {
		backup := filepath.Join(dir, BeforeCarryFile)
		if _, err := os.Stat(backup); errors.Is(err, fs.ErrNotExist) {
			b, err := os.ReadFile(stored)
			if err != nil {
				return false, err
			}
			if err := pagestorage.WriteAtomic(backup, b); err != nil {
				return false, err
			}
		}
	}
	if err := pagestorage.WriteAtomic(filepath.Join(dir, pathFile), []byte(keptAs)); err != nil {
		return false, err
	}
	b, err := json.Marshal(merged)
	if err != nil {
		return false, err
	}
	if err := pagestorage.WriteAtomic(stored, b); err != nil {
		return false, err
	}
	return true, nil
}

// mergeCarry merges storages: for a key several hold, the value of the one written last
// (the page's own among equals). Over pagestorage.Max, the keys only older storages hold
// are left out, oldest storage first, until it fits.
func mergeCarry(srcs []*carrySource) map[string]json.RawMessage {
	slices.SortStableFunc(srcs, func(a, b *carrySource) int {
		if c := a.at.Compare(b.at); c != 0 {
			return c
		}
		switch {
		case a.own == b.own:
			return 0
		case a.own:
			return 1
		}
		return -1
	})
	out := map[string]json.RawMessage{}
	for _, src := range srcs {
		for k, v := range src.vals {
			out[k] = v
		}
	}
	if storageSize(out) <= pagestorage.Max {
		return out
	}
	// Newest first, each key once, while it fits.
	out = map[string]json.RawMessage{}
	size := 2 // {}
	for i := len(srcs) - 1; i >= 0; i-- {
		keys := make([]string, 0, len(srcs[i].vals))
		for k := range srcs[i].vals {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			if _, ok := out[k]; ok {
				continue
			}
			n := entrySize(k, srcs[i].vals[k])
			if len(out) > 0 {
				n++ // ,
			}
			if size+n > pagestorage.Max {
				continue
			}
			out[k] = srcs[i].vals[k]
			size += n
		}
	}
	return out
}

// storageSize is the size of vals as written (json.Marshal).
func storageSize(vals map[string]json.RawMessage) int {
	b, err := json.Marshal(vals)
	if err != nil {
		return pagestorage.Max + 1
	}
	return len(b)
}

// entrySize is the size of "k":v as json.Marshal writes it in an object.
func entrySize(k string, v json.RawMessage) int {
	kb, _ := json.Marshal(k)
	var c bytes.Buffer
	if json.Compact(&c, v) != nil {
		return pagestorage.Max + 1
	}
	return len(kb) + 1 + c.Len()
}

func sameStorage(a, b map[string]json.RawMessage) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		w, ok := b[k]
		if !ok || !bytes.Equal(v, w) {
			return false
		}
	}
	return true
}

// ThreadRemoved removes the storage of every page in thread id's pages directory, which goes
// with the thread (docs/notes/page-storage-per-file.md). The storage of a page anywhere else
// stays: the file is still there for its other owners, or for the user to allow. The daemon
// calls it when the thread is removed.
func (s *Store) ThreadRemoved(id string) {
	if s.o.StorageRoot == "" || id == "" || strings.ContainsAny(id, `/\`) {
		return
	}
	var dirs []string
	for _, root := range s.pagesRoots() {
		dirs = append(dirs, filepath.Join(root, id))
	}
	entries, err := os.ReadDir(s.o.StorageRoot)
	if err != nil {
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
		if err != nil || !slices.ContainsFunc(dirs, func(d string) bool { return within([]string{d}, string(b)) }) {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			s.o.Log.Warn("remove a removed thread's page's storage", "dir", dir, "err", err)
		}
	}
}
