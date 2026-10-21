package thread

import "encoding/json"

// The first message, persisted until Claude has it (docs/notes/ember-fixes-2-wakes.md,
// e10-2 of the 2026-10-21 battle test). Create's prompt goes out only once Claude
// answers its handshake; a daemon stop in that window (a second or two) used to lose it,
// and the worker came back after the restart with nothing but its brief. So Create puts
// it on the row (Thread.PendingFirst, threads.pending_first, migration 0045) before
// claude starts, and every spawn delivers a pending first message before anything else:
// the next start after a stop (a send, a wake, a reconnect) hands it to Claude first,
// then the message that started it. It is cleared once it went out (sendMessage), and
// when the process ended for any reason but the daemon's stop (a start that failed, a
// close or archive while starting: as before, the prompt goes with it). A stop or a
// daemon death that leaves one undelivered logs a WARN.

// PendingFirst is a first message Claude does not have yet.
type PendingFirst struct {
	// Text and Composer are the item's (as typed, the composer's); Prompt what Claude
	// gets (file and thread references rewritten, attachment lines).
	Text        string            `json:"text"`
	Composer    string            `json:"composer,omitempty"`
	Prompt      string            `json:"prompt"`
	Attachments []firstAttachment `json:"attachments,omitempty"`
	// ItemID is the user item's id once it is in the timeline (a message queued behind
	// it, or a start for a message, wrote it first); "" before.
	ItemID string `json:"item_id,omitempty"`
}

type firstAttachment struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	PDF   bool   `json:"pdf,omitempty"`
	Pages int    `json:"pages,omitempty"`
	Exact bool   `json:"exact,omitempty"`
}

// pendingFirstOf is o as a pending first message.
func pendingFirstOf(o *outgoing) *PendingFirst {
	p := &PendingFirst{Text: o.text, Composer: o.composer, Prompt: o.prompt, ItemID: o.itemID}
	for _, a := range o.attachments {
		p.Attachments = append(p.Attachments, firstAttachment{Path: a.path, Size: a.size, PDF: a.pdf, Pages: a.pages, Exact: a.exact})
	}
	return p
}

// outgoing is p as the message a spawn delivers first; first marks it, so sendMessage
// clears the row's once it went out.
func (p *PendingFirst) outgoing() *outgoing {
	o := &outgoing{text: p.Text, composer: p.Composer, prompt: p.Prompt, itemID: p.ItemID, first: true}
	for _, a := range p.Attachments {
		o.attachments = append(o.attachments, attachment{path: a.Path, size: a.Size, pdf: a.PDF, pages: a.Pages, exact: a.Exact})
	}
	return o
}

// pendingFirstJSON is the pending_first column: "" for none.
func pendingFirstJSON(p *PendingFirst) string {
	if p == nil {
		return ""
	}
	b, err := json.Marshal(p)
	if err != nil {
		return "" // plain strings and numbers: never happens
	}
	return string(b)
}

// parsePendingFirst reads the pending_first column; empty or malformed is none.
func parsePendingFirst(col string) *PendingFirst {
	if col == "" {
		return nil
	}
	var p PendingFirst
	if json.Unmarshal([]byte(col), &p) != nil {
		return nil
	}
	return &p
}

// setPendingFirstItem records the item id of thread id's pending first message once its
// item is in the timeline, so the next start does not write a second one.
func (m *Manager) setPendingFirstItem(id, itemID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || rec.s.PendingFirst == nil || rec.s.PendingFirst.ItemID == itemID {
		return
	}
	p := *rec.s.PendingFirst
	p.ItemID = itemID
	rec.s.PendingFirst = &p
	m.commitLocked(rec, true)
}

// clearPendingFirst forgets thread id's pending first message: it went out.
func (m *Manager) clearPendingFirst(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || rec.s.PendingFirst == nil {
		return
	}
	rec.s.PendingFirst = nil
	m.commitLocked(rec, true)
}

// firstMessages are the messages a spawn delivers once Claude answers its handshake:
// the thread's pending first message, then the one that started it (startStopped's).
func firstMessages(s Thread, started *outgoing) []*outgoing {
	var out []*outgoing
	if s.PendingFirst != nil {
		out = append(out, s.PendingFirst.outgoing())
	}
	if started != nil {
		out = append(out, started)
	}
	return out
}
