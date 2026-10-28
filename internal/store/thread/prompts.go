package thread

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Prompt history (docs/notes/prompt-history-1-daemon.md): the prompts the user sent, for
// the composer's recall and the palette. Nothing is stored for it: ListPrompts reads the
// user_message rows of thread_items, newest first, and keeps the user's own.
//
// Left out: wake messages (Origin), messages another thread sent (SentBy: the CLI's
// $CODE_FOUNDRY_THREAD, a created thread's first prompt), subagent messages, and
// messages with nothing but attachments. Threads a plugin owns are never read; hidden
// child threads (InSidebar false) only in THREAD scope or as the PROJECT anchor.
// Archived and snoozed threads count. A run of the same text in one thread is listed
// once, as its newest; a fork's copied history (the same item ids) once, under the
// oldest thread that has it.

// PromptScope is which threads ListPrompts reads.
type PromptScope int

// Prompt scopes.
const (
	// PromptScopeThread: one thread (PromptQuery.ThreadID).
	PromptScopeThread PromptScope = iota + 1
	// PromptScopeProject: the threads whose project set intersects the anchor's
	// (PromptQuery.ThreadID) or PromptQuery.ProjectIDs; an empty set matches the threads
	// without a project.
	PromptScopeProject
	// PromptScopeAll: every thread.
	PromptScopeAll
)

// Prompt list sizes.
const (
	DefaultPromptLimit = 50
	MaxPromptLimit     = 500
)

// PromptQuery is ListPrompts' question.
type PromptQuery struct {
	Scope PromptScope
	// ThreadID: THREAD's thread (required), or PROJECT's anchor (exclusive with
	// ProjectIDs). Ignored for ALL.
	ThreadID string
	// ProjectIDs: PROJECT's project set without an anchor (ids, names, or paths inside a
	// project); none is the set of the threads without a project.
	ProjectIDs []string
	// Query is a case-insensitive substring of the display text; "" for every prompt.
	Query string
	// Limit: at most this many (DefaultPromptLimit when 0 or less, capped at
	// MaxPromptLimit).
	Limit int
}

// SentPrompt is one prompt the user sent.
type SentPrompt struct {
	ThreadID   string
	ThreadName string // the thread's current name; "" when it has none
	ItemID     string
	// Text is the prompt as the composer shows it (promptText); never empty.
	Text string
	// ComposerText is the item's composer text without image and PDF chips; "" when it
	// had none.
	ComposerText string
	SentAt       time.Time
}

// ListPrompts implements Store.
func (m *Manager) ListPrompts(ctx context.Context, q PromptQuery) ([]SentPrompt, error) {
	snap := m.Snapshot()
	threads, err := m.promptThreads(snap, q)
	if err != nil {
		return nil, err
	}
	p := newPromptPicker(threads, snapshotNames(snap), q.Query, q.Limit)
	if len(threads) == 0 {
		return p.out, nil
	}
	only := ""
	if q.Scope == PromptScopeThread {
		only = q.ThreadID
	}
	if err := scanPrompts(ctx, m.opts.DB, only, p.add); err != nil {
		return nil, err
	}
	return p.out, nil
}

// promptThreads is the threads q reads, by id.
func (m *Manager) promptThreads(snap *Snapshot, q PromptQuery) (map[string]Thread, error) {
	out := map[string]Thread{}
	switch q.Scope {
	case PromptScopeThread:
		if q.ThreadID == "" {
			return nil, fmt.Errorf("%w: a thread id is required", ErrInvalidArgument)
		}
		t, ok := snap.Thread(q.ThreadID)
		if !ok {
			return nil, m.notFound(q.ThreadID)
		}
		if t.Owner == "" {
			out[t.ID] = t
		}
		return out, nil
	case PromptScopeProject:
		set, anchor, err := m.promptProjectSet(snap, q)
		if err != nil {
			return nil, err
		}
		show := m.showCreatedThreads()
		for _, t := range snap.Threads {
			if t.ID == anchor.ID && t.Owner == "" {
				out[t.ID] = t // its own composer: shown or not
				continue
			}
			if promptListed(t, show) && sharesProject(t.ProjectIDs, set) {
				out[t.ID] = t
			}
		}
		return out, nil
	case PromptScopeAll:
		show := m.showCreatedThreads()
		for _, t := range snap.Threads {
			if promptListed(t, show) {
				out[t.ID] = t
			}
		}
		return out, nil
	}
	return nil, fmt.Errorf("%w: a scope is required: thread, project or all", ErrInvalidArgument)
}

// promptProjectSet is PROJECT's project set: the anchor's, or q.ProjectIDs resolved.
func (m *Manager) promptProjectSet(snap *Snapshot, q PromptQuery) ([]string, Thread, error) {
	if q.ThreadID != "" {
		if len(q.ProjectIDs) > 0 {
			return nil, Thread{}, fmt.Errorf("%w: a thread id and project ids are exclusive", ErrInvalidArgument)
		}
		t, ok := snap.Thread(q.ThreadID)
		if !ok {
			return nil, Thread{}, m.notFound(q.ThreadID)
		}
		return t.ProjectIDs, t, nil
	}
	var set []string
	for _, ref := range q.ProjectIDs {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		if m.opts.Projects != nil { // without a project store (tests): an id
			r, err := workspace.ResolveProject(m.opts.Projects.Snapshot(), ref)
			if err != nil {
				return nil, Thread{}, listRefError("project", ref, err)
			}
			ref = r.ID
		}
		if !slices.Contains(set, ref) {
			set = append(set, ref)
		}
	}
	return set, Thread{}, nil
}

// promptListed reports whether PROJECT and ALL read t: not a plugin's, and in the
// sidebar (a hidden child's prompts are its creator's).
func promptListed(t Thread, showCreated bool) bool {
	return t.Owner == "" && t.InSidebar(showCreated)
}

// sharesProject reports whether a thread's project set intersects set; an empty set
// matches only an empty set (threads without a project).
func sharesProject(ids, set []string) bool {
	if len(ids) == 0 || len(set) == 0 {
		return len(ids) == 0 && len(set) == 0
	}
	return slices.ContainsFunc(ids, func(id string) bool { return slices.Contains(set, id) })
}

// snapshotNames returns a thread's current name by id.
func snapshotNames(snap *Snapshot) func(string) (string, bool) {
	names := make(map[string]string, len(snap.Threads))
	for _, t := range snap.Threads {
		names[t.ID] = t.Name
	}
	return func(id string) (string, bool) {
		n, ok := names[id]
		return n, ok
	}
}

// promptRow is one user_message row of thread_items.
type promptRow struct {
	threadID, itemID, parentToolUseID string
	createdAt                         time.Time
	text, composer                    string
	origin                            MessageOrigin
	sentBy                            string
}

// scanPrompts calls add with every user_message row, newest first (of thread only when
// set), until add returns false.
func scanPrompts(ctx context.Context, db *sql.DB, thread string, add func(promptRow) bool) error {
	query := `SELECT thread_id, item_id, parent_tool_use_id, created_at, data FROM thread_items
		WHERE kind = ?`
	args := []any{string(KindUserMessage)}
	if thread != "" {
		query += ` AND thread_id = ?`
		args = append(args, thread)
	}
	rows, err := db.QueryContext(ctx, query+` ORDER BY created_at DESC, ordinal DESC`, args...)
	if err != nil {
		return fmt.Errorf("thread: list prompts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var r promptRow
		var created int64
		var data string
		if err := rows.Scan(&r.threadID, &r.itemID, &r.parentToolUseID, &created, &data); err != nil {
			return fmt.Errorf("thread: list prompts: %w", err)
		}
		var d itemData
		if err := json.Unmarshal([]byte(data), &d); err != nil {
			return fmt.Errorf("thread: list prompts: item %s of %s: %w", r.itemID, r.threadID, err)
		}
		r.createdAt, r.text, r.composer, r.origin, r.sentBy = fromMillis(created), d.Text, d.Composer, MessageOrigin(d.Origin), d.SentBy
		if !add(r) {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("thread: list prompts: %w", err)
	}
	return nil
}

// promptPicker selects prompts from rows given newest first. Pure.
type promptPicker struct {
	threads map[string]Thread
	name    func(string) (string, bool)
	query   string
	limit   int
	// last is each thread's newest listed text so far (rows come newest first): an
	// older row with the same text is the same run.
	last map[string]string
	// seen is out's index of each item id (a fork copies its parent's items).
	seen map[string]int
	out  []SentPrompt
}

func newPromptPicker(threads map[string]Thread, name func(string) (string, bool), query string, limit int) *promptPicker {
	if limit <= 0 {
		limit = DefaultPromptLimit
	}
	limit = min(limit, MaxPromptLimit)
	return &promptPicker{threads: threads, name: name, query: strings.ToLower(strings.TrimSpace(query)), limit: limit,
		last: map[string]string{}, seen: map[string]int{}, out: []SentPrompt{}}
}

// full reports whether the list is complete for rows sent before at: once it has limit
// prompts, only a fork's copy of one of them (sent at the same time) still counts.
func (p *promptPicker) full(at time.Time) bool {
	return len(p.out) >= p.limit && at.Before(p.out[len(p.out)-1].SentAt)
}

// add takes the next row; false once nothing older can be listed.
func (p *promptPicker) add(r promptRow) bool {
	if p.full(r.createdAt) {
		return false
	}
	t, ok := p.threads[r.threadID]
	if !ok || r.parentToolUseID != "" || r.origin != OriginUser || r.sentBy != "" {
		return true
	}
	text, composer := promptText(r.text, r.composer, p.name)
	if text == "" || p.last[t.ID] == text {
		return true
	}
	p.last[t.ID] = text
	if i, ok := p.seen[r.itemID]; ok {
		// A fork's copy: listed once, under the oldest thread that has it.
		if kept := p.threads[p.out[i].ThreadID]; t.CreatedAt.Before(kept.CreatedAt) {
			p.out[i].ThreadID, p.out[i].ThreadName = t.ID, t.Name
		}
		return true
	}
	if p.query != "" && !strings.Contains(strings.ToLower(text), p.query) {
		return true
	}
	if len(p.out) >= p.limit {
		return true // sent at the same time as the last one listed
	}
	p.seen[r.itemID] = len(p.out)
	p.out = append(p.out, SentPrompt{ThreadID: t.ID, ThreadName: t.Name, ItemID: r.itemID, Text: text, ComposerText: composer, SentAt: r.createdAt})
	return true
}
