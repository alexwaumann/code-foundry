package thread

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// Persistence for thread_items (migration 0014). data holds the kind's payload.

// itemData is the JSON in thread_items.data.
type itemData struct {
	Text          string      `json:"text,omitempty"`
	Attachments   []string    `json:"attachments,omitempty"`
	Composer      string      `json:"composer,omitempty"`
	Origin        string      `json:"origin,omitempty"`
	WakeTitle     string      `json:"wake_title,omitempty"`
	WakeJSON      string      `json:"wake_json,omitempty"`
	SentBy        string      `json:"sent_by,omitempty"`
	ResumeNote    string      `json:"resume_note,omitempty"`
	SeedPrefix    string      `json:"seed_prefix,omitempty"`
	MemoryNote    string      `json:"memory_note,omitempty"`
	NoteCreatedBy string      `json:"note_created_by,omitempty"`
	APIError      bool        `json:"api_error,omitempty"`
	Queued        bool        `json:"queued,omitempty"`
	PlacedAfter   int64       `json:"placed_after,omitempty"`
	Tool          *ToolCall   `json:"tool,omitempty"`
	Request       *Request    `json:"request,omitempty"`
	Turn          *TurnEnd    `json:"turn,omitempty"`
	Compaction    *Compaction `json:"compaction,omitempty"`
	HTML          *HTMLPage   `json:"html,omitempty"`
	Theme         *ThemeCard  `json:"theme,omitempty"`
}

// execer is a *sql.DB or a *sql.Tx.
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// saveItems saves items and their search documents in one transaction (a fork's copied
// history: all or none).
func saveItems(ctx context.Context, db *sql.DB, threadID string, items []Item, ix searchIndex) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("thread: save items of %s: %w", threadID, err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, it := range items {
		if err := writeItem(ctx, tx, threadID, it); err != nil {
			return err
		}
		if err := indexItem(ctx, tx, it, ix); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("thread: save items of %s: %w", threadID, err)
	}
	return nil
}

// saveItem inserts or rewrites one item and its search document. Streaming items are
// never saved.
func saveItem(ctx context.Context, db *sql.DB, threadID string, it Item, ix searchIndex) error {
	if _, ok := searchTexts[it.Kind]; !ok || ix.off {
		return writeItem(ctx, db, threadID, it) // nothing to index: no transaction
	}
	return saveItems(ctx, db, threadID, []Item{it}, ix)
}

// writeItem inserts or rewrites one item's row.
func writeItem(ctx context.Context, db execer, threadID string, it Item) error {
	data, err := json.Marshal(itemData{Text: it.Text, Attachments: it.Attachments, Composer: it.ComposerText,
		Origin: string(it.Origin), WakeTitle: it.WakeTitle, WakeJSON: it.WakeJSON, SentBy: it.SentBy, ResumeNote: it.ResumeNote, SeedPrefix: it.SeedPrefix, MemoryNote: it.MemoryNote,
		NoteCreatedBy: it.NoteCreatedBy, APIError: it.APIError, Queued: it.Queued, PlacedAfter: it.PlacedAfter, Tool: it.Tool, Request: it.Request, Turn: it.Turn, Compaction: it.Compaction, HTML: it.HTML, Theme: it.Theme})
	if err != nil {
		return fmt.Errorf("thread: encode item %s: %w", it.ID, err)
	}
	_, err = db.ExecContext(ctx, `INSERT INTO thread_items
			(thread_id, ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (thread_id, item_id) DO UPDATE SET
			updated_at = excluded.updated_at,
			data = excluded.data`,
		threadID, it.Ordinal, it.ID, string(it.Kind), it.ParentToolUseID, millis(it.CreatedAt), millis(it.UpdatedAt), string(data))
	if err != nil {
		return fmt.Errorf("thread: save item %s of %s: %w", it.ID, threadID, err)
	}
	return nil
}

// deleteItem deletes one item's row (threadLog.dropItem).
func deleteItem(ctx context.Context, db execer, threadID, itemID string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM thread_items WHERE thread_id = ? AND item_id = ?`, threadID, itemID); err != nil {
		return fmt.Errorf("thread: delete item %s of %s: %w", itemID, threadID, err)
	}
	return nil
}

// querier is a *sql.DB or a *sql.Tx.
type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// loadItems returns a thread's items by ordinal (newThreadLog puts placed messages in
// their place).
func loadItems(ctx context.Context, db querier, threadID string) ([]Item, error) {
	return scanItems(ctx, db, threadID, `SELECT ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data
		FROM thread_items WHERE thread_id = ? ORDER BY ordinal`, threadID)
}

// scanItems runs query (columns as loadItems') and decodes its rows.
func scanItems(ctx context.Context, db querier, threadID, query string, args ...any) ([]Item, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("thread: load items of %s: %w", threadID, err)
	}
	defer func() { _ = rows.Close() }()
	var out []Item
	for rows.Next() {
		var ordinal, created, updated int64
		var itemID, kind, parent, data string
		if err := rows.Scan(&ordinal, &itemID, &kind, &parent, &created, &updated, &data); err != nil {
			return nil, fmt.Errorf("thread: load items of %s: %w", threadID, err)
		}
		it, err := decodeItem(itemID, ordinal, kind, parent, created, updated, data)
		if err != nil {
			return nil, fmt.Errorf("thread: load items of %s: %w", threadID, err)
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: load items of %s: %w", threadID, err)
	}
	return out, nil
}

// errBadItem is decodeItem's error for a row whose data cannot be decoded: the row is
// bad, not the database, so a reader that can go on without it (the search backfill, a
// search) skips it.
var errBadItem = errors.New("undecodable item")

// decodeItem is one thread_items row as an item. Its only error wraps errBadItem.
func decodeItem(itemID string, ordinal int64, kind, parent string, created, updated int64, data string) (Item, error) {
	var d itemData
	if err := json.Unmarshal([]byte(data), &d); err != nil {
		return Item{}, fmt.Errorf("item %s: %w: %w", itemID, errBadItem, err)
	}
	it := Item{ID: itemID, Ordinal: ordinal, Kind: ItemKind(kind), ParentToolUseID: parent, CreatedAt: fromMillis(created), UpdatedAt: fromMillis(updated)}
	it.ComposerText = d.Composer
	it.Origin, it.WakeTitle, it.WakeJSON, it.SentBy = MessageOrigin(d.Origin), d.WakeTitle, d.WakeJSON, d.SentBy
	it.NoteCreatedBy, it.ResumeNote, it.SeedPrefix, it.MemoryNote = d.NoteCreatedBy, d.ResumeNote, d.SeedPrefix, d.MemoryNote
	it.Queued, it.PlacedAfter, it.APIError = d.Queued, d.PlacedAfter, d.APIError
	it.Text, it.Attachments, it.Tool, it.Request, it.Turn, it.Compaction = d.Text, d.Attachments, d.Tool, d.Request, d.Turn, d.Compaction
	it.HTML, it.Theme = d.HTML, d.Theme
	return it, nil
}
