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
}

// searchIndexFor is the index thread id's saves use: off when Options.Unindexed says so.
// A thread not in the snapshot yet is indexed.
func (m *Manager) searchIndexFor(id string) searchIndex {
	if f := m.opts.Unindexed; f != nil {
		if t, ok := m.Snapshot().Thread(id); ok && f(t) {
			return searchIndex{off: true}
		}
	}
	return searchIndex{}
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
	text, _, ok := itemSearchText(it)
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

// searchBackfillChunk is how many items of an indexed kind one backfill transaction
// indexes at most: about 100 ms of the write lock on the measured laptop, far inside the
// other writers' busy timeout (db.BusyTimeout) however long the thread. A variable for
// tests.
var searchBackfillChunk = 500

// startSearchBackfill indexes, in the background, the threads search_backfill lists (the
// threads that existed when migration 0054 ran), searchBackfillChunk items per
// transaction, recording how far each thread got (next_ordinal) and deleting its row once
// done, so a daemon stop resumes at the next start where it left off. A thread that fails
// is logged and dropped from the list, and the others go on. Searches meanwhile see what
// is indexed so far. Nothing starts when the list is empty (every start after the first).
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
		n, failed, items, err := m.backfillSearch(m.ctx, ids)
		if err != nil && m.ctx.Err() == nil {
			m.log.Error("index threads for search", "threads", n, "of", len(ids), "err", err)
			return
		}
		m.log.Info("indexed threads for search", "threads", n, "failed", failed, "items", items,
			"took", time.Since(start).Round(time.Millisecond).String())
	}()
}

// backfillSearch indexes the threads ids (from search_backfill) and returns how many
// threads it did, how many failed, and how many items of an indexed kind it indexed. A
// thread that fails while ctx is live is logged and dropped from search_backfill (its
// documents so far stay), so one bad thread never holds back the rest, the most recent
// last; it returns an error only when ctx ends or the list cannot be written.
func (m *Manager) backfillSearch(ctx context.Context, ids []string) (threads, failed, items int, err error) {
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return threads, failed, items, err
		}
		n, err := m.backfillThread(ctx, id)
		items += n
		if err != nil {
			if ctx.Err() != nil {
				return threads, failed, items, ctx.Err()
			}
			m.log.Error("index a thread for search", "thread", id, "err", err)
			if _, err := m.opts.DB.ExecContext(ctx, `DELETE FROM search_backfill WHERE thread_id = ?`, id); err != nil {
				return threads, failed, items, fmt.Errorf("thread: search backfill of %s: %w", id, err)
			}
			failed++
			continue
		}
		threads++
	}
	return threads, failed, items, nil
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

// backfillThread indexes one thread's saved items, a chunk per transaction
// (backfillChunk), until its search_backfill row is gone; it returns how many items of an
// indexed kind it indexed.
func (m *Manager) backfillThread(ctx context.Context, id string) (int, error) {
	total := 0
	for {
		n, done, err := m.backfillChunk(ctx, id)
		total += n
		if err != nil || done {
			return total, err
		}
	}
}

// backfillChunk indexes the next searchBackfillChunk items of an indexed kind of thread
// id, from its search_backfill row's next_ordinal, and moves next_ordinal past them, or
// deletes the row when they were the last; one transaction. done: the thread has no row
// left. The items are read from the table, not the thread's log (what is indexed is what
// is saved), and in the transaction: a save meanwhile indexes after it, never under it.
// Only the indexed kinds are read: tool calls hold most of the bytes.
func (m *Manager) backfillChunk(ctx context.Context, id string) (n int, done bool, err error) {
	ix := m.searchIndexFor(id)
	tx, err := m.opts.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, fmt.Errorf("thread: search backfill of %s: %w", id, err)
	}
	defer func() { _ = tx.Rollback() }()
	var next int64
	switch err := tx.QueryRowContext(ctx, `SELECT next_ordinal FROM search_backfill WHERE thread_id = ?`, id).Scan(&next); {
	case errors.Is(err, sql.ErrNoRows):
		return 0, true, nil // removed meanwhile
	case err != nil:
		return 0, false, fmt.Errorf("thread: search backfill of %s: %w", id, err)
	}
	var items []Item
	if !ix.off {
		args := make([]any, 0, len(searchTexts)+3)
		args = append(args, id, next)
		for k := range searchTexts {
			args = append(args, string(k))
		}
		args = append(args, searchBackfillChunk)
		items, err = scanItems(ctx, tx, id, `SELECT ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data
			FROM thread_items WHERE thread_id = ? AND ordinal >= ? AND kind IN (?`+strings.Repeat(", ?", len(searchTexts)-1)+`)
			ORDER BY ordinal LIMIT ?`, args...)
		if err != nil {
			return 0, false, err
		}
	}
	for _, it := range items {
		if err := indexItem(ctx, tx, it, ix); err != nil {
			return 0, false, err
		}
	}
	done = len(items) < searchBackfillChunk
	if done {
		_, err = tx.ExecContext(ctx, `DELETE FROM search_backfill WHERE thread_id = ?`, id)
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE search_backfill SET next_ordinal = ? WHERE thread_id = ?`, items[len(items)-1].Ordinal+1, id)
	}
	if err != nil {
		return 0, false, fmt.Errorf("thread: search backfill of %s: %w", id, err)
	}
	if err := tx.Commit(); err != nil {
		return 0, false, fmt.Errorf("thread: search backfill of %s: %w", id, err)
	}
	return len(items), done, nil
}
