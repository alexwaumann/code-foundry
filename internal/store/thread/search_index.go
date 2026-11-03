package thread

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"hash/fnv"
	"strings"
	"time"
)

// The thread search index (migration 0054, docs/notes/search-3-index.md): one contentless
// FTS5 trigram document per item id holding searchTexts' text. It is kept current on the
// item write path: every saveItem/saveItems writes the row and its document in one
// transaction (a new item, and an in-place rewrite: a question's answers). A document goes
// with the last thread_items row holding its id (the thread_items_search_gone trigger), so
// removing a thread needs nothing here. Threads that existed before the index are filled in
// at startup by backfillSearch.
//
// What is never indexed: anything that is not a thread. Only the thread store writes
// thread_items, and only for its threads (the row references threads), so a run that is not
// a thread has nothing to index. A thread the user should never find (a hidden utility run
// made as a thread) is kept out by Options.Unindexed: its saves write no document and
// queries skip it as a holder.

// searchIndex is how a save indexes an item.
type searchIndex struct {
	// off: the thread is not indexed (Options.Unindexed).
	off bool
	// name returns a thread's current name, for the thread tags of a user message; nil
	// falls back to the tag's label.
	name func(id string) (string, bool)
}

// names returns ix.name, or a resolver that knows no thread.
func (ix searchIndex) names() func(string) (string, bool) {
	if ix.name != nil {
		return ix.name
	}
	return func(string) (string, bool) { return "", false }
}

// searchIndexFor is the index thread id's saves use: names from the current snapshot, off
// when Options.Unindexed says so. A thread not in the snapshot yet is indexed.
func (m *Manager) searchIndexFor(id string) searchIndex {
	snap := m.Snapshot()
	if f := m.opts.Unindexed; f != nil {
		if t, ok := snap.Thread(id); ok && f(t) {
			return searchIndex{off: true}
		}
	}
	return searchIndex{name: func(ref string) (string, bool) {
		t, ok := snap.Thread(ref)
		return t.Name, ok
	}}
}

// txer is a *sql.Tx: what indexing needs.
type txer interface {
	execer
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// indexItem writes the item's search document (when its kind is indexed and ix is on).
func indexItem(ctx context.Context, tx txer, it Item, ix searchIndex) error {
	if ix.off || it.Streaming {
		return nil
	}
	text, _, ok := itemSearchText(it, ix.names())
	if !ok {
		return nil
	}
	if err := putSearchDoc(ctx, tx, it.ID, text); err != nil {
		return fmt.Errorf("thread: index item %s: %w", it.ID, err)
	}
	return nil
}

// textHash is search_docs.hash: the text's FNV-1a, as SQLite's signed integer.
func textHash(text string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(text))
	return int64(h.Sum64()) //nolint:gosec // a bit pattern, not a quantity
}

// putSearchDoc makes item id's document hold text: inserted, replaced when the text
// changed, left alone when it did not (a fork's copy), dropped when text is "". The last
// write wins: a fork's copy that differs from its original (a question cancelled in the
// fork and answered in the original) indexes whichever was saved last; queries check the
// holder's own text.
func putSearchDoc(ctx context.Context, tx txer, itemID, text string) error {
	var id, hash int64
	err := tx.QueryRowContext(ctx, `SELECT id, hash FROM search_docs WHERE item_id = ?`, itemID).Scan(&id, &hash)
	h := textHash(text)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if text == "" {
			return nil
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO search_docs (item_id, hash) VALUES (?, ?)`, itemID, h)
		if err != nil {
			return err
		}
		if id, err = res.LastInsertId(); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO search_fts (rowid, text) VALUES (?, ?)`, id, text)
		return err
	case err != nil:
		return err
	case text == "":
		if _, err := tx.ExecContext(ctx, `DELETE FROM search_fts WHERE rowid = ?`, id); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM search_docs WHERE id = ?`, id)
		return err
	case hash == h:
		return nil
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM search_fts WHERE rowid = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO search_fts (rowid, text) VALUES (?, ?)`, id, text); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE search_docs SET hash = ? WHERE id = ?`, h, id)
	return err
}

// startSearchBackfill indexes, in the background, the threads search_backfill lists (the
// threads that existed when migration 0054 ran), one transaction per thread, deleting each
// row once its thread is done; a daemon stop resumes at the next start. Searches meanwhile
// see what is indexed so far. Nothing starts when the list is empty (every start after
// the first).
func (m *Manager) startSearchBackfill(ctx context.Context) {
	ids, err := searchBackfillPending(ctx, m.opts.DB)
	if err != nil {
		m.log.Error("index threads for search", "err", err)
		return
	}
	if len(ids) == 0 {
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		start := time.Now()
		n, items, err := m.backfillSearch(m.ctx, ids)
		if err != nil && m.ctx.Err() == nil {
			m.log.Error("index threads for search", "threads", n, "of", len(ids), "err", err)
			return
		}
		m.log.Info("indexed threads for search", "threads", n, "items", items, "took", time.Since(start).Round(time.Millisecond).String())
	}()
}

// backfillSearch indexes the threads ids (from search_backfill) and returns how many
// threads and items of an indexed kind it did.
func (m *Manager) backfillSearch(ctx context.Context, ids []string) (threads, items int, err error) {
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return threads, items, err
		}
		n, err := m.backfillThread(ctx, id)
		if err != nil {
			return threads, items, err
		}
		threads, items = threads+1, items+n
	}
	return threads, items, nil
}

// searchBackfillPending lists search_backfill, the least recently active thread first: a
// document's rowid grows with its first save, and a search reads the highest first
// (maxSearchCandidates), so the backfill gives the most recent threads the highest.
func searchBackfillPending(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT b.thread_id FROM search_backfill b JOIN threads t ON t.id = b.thread_id
		ORDER BY t.last_activity_at, t.created_at, b.thread_id`)
	if err != nil {
		return nil, fmt.Errorf("thread: search backfill: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("thread: search backfill: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: search backfill: %w", err)
	}
	return ids, nil
}

// backfillThread indexes one thread's saved items and removes it from search_backfill, in
// one transaction; it returns how many of its items are of an indexed kind. The items are
// read from the table, not the thread's log: what is indexed is what is saved.
func (m *Manager) backfillThread(ctx context.Context, id string) (int, error) {
	ix := m.searchIndexFor(id)
	tx, err := m.opts.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("thread: search backfill of %s: %w", id, err)
	}
	defer func() { _ = tx.Rollback() }()
	// Read in the transaction: a save meanwhile indexes after it, never under it. Only
	// the indexed kinds: tool calls hold most of the bytes.
	kinds := make([]any, 0, len(searchTexts)+1)
	kinds = append(kinds, id)
	for k := range searchTexts {
		kinds = append(kinds, string(k))
	}
	items, err := scanItems(ctx, tx, id, `SELECT ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data
		FROM thread_items WHERE thread_id = ? AND kind IN (?`+strings.Repeat(", ?", len(searchTexts)-1)+`) ORDER BY ordinal`, kinds...)
	if err != nil {
		return 0, err
	}
	if ix.off {
		items = nil
	}
	for _, it := range items {
		if err := indexItem(ctx, tx, it, ix); err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM search_backfill WHERE thread_id = ?`, id); err != nil {
		return 0, fmt.Errorf("thread: search backfill of %s: %w", id, err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("thread: search backfill of %s: %w", id, err)
	}
	return len(items), nil
}
