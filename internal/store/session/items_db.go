package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

// Persistence for thread_items (migration 0014). data holds the kind's payload.

// itemData is the JSON in thread_items.data.
type itemData struct {
	Text        string      `json:"text,omitempty"`
	Attachments []string    `json:"attachments,omitempty"`
	Composer    string      `json:"composer,omitempty"`
	Tool        *ToolCall   `json:"tool,omitempty"`
	Request     *Request    `json:"request,omitempty"`
	Turn        *TurnEnd    `json:"turn,omitempty"`
	Compaction  *Compaction `json:"compaction,omitempty"`
}

// saveItem inserts or rewrites one item. Streaming items are never saved.
func saveItem(ctx context.Context, db *sql.DB, sessionID string, it Item) error {
	data, err := json.Marshal(itemData{Text: it.Text, Attachments: it.Attachments, Composer: it.ComposerText, Tool: it.Tool, Request: it.Request, Turn: it.Turn, Compaction: it.Compaction})
	if err != nil {
		return fmt.Errorf("session: encode item %s: %w", it.ID, err)
	}
	_, err = db.ExecContext(ctx, `INSERT INTO thread_items
			(session_id, ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (session_id, item_id) DO UPDATE SET
			updated_at = excluded.updated_at,
			data = excluded.data`,
		sessionID, it.Ordinal, it.ID, string(it.Kind), it.ParentToolUseID, millis(it.CreatedAt), millis(it.UpdatedAt), string(data))
	if err != nil {
		return fmt.Errorf("session: save item %s of %s: %w", it.ID, sessionID, err)
	}
	return nil
}

// loadItems returns a thread's items by ordinal.
func loadItems(ctx context.Context, db *sql.DB, sessionID string) ([]Item, error) {
	rows, err := db.QueryContext(ctx, `SELECT ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data
		FROM thread_items WHERE session_id = ? ORDER BY ordinal`, sessionID)
	if err != nil {
		return nil, fmt.Errorf("session: load items of %s: %w", sessionID, err)
	}
	defer func() { _ = rows.Close() }()
	var out []Item
	for rows.Next() {
		var it Item
		var kind, data string
		var created, updated int64
		if err := rows.Scan(&it.Ordinal, &it.ID, &kind, &it.ParentToolUseID, &created, &updated, &data); err != nil {
			return nil, fmt.Errorf("session: load items of %s: %w", sessionID, err)
		}
		var d itemData
		if err := json.Unmarshal([]byte(data), &d); err != nil {
			return nil, fmt.Errorf("session: load item %s of %s: %w", it.ID, sessionID, err)
		}
		it.Kind, it.CreatedAt, it.UpdatedAt = ItemKind(kind), fromMillis(created), fromMillis(updated)
		it.ComposerText = d.Composer
		it.Text, it.Attachments, it.Tool, it.Request, it.Turn, it.Compaction = d.Text, d.Attachments, d.Tool, d.Request, d.Turn, d.Compaction
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: load items of %s: %w", sessionID, err)
	}
	return out, nil
}
