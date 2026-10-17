package thread

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Idempotent thread creation (thread.new --request-id; docs/notes/agents-5-cli.md). An
// agent that retries `thread new` after its CLI call timed out must not start a second
// thread: Create with a request id its creator (CreateOptions.CreatedBy, "" for the
// user) used within RequestIDTTL returns the thread made the first time. Keys persist in
// thread_requests (migration 0025) and go with their thread.

// MaxRequestIDLen bounds a request id, in characters.
const MaxRequestIDLen = 128

// RequestIDTTL is how long a request id is remembered.
const RequestIDTTL = 24 * time.Hour

// requests guards the keys being created now: a repeat waits for the first.
type requests struct {
	mu       sync.Mutex
	inflight map[string]chan struct{}
}

// CleanRequestID trims a request id and checks it: at most MaxRequestIDLen characters,
// no control characters. "" means none.
func CleanRequestID(id string) (string, error) {
	id = strings.TrimSpace(id)
	switch {
	case utf8.RuneCountInString(id) > MaxRequestIDLen:
		return "", fmt.Errorf("%w: a request id has at most %d characters", ErrInvalidArgument, MaxRequestIDLen)
	case strings.ContainsFunc(id, unicode.IsControl):
		return "", fmt.Errorf("%w: a request id has no control characters", ErrInvalidArgument)
	}
	return id, nil
}

// CreateOnce is Create keyed by requestID: when o's creator used the key within
// RequestIDTTL and that thread still exists, it returns it with reused set and makes
// nothing. A Create in flight for the key is waited for. An empty key is a plain Create.
func (m *Manager) CreateOnce(ctx context.Context, requestID string, o CreateOptions) (Thread, bool, error) {
	key, err := CleanRequestID(requestID)
	if err != nil || key == "" {
		if err != nil {
			return Thread{}, false, err
		}
		t, err := m.Create(ctx, o)
		return t, false, err
	}
	creator := strings.TrimSpace(o.CreatedBy)
	slot := creator + "\x00" + key
	r := &m.reqs
	for {
		r.mu.Lock()
		if wait, busy := r.inflight[slot]; busy {
			r.mu.Unlock()
			select {
			case <-wait:
				continue
			case <-ctx.Done():
				return Thread{}, false, ctx.Err()
			}
		}
		id, err := lookupRequest(ctx, m.opts.DB, creator, key, m.opts.Now().Add(-RequestIDTTL))
		if err != nil {
			r.mu.Unlock()
			return Thread{}, false, err
		}
		if t, ok := m.Snapshot().Thread(id); ok && id != "" {
			r.mu.Unlock()
			m.log.Info("thread create repeated; returning the thread its request id made", "thread", id, "request_id", key, "created_by", creator)
			return t, true, nil
		}
		if r.inflight == nil {
			r.inflight = make(map[string]chan struct{})
		}
		done := make(chan struct{})
		r.inflight[slot] = done
		r.mu.Unlock()
		defer func() {
			r.mu.Lock()
			delete(r.inflight, slot)
			close(done)
			r.mu.Unlock()
		}()
		break
	}
	t, err := m.Create(ctx, o)
	if err != nil {
		return Thread{}, false, err
	}
	if err := saveRequest(ctx, m.opts.DB, creator, key, t.ID, m.opts.Now(), RequestIDTTL); err != nil {
		m.log.Error("remember the request id of a new thread", "thread", t.ID, "request_id", key, "err", err)
	}
	return t, false, nil
}

// lookupRequest is the thread creator's key made after since; "" when none.
func lookupRequest(ctx context.Context, db *sql.DB, creator, key string, since time.Time) (string, error) {
	var id string
	err := db.QueryRowContext(ctx, `SELECT thread_id FROM thread_requests WHERE creator = ? AND request_id = ? AND created_at >= ?`,
		creator, key, millis(since)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("thread: look up request id: %w", err)
	}
	return id, nil
}

// saveRequest records the key for thread id (replacing an expired one) and prunes keys
// older than ttl.
func saveRequest(ctx context.Context, db *sql.DB, creator, key, id string, now time.Time, ttl time.Duration) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM thread_requests WHERE created_at < ?`, millis(now.Add(-ttl))); err != nil {
		return fmt.Errorf("thread: prune request ids: %w", err)
	}
	_, err := db.ExecContext(ctx, `INSERT INTO thread_requests (creator, request_id, thread_id, created_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (creator, request_id) DO UPDATE SET thread_id = excluded.thread_id, created_at = excluded.created_at`,
		creator, key, id, millis(now))
	if err != nil {
		return fmt.Errorf("thread: save request id: %w", err)
	}
	return nil
}
