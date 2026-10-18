package thread

import (
	"context"
	"database/sql"
	"encoding/json"
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
	NoteCreatedBy string      `json:"note_created_by,omitempty"`
	Tool          *ToolCall   `json:"tool,omitempty"`
	Request       *Request    `json:"request,omitempty"`
	Turn          *TurnEnd    `json:"turn,omitempty"`
	Compaction    *Compaction `json:"compaction,omitempty"`
}

// execer is a *sql.DB or a *sql.Tx.
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// saveItems saves items in one transaction (a fork's copied history: all or none).
func saveItems(ctx context.Context, db *sql.DB, threadID string, items []Item) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("thread: save items of %s: %w", threadID, err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, it := range items {
		if err := saveItem(ctx, tx, threadID, it); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("thread: save items of %s: %w", threadID, err)
	}
	return nil
}

// saveItem inserts or rewrites one item. Streaming items are never saved.
func saveItem(ctx context.Context, db execer, threadID string, it Item) error {
	data, err := json.Marshal(itemData{Text: it.Text, Attachments: it.Attachments, Composer: it.ComposerText,
		Origin: string(it.Origin), WakeTitle: it.WakeTitle, WakeJSON: it.WakeJSON,
		NoteCreatedBy: it.NoteCreatedBy, Tool: it.Tool, Request: it.Request, Turn: it.Turn, Compaction: it.Compaction})
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

// loadItems returns a thread's items by ordinal.
func loadItems(ctx context.Context, db *sql.DB, threadID string) ([]Item, error) {
	rows, err := db.QueryContext(ctx, `SELECT ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data
		FROM thread_items WHERE thread_id = ? ORDER BY ordinal`, threadID)
	if err != nil {
		return nil, fmt.Errorf("thread: load items of %s: %w", threadID, err)
	}
	defer func() { _ = rows.Close() }()
	var out []Item
	for rows.Next() {
		var it Item
		var kind, data string
		var created, updated int64
		if err := rows.Scan(&it.Ordinal, &it.ID, &kind, &it.ParentToolUseID, &created, &updated, &data); err != nil {
			return nil, fmt.Errorf("thread: load items of %s: %w", threadID, err)
		}
		var d itemData
		if err := json.Unmarshal([]byte(data), &d); err != nil {
			return nil, fmt.Errorf("thread: load item %s of %s: %w", it.ID, threadID, err)
		}
		it.Kind, it.CreatedAt, it.UpdatedAt = ItemKind(kind), fromMillis(created), fromMillis(updated)
		it.ComposerText = d.Composer
		it.Origin, it.WakeTitle, it.WakeJSON = MessageOrigin(d.Origin), d.WakeTitle, d.WakeJSON
		it.NoteCreatedBy = d.NoteCreatedBy
		it.Text, it.Attachments, it.Tool, it.Request, it.Turn, it.Compaction = d.Text, d.Attachments, d.Tool, d.Request, d.Turn, d.Compaction
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread: load items of %s: %w", threadID, err)
	}
	return out, nil
}
