package thread

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode"
)

// Regenerating a thread's name (docs/notes/regenerate-thread-name.md).
//
// RegenerateName asks the utility model for a title naming the thread's overall task,
// from its first message, its current name and an even sample of its latest turns
// (threadNamingContext), so the name stays the same unless the topic really changed and
// a small follow-up cannot rename the thread after itself. It is an explicit user
// action: it replaces any name, a hand-typed one too, and runs whether or not
// threads.auto_name is on (WithExplicitNaming). The call is synchronous; while it runs
// the published thread carries Naming, which is not persisted. One call per thread at a
// time: a second one while it runs is refused.

// recentTurns is how many of the latest user messages the context covers.
const recentTurns = 6

// Per-block caps of the naming context (clip): the first user message (the original
// task), a later user message, and an assistant block (its text blocks in a row).
const (
	maxFirstMessage   = 1200
	maxUserBlock      = 600
	maxAssistantBlock = 300
	maxNameInContext  = 200 // cleanName's limit
)

// maxNamingContext bounds threadNamingContext in bytes. The per-block caps keep every
// context under it (TestThreadNamingContextBound): name, first message, the left-out
// line and recentTurns user and assistant blocks with their labels.
const maxNamingContext = 8000

// errAlreadyNaming refuses a RegenerateName while another one runs for the thread.
var errAlreadyNaming = fmt.Errorf("%w: the thread's name is already being regenerated", ErrFailedPrecondition)

// explicitNamingKey marks a naming call the user asked for.
type explicitNamingKey struct{}

// WithExplicitNaming returns ctx marking its naming call as one the user asked for
// (RegenerateName): the daemon's namer runs it even with threads.auto_name off.
func WithExplicitNaming(ctx context.Context) context.Context {
	return context.WithValue(ctx, explicitNamingKey{}, true)
}

// ExplicitNaming reports whether ctx is a naming call the user asked for.
func ExplicitNaming(ctx context.Context) bool {
	v, _ := ctx.Value(explicitNamingKey{}).(bool)
	return v
}

// RegenerateName implements Store.
func (m *Manager) RegenerateName(ctx context.Context, id string) (Thread, error) {
	if err := m.refuseResident(id, "renamed"); err != nil {
		return Thread{}, err
	}
	t, _ := m.Snapshot().Thread(id)
	if t.Naming {
		return Thread{}, errAlreadyNaming
	}
	snap, err := m.Items(ctx, id)
	if err != nil {
		return Thread{}, err
	}
	conv := threadNamingContext(t.Name, t.NameProvisional, snap.Items)
	if conv == "" {
		return Thread{}, fmt.Errorf("%w: nothing to name yet (the thread has no message)", ErrFailedPrecondition)
	}

	// The flag on, under the lock again: another call may have started meanwhile.
	m.mu.Lock()
	rec, err := m.record(id)
	if err == nil && rec.s.Naming {
		err = errAlreadyNaming
	}
	if err == nil && m.closed {
		err = ErrClosed
	}
	if err != nil {
		m.mu.Unlock()
		return Thread{}, err
	}
	// A first-prompt naming call that has not started never will: this one wins.
	rec.namingTried = true
	rec.s.Naming = true
	m.commitLocked(rec, false)
	m.wg.Add(1)
	m.mu.Unlock()
	defer m.wg.Done()

	start := time.Now()
	n, err := m.regenerateCall(ctx, id, NamingRequest{Conversation: conv})
	if err == nil && n.Title == "" {
		err = fmt.Errorf("the utility model gave no title")
	}
	var title string
	if err == nil {
		title, err = cleanName(n.Title, false)
	}
	s, ok := m.update(id, err == nil, func(rec *record) {
		rec.s.Naming = false
		if err == nil {
			rec.s.Name, rec.s.AutoNamed, rec.s.NameProvisional, rec.namingTried = title, true, false, true
		}
	})
	if !ok {
		return Thread{}, classified{kind: ErrNotFound, err: fmt.Errorf("thread %s was removed while it was being named", id)}
	}
	if err != nil {
		m.log.Warn("regenerating the thread name failed", "thread", id, "err", err)
		return Thread{}, fmt.Errorf("regenerate the thread name: %w", err)
	}
	m.log.Info("thread name regenerated", "thread", id, "name", title, "took", time.Since(start).Round(time.Millisecond).String())
	return s, nil
}

// regenerateCall runs the namer for an explicit naming call, bounded by NamingTimeout,
// the caller's ctx and the store's (callNamer).
func (m *Manager) regenerateCall(ctx context.Context, id string, req NamingRequest) (Naming, error) {
	ctx, cancel := context.WithTimeout(WithExplicitNaming(withNamingThread(ctx, id)), m.opts.NamingTimeout)
	defer cancel()
	stop := context.AfterFunc(m.ctx, cancel)
	defer stop()
	return m.callNamer(ctx, id, req)
}

// threadNamingContext renders a thread for a naming call that names it again
// (RegenerateName, Move), so the title says the thread's overall task:
//
//	Current name: <name>          (when it has one that is not provisional)
//
//	User: <the first user message> (the original task)
//
//	(<n> user messages left out)   (when the recent turns do not reach it)
//
//	User: … / Assistant: …        (the last recentTurns user messages and the
//	                               assistant text after each, oldest first)
//
// The first user message is there once, also when it is one of the recent ones. An
// assistant's text blocks in a row join into one block. Each block is cut on its own
// (clip: its head and its end around "…") to maxFirstMessage, maxUserBlock or
// maxAssistantBlock bytes, so one long reply cannot crowd out the rest; the caps keep the
// whole under maxNamingContext. Left out: wakes (a user message with a WakeTitle),
// subagents' items, API error messages and every other kind (tool calls, thinking,
// notes, command output, compaction). "" when there is no user message.
func threadNamingContext(name string, provisional bool, items []Item) string {
	type block struct {
		role string
		text []string
	}
	var blocks []block
	users := 0
	for _, it := range items {
		if it.ParentToolUseID != "" {
			continue
		}
		text := strings.TrimSpace(it.Text)
		if text == "" {
			continue
		}
		switch {
		case it.Kind == KindUserMessage && it.WakeTitle == "":
			blocks = append(blocks, block{role: "User", text: []string{text}})
			users++
		case it.Kind == KindAssistantText && !it.APIError:
			if users == 0 {
				continue // a reply before any user message (a fork's or a wake's)
			}
			if last := &blocks[len(blocks)-1]; last.role == "Assistant" {
				last.text = append(last.text, text)
			} else {
				blocks = append(blocks, block{role: "Assistant", text: []string{text}})
			}
		}
	}
	if users == 0 {
		return ""
	}
	// blocks[0] is the first user message: an assistant block needs one before it.
	// The recent turns start at the recentTurns-th user message from the end.
	first, seen := 0, 0
	for i := len(blocks) - 1; i >= 0; i-- {
		if blocks[i].role == "User" {
			if seen++; seen == recentTurns {
				first = i
				break
			}
		}
	}
	const sep = "\n\n"
	var out []string
	if n := strings.TrimSpace(name); n != "" && !provisional {
		out = append(out, "Current name: "+cutUTF8(n, maxNameInContext))
	}
	render := func(b block, max int) string {
		return b.role + ": " + clip(strings.Join(b.text, sep), max)
	}
	if first > 0 {
		out = append(out, render(blocks[0], maxFirstMessage))
		if skipped := users - recentTurns - 1; skipped > 0 {
			out = append(out, fmt.Sprintf("(%d user messages left out)", skipped))
		}
	}
	for i := first; i < len(blocks); i++ {
		max := maxAssistantBlock
		switch {
		case i == 0:
			max = maxFirstMessage
		case blocks[i].role == "User":
			max = maxUserBlock
		}
		out = append(out, render(blocks[i], max))
	}
	return strings.Join(out, sep)
}

// clip is s in at most n bytes: whole when it fits, else its head and its end around
// "…" (two thirds head), cut at rune boundaries. The head keeps the ask or the plan,
// the end keeps a question after pasted text or a reply's conclusion.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	room := n - len("…")
	head := strings.TrimRightFunc(cutUTF8(s, room*2/3), unicode.IsSpace)
	return head + "…" + strings.TrimLeftFunc(outputTail(s, room-len(head)), unicode.IsSpace)
}
