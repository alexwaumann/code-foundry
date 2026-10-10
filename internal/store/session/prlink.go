package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"slices"
	"time"
)

// Linked pull requests (docs/notes/linked-prs.md).
//
// Claude Code writes a "pr-link" record to the session's transcript whenever it sees a
// pull request for the session's repository (one it created, one a subagent created in
// another worktree, one named in a prompt):
//
//	{"type":"pr-link","sessionId":"…","prNumber":5,"prUrl":"https://github.com/o/r/pull/5",
//	 "prRepository":"o/r","timestamp":"2026-10-09T18:24:11.771Z"}
//
// The record is re-emitted at nearly every turn boundary for the rest of the session
// and tracks the latest pull request seen, so it can flip back to an earlier one. A
// session's links are therefore every distinct URL, deduplicated by URL, in first-seen
// order, and never removed.

// LinkedPullRequest is a pull request Claude linked to the session.
type LinkedPullRequest struct {
	Slug     string // "owner/name"
	Number   int
	URL      string
	LinkedAt time.Time // first pr-link record for URL; the time it was seen if absent
}

var quotedPRLink = []byte(`"pr-link"`)

type prLinkRecord struct {
	Type         string `json:"type"`
	PRNumber     int    `json:"prNumber"`
	PRURL        string `json:"prUrl"`
	PRRepository string `json:"prRepository"`
	Timestamp    string `json:"timestamp"`
}

// parsePRLink reads one transcript line. Lines that cannot be a pr-link record are
// rejected by a byte search before any JSON decoding: this runs on every line.
func parsePRLink(line []byte) (LinkedPullRequest, bool) {
	if !bytes.Contains(line, quotedPRLink) {
		return LinkedPullRequest{}, false
	}
	var rec prLinkRecord
	if err := json.Unmarshal(line, &rec); err != nil || rec.Type != "pr-link" {
		return LinkedPullRequest{}, false
	}
	if rec.PRURL == "" || rec.PRNumber <= 0 || rec.PRRepository == "" {
		return LinkedPullRequest{}, false
	}
	l := LinkedPullRequest{Slug: rec.PRRepository, Number: rec.PRNumber, URL: rec.PRURL}
	if ts, err := time.Parse(time.RFC3339Nano, rec.Timestamp); err == nil {
		l.LinkedAt = ts
	}
	return l, true
}

// mergeLinks appends the links in add whose URL is not in cur (nor earlier in add).
// It never writes into cur's backing array: snapshots share it. added is what was new.
func mergeLinks(cur, add []LinkedPullRequest) (merged, added []LinkedPullRequest) {
	for _, l := range add {
		dup := func(x LinkedPullRequest) bool { return x.URL == l.URL }
		if slices.ContainsFunc(cur, dup) || slices.ContainsFunc(added, dup) {
			continue
		}
		added = append(added, l)
	}
	if len(added) == 0 {
		return cur, nil
	}
	return append(slices.Clip(cur), added...), added
}

// scanPRLinks streams the first limit bytes of the transcript at path (all of it when
// limit <= 0) and returns its pr-link records in file order. Lines are split like the
// tailer splits them: over-long lines are skipped, never buffered whole.
func scanPRLinks(path string, limit int64) ([]LinkedPullRequest, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	var r io.Reader = f
	if limit > 0 {
		r = io.LimitReader(f, limit)
	}
	var (
		sp    lineSplitter
		out   []LinkedPullRequest
		lines [][]byte
	)
	buf := make([]byte, tailReadChunk)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			lines = sp.split(lines[:0], buf[:n])
			for _, line := range lines {
				if l, ok := parsePRLink(line); ok {
					out = append(out, l)
				}
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return out, err
		}
	}
	if !sp.skip && len(sp.partial) > 0 { // last line without its newline (yet)
		if l, ok := parsePRLink(sp.partial); ok {
			out = append(out, l)
		}
	}
	return out, nil
}

// linkPullRequests adds the links whose URL the session does not have yet, persists
// them, and publishes the session. Links without a time get now (links is the
// caller's to give up: it is modified). Returns how many
// were new; a repeat of a known URL changes nothing and publishes nothing.
func (m *Manager) linkPullRequests(id string, links []LinkedPullRequest) int {
	if len(links) == 0 {
		return 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return 0
	}
	now := m.opts.Now()
	for i := range links {
		if links[i].LinkedAt.IsZero() {
			links[i].LinkedAt = now
		}
	}
	merged, added := mergeLinks(rec.s.LinkedPullRequests, links)
	if len(added) == 0 {
		return 0
	}
	if err := saveLinks(context.Background(), m.opts.DB, id, added); err != nil {
		m.log.Error("persist linked pull requests", "session", id, "err", err)
	}
	rec.s.LinkedPullRequests = merged
	m.commitLocked(rec, false)
	return len(added)
}
