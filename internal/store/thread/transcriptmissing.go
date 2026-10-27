package thread

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Threads whose transcript is gone (docs/notes/transcript-deleted.md). Claude Code
// deletes transcripts older than its cleanupPeriodDays setting (30 days by default). A
// thread whose conversation was saved (ClaudeSessionID: set only once its transcript was
// seen) cannot resume it then, and a new conversation in its place would be a different
// thread under the old one's name and history: its start is refused
// (ErrTranscriptMissing) and Thread.TranscriptMissing tells clients. A reseed is the one
// route that starts over (FreshStart); archive and remove work as ever. A resident thread
// (Ember) starts a new conversation as before: it reseeds every epoch anyway.

// TranscriptMissingMessage is what a refused start says, the CLI's words too.
const TranscriptMissingMessage = "Claude Code deleted this thread's transcript (its cleanupPeriodDays setting, " +
	"30 days by default), so the conversation cannot continue. This is a Claude Code setting, not a Code Foundry one."

// ErrTranscriptMissing is the error of a start, fork or Claude query refused because the
// thread's transcript is gone.
var ErrTranscriptMissing = fmt.Errorf("%w: %s", ErrFailedPrecondition, TranscriptMissingMessage)

// needsTranscript reports whether s's next start resumes a saved conversation, which a
// missing transcript refuses.
func (s Thread) needsTranscript() bool {
	return s.ClaudeSessionID != "" && !s.FreshStart && s.Kind != KindResident
}

// transcriptGone reports whether s needs its transcript and it is not on disk. A miss
// globs every project dir (transcriptPath): called on a stop or a start, never per
// snapshot.
func (m *Manager) transcriptGone(s Thread) bool {
	if !s.needsTranscript() {
		return false
	}
	_, ok := m.opts.Paths.transcriptPath(s.WorktreePath, s.ClaudeSessionID)
	return !ok
}

// transcriptIndex answers transcriptGone for every thread at daemon start with at most
// one glob: the first miss of a direct path lists every project dir's transcripts.
type transcriptIndex struct {
	paths ClaudePaths
	ids   map[string]bool // nil until the first miss
}

func (x *transcriptIndex) gone(s Thread) bool {
	if !s.needsTranscript() {
		return false
	}
	if _, err := os.Stat(filepath.Join(x.paths.projectDir(s.WorktreePath), s.ClaudeSessionID+".jsonl")); err == nil {
		return false
	}
	if x.ids == nil {
		x.ids = map[string]bool{}
		matches, _ := filepath.Glob(filepath.Join(x.paths.Dir, "projects", "*", "*.jsonl"))
		for _, p := range matches {
			x.ids[strings.TrimSuffix(filepath.Base(p), ".jsonl")] = true
		}
	}
	return !x.ids[s.ClaudeSessionID]
}

// refuseStart ends a reserved start that resumeLaunch refused for a missing transcript:
// nothing was made or written, so the thread is stopped again with the status it had,
// flagged.
func (m *Manager) refuseStart(id string, prev Thread) {
	m.log.Warn("conversation cannot continue: Claude Code deleted its transcript", "thread", id, "claude_session_id", prev.ClaudeSessionID)
	m.update(id, false, func(r *record) {
		r.release()
		r.first = nil
		r.s.State = StateDisconnected
		r.s.Status, r.s.StatusReason, r.s.StatusChangedAt = prev.Status, prev.StatusReason, prev.StatusChangedAt
		r.s.TranscriptMissing = true
	})
}

// refuseTranscriptMissing is ErrTranscriptMissing for a stopped thread flagged
// TranscriptMissing whose transcript is still gone; nil otherwise (a transcript put back
// clears the flag). Send and the queries that would start Claude ask it first, so a
// refused message leaves nothing behind.
func (m *Manager) refuseTranscriptMissing(id string) error {
	s, ok := m.Snapshot().Thread(id)
	if !ok || !s.TranscriptMissing || s.State != StateDisconnected {
		return nil
	}
	if m.transcriptGone(s) {
		return ErrTranscriptMissing
	}
	m.setTranscriptMissing(id, s.ClaudeSessionID, false)
	return nil
}

// setTranscriptMissing records a check of conversation cid on thread id, when the thread
// is still stopped on it.
func (m *Manager) setTranscriptMissing(id, cid string, missing bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || rec.run != nil || rec.reserved != nil || rec.s.State != StateDisconnected ||
		rec.s.ClaudeSessionID != cid || rec.s.TranscriptMissing == missing {
		return
	}
	rec.s.TranscriptMissing = missing
	m.commitLocked(rec, false)
}
