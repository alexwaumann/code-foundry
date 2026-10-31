package thread

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Regenerating a thread's name (docs/notes/regenerate-thread-name.md).
//
// RegenerateName asks the naming model for a title from the thread's most recent turns
// (recentTurnsContext), so the name says what the thread is doing now rather than what
// it was first asked. It is an explicit user action: it replaces any name, a hand-typed
// one too, and runs whether or not threads.auto_name is on (WithExplicitNaming). The
// call is synchronous; while it runs the published thread carries Naming, which is not
// persisted. One call per thread at a time: a second one while it runs is refused.

// recentTurns is how many of the latest user messages the context covers.
const recentTurns = 3

// maxRecentTurnsContext bounds the context in bytes; the newest text is kept.
const maxRecentTurnsContext = 4000

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
	if t, ok := m.Snapshot().Thread(id); ok && t.Naming {
		return Thread{}, errAlreadyNaming
	}
	snap, err := m.Items(ctx, id)
	if err != nil {
		return Thread{}, err
	}
	conv := recentTurnsContext(snap.Items)
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
		err = fmt.Errorf("the naming model gave no title")
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
// the caller's ctx and the store's, retrying once after NamingRetryDelay when the
// failure looks like a rate limit (as startSlug does).
func (m *Manager) regenerateCall(ctx context.Context, id string, req NamingRequest) (Naming, error) {
	ctx, cancel := context.WithTimeout(WithExplicitNaming(withNamingThread(ctx, id)), m.opts.NamingTimeout)
	defer cancel()
	stop := context.AfterFunc(m.ctx, cancel)
	defer stop()
	n, err := m.opts.Namer(ctx, req)
	if isRateLimit(err) {
		m.log.Info("naming rate limited; retrying once", "thread", id, "err", err)
		t := time.NewTimer(m.opts.NamingRetryDelay)
		select {
		case <-t.C:
			n, err = m.opts.Namer(ctx, req)
		case <-ctx.Done():
			t.Stop()
		}
	}
	return n, err
}

// recentTurnsContext renders the thread's most recent turns for a naming call: its last
// recentTurns user messages and the assistant text after each, oldest first, as
// "User: …" and "Assistant: …" blocks (an assistant's text blocks in a row joined into
// one). Wakes (a user message with a WakeTitle), subagents' items, API error messages
// and every other kind (tool calls, thinking, notes, command output, compaction) are left
// out. Over maxRecentTurnsContext bytes the newest text is kept: the oldest blocks go,
// and the oldest one kept loses its start ("…" marks the cut). "" when there is no user
// message.
func recentTurnsContext(items []Item) string {
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
	// From the recentTurns-th user message from the end.
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
	var kept []string
	room := maxRecentTurnsContext
	for i := len(blocks) - 1; i >= first; i-- {
		label := blocks[i].role + ": "
		body := strings.Join(blocks[i].text, sep)
		need := len(label) + len(body)
		if len(kept) > 0 {
			need += len(sep)
		}
		if need <= room {
			kept = append(kept, label+body)
			room -= need
			continue
		}
		// The oldest block kept: its end, as much as fits after the label and "…".
		avail := room - len(label) - len("…")
		if len(kept) > 0 {
			avail -= len(sep)
		}
		if avail > 0 {
			kept = append(kept, label+"…"+tail(body, avail))
		}
		break
	}
	for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
		kept[i], kept[j] = kept[j], kept[i]
	}
	return strings.Join(kept, sep)
}

// tail is the end of s in at most n bytes, starting at a rune boundary.
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	i := len(s) - n
	for i < len(s) && !utf8.RuneStart(s[i]) {
		i++
	}
	return s[i:]
}
