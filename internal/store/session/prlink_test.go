package session

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// testdata/prlink.jsonl is cut from a real transcript (Claude Code, October 2026): the
// first two pr-link records of each run of a number (PRs 5, 6, 7, 9, 10, 11, 12, then a
// flip back to 11, then 13) and a few unrelated small records. 18 pr-link lines, 8 URLs.
func fixtureLines(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "prlink.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(string(data), "\n"), "\n")
}

func ts(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestParsePRLink(t *testing.T) {
	lines := fixtureLines(t)
	tests := []struct {
		name string
		line string
		want LinkedPullRequest
		ok   bool
	}{
		{name: "captured record", line: lines[4], ok: true, want: LinkedPullRequest{
			Slug: "alexwaumann/code-foundry", Number: 5, URL: "https://github.com/alexwaumann/code-foundry/pull/5",
			LinkedAt: ts("2026-10-09T18:24:11.771Z")}},
		{name: "captured record, two digits", line: lines[14], ok: true, want: LinkedPullRequest{
			Slug: "alexwaumann/code-foundry", Number: 10, URL: "https://github.com/alexwaumann/code-foundry/pull/10",
			LinkedAt: ts("2026-10-09T22:22:11.931Z")}},
		{name: "captured unrelated record", line: lines[0]},
		{name: "user text naming the record type",
			line: `{"type":"user","message":{"role":"user","content":"grep for \"pr-link\" records"}}`},
		{name: "malformed json", line: `{"type":"pr-link","prNumber":5,"prUrl":"https://github.com/o/r/pull/5"`},
		{name: "missing url", line: `{"type":"pr-link","prNumber":5,"prRepository":"o/r","timestamp":"2026-10-09T18:24:11.771Z"}`},
		{name: "zero number", line: `{"type":"pr-link","prNumber":0,"prUrl":"https://github.com/o/r/pull/5","prRepository":"o/r"}`},
		{name: "negative number", line: `{"type":"pr-link","prNumber":-1,"prUrl":"https://github.com/o/r/pull/5","prRepository":"o/r"}`},
		{name: "missing repository", line: `{"type":"pr-link","prNumber":5,"prUrl":"https://github.com/o/r/pull/5"}`},
		{name: "number of the wrong type", line: `{"type":"pr-link","prNumber":"5","prUrl":"https://github.com/o/r/pull/5","prRepository":"o/r"}`},
		{name: "no timestamp: zero time", line: `{"type":"pr-link","prNumber":5,"prUrl":"https://github.com/o/r/pull/5","prRepository":"o/r"}`,
			ok: true, want: LinkedPullRequest{Slug: "o/r", Number: 5, URL: "https://github.com/o/r/pull/5"}},
		{name: "bad timestamp: zero time", line: `{"type":"pr-link","prNumber":5,"prUrl":"https://github.com/o/r/pull/5","prRepository":"o/r","timestamp":"yesterday"}`,
			ok: true, want: LinkedPullRequest{Slug: "o/r", Number: 5, URL: "https://github.com/o/r/pull/5"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parsePRLink([]byte(tt.line))
			if ok != tt.ok || got.Slug != tt.want.Slug || got.Number != tt.want.Number || got.URL != tt.want.URL ||
				!got.LinkedAt.Equal(tt.want.LinkedAt) {
				t.Errorf("parsePRLink = %+v, %v; want %+v, %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}

func link(n int) LinkedPullRequest {
	return LinkedPullRequest{Slug: "o/r", Number: n, URL: "https://github.com/o/r/pull/" + string(rune('0'+n))}
}

func TestMergeLinks(t *testing.T) {
	tests := []struct {
		name      string
		cur, add  []LinkedPullRequest
		want      []int
		wantAdded []int
	}{
		{name: "empty"},
		{name: "first links", add: []LinkedPullRequest{link(1), link(2)}, want: []int{1, 2}, wantAdded: []int{1, 2}},
		{name: "repeat of a known url", cur: []LinkedPullRequest{link(1)}, add: []LinkedPullRequest{link(1)}, want: []int{1}},
		{name: "repeats within the batch", add: []LinkedPullRequest{link(1), link(1), link(2), link(1)}, want: []int{1, 2}, wantAdded: []int{1, 2}},
		{name: "flip back keeps first-seen order", cur: []LinkedPullRequest{link(1), link(2)},
			add: []LinkedPullRequest{link(1), link(3)}, want: []int{1, 2, 3}, wantAdded: []int{3}},
	}
	nums := func(ls []LinkedPullRequest) (out []int) {
		for _, l := range ls {
			out = append(out, l.Number)
		}
		return out
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			merged, added := mergeLinks(tt.cur, tt.add)
			if !slices.Equal(nums(merged), tt.want) || !slices.Equal(nums(added), tt.wantAdded) {
				t.Errorf("mergeLinks = %v, %v; want %v, %v", nums(merged), nums(added), tt.want, tt.wantAdded)
			}
		})
	}
	// A snapshot shares cur: spare capacity must not be written.
	cur := make([]LinkedPullRequest, 1, 4)
	cur[0] = link(1)
	spare := cur[:2]
	merged, _ := mergeLinks(cur, []LinkedPullRequest{link(2)})
	if spare[1].URL != "" || len(merged) != 2 || &merged[0] == &cur[0] {
		t.Errorf("mergeLinks wrote into the shared backing array: spare=%+v", spare[1])
	}
}

func TestScanPRLinks(t *testing.T) {
	lines := fixtureLines(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	data := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := scanPRLinks(path, 0)
	if err != nil || len(got) != 18 {
		t.Fatalf("scanPRLinks = %d records, %v", len(got), err)
	}
	merged, _ := mergeLinks(nil, got)
	var nums []int
	for _, l := range merged {
		nums = append(nums, l.Number)
	}
	if !slices.Equal(nums, []int{5, 6, 7, 9, 10, 11, 12, 13}) {
		t.Errorf("distinct links = %v", nums)
	}
	if !merged[0].LinkedAt.Equal(ts("2026-10-09T18:24:11.771Z")) {
		t.Errorf("first link time = %v; want the first record's", merged[0].LinkedAt)
	}

	// limit stops at the tailer's starting offset: through the first #6 record only.
	limit := int64(len(strings.Join(lines[:9], "\n")) + 1)
	got, err = scanPRLinks(path, limit)
	if err != nil || len(got) != 3 || got[2].Number != 6 {
		t.Errorf("scanPRLinks(limit) = %+v, %v", got, err)
	}

	// An over-long line is skipped without losing the records around it, and a last
	// line without its newline is still read.
	var b bytes.Buffer
	b.WriteString(lines[4] + "\n")
	b.WriteString(`{"type":"user","content":"` + strings.Repeat("x", maxLineBytes+10) + `","pr-link":1}` + "\n")
	b.WriteString(lines[8] + "\n")
	b.WriteString(lines[10])
	if err := os.WriteFile(path, b.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = scanPRLinks(path, 0)
	if err != nil || len(got) != 3 || got[0].Number != 5 || got[1].Number != 6 || got[2].Number != 7 {
		t.Errorf("scanPRLinks(long line) = %+v, %v", got, err)
	}

	if _, err := scanPRLinks(filepath.Join(dir, "missing.jsonl"), 0); err == nil {
		t.Error("scanPRLinks(missing) = nil error")
	}
}

func linkNumbers(s Session) []int {
	var out []int
	for _, l := range s.LinkedPullRequests {
		out = append(out, l.Number)
	}
	return out
}

func TestLinkedPullRequestsFromLiveTranscript(t *testing.T) {
	lines := fixtureLines(t)
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "driver"})
	spec, _ := e.terms.Spec(s.TerminalID)
	cid := argOf(spec.Argv, "--session-id")
	e.writeTranscript(cid, userLine("open a pr"))
	e.writeTranscript(cid, lines[:12]...) // through the second #7 record
	got := e.waitFor(s.ID, "links", func(s Session) bool { return len(s.LinkedPullRequests) == 3 })
	if !slices.Equal(linkNumbers(got), []int{5, 6, 7}) || !got.LinkedPullRequests[0].LinkedAt.Equal(ts("2026-10-09T18:24:11.771Z")) ||
		got.LinkedPullRequests[0].Slug != "alexwaumann/code-foundry" {
		t.Errorf("links = %+v", got.LinkedPullRequests)
	}

	// Re-emitted records of known URLs publish nothing.
	for len(e.events.C()) > 0 {
		<-e.events.C()
	}
	e.writeTranscript(cid, lines[10], lines[11], lines[10])
	e.waitFor(s.ID, "repeats fed", func(Session) bool {
		e.det.mu.Lock()
		defer e.det.mu.Unlock()
		return len(e.det.transcript) >= 1+12+3
	})
	e.writeTranscript(cid, userLine("sentinel")) // a later poll: the repeats' batch is done
	e.waitFor(s.ID, "sentinel fed", func(Session) bool {
		e.det.mu.Lock()
		defer e.det.mu.Unlock()
		return slices.Contains(e.det.transcript, userLine("sentinel"))
	})
	for len(e.events.C()) > 0 {
		if u, ok := (<-e.events.C()).(Updated); ok && u.Session.ID == s.ID {
			t.Errorf("repeat published an update: %+v", u.Session.LinkedPullRequests)
		}
	}

	// The rest, with the flip back to #11: appended once, in first-seen order.
	e.writeTranscript(cid, lines[12:]...)
	got = e.waitFor(s.ID, "all links", func(s Session) bool { return len(s.LinkedPullRequests) == 8 })
	if !slices.Equal(linkNumbers(got), []int{5, 6, 7, 9, 10, 11, 12, 13}) {
		t.Errorf("links = %v", linkNumbers(got))
	}

	// Persisted: a restart loads them in the same order.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	e.open()
	after, err := e.m.Get(e.ctx(), s.ID)
	if err != nil || !slices.Equal(linkNumbers(after), []int{5, 6, 7, 9, 10, 11, 12, 13}) ||
		!after.LinkedPullRequests[0].LinkedAt.Equal(ts("2026-10-09T18:24:11.771Z")) {
		t.Errorf("after restart = %+v, %v", after.LinkedPullRequests, err)
	}
}

func TestLinkedPullRequestsBackfillOnReconnect(t *testing.T) {
	lines := fixtureLines(t)
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "driver"})
	spec, _ := e.terms.Spec(s.TerminalID)
	cid := argOf(spec.Argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })
	_ = e.terms.Exit(s.TerminalID, 0)
	e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })

	// History the daemon never saw: written while disconnected, or before pr-link
	// records were read at all.
	e.writeTranscript(cid, lines[:22]...) // through the flip back to #11
	r, err := e.m.Reconnect(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if spec2, _ := e.terms.Spec(r.TerminalID); argOf(spec2.Argv, "--resume") != cid {
		t.Fatalf("reconnect argv = %q", spec2.Argv)
	}
	got := e.waitFor(s.ID, "backfill", func(s Session) bool { return len(s.LinkedPullRequests) == 7 })
	if !slices.Equal(linkNumbers(got), []int{5, 6, 7, 9, 10, 11, 12}) {
		t.Errorf("backfilled = %v", linkNumbers(got))
	}
	// The history stays out of status detection.
	e.det.mu.Lock()
	fed := len(e.det.transcript)
	e.det.mu.Unlock()
	if fed != 1 {
		t.Errorf("detector fed %d lines; want only the first conversation's 1", fed)
	}

	// New records after the resume append after the backfilled ones.
	e.writeTranscript(cid, lines[22:]...)
	got = e.waitFor(s.ID, "live link", func(s Session) bool { return len(s.LinkedPullRequests) == 8 })
	if !slices.Equal(linkNumbers(got), []int{5, 6, 7, 9, 10, 11, 12, 13}) {
		t.Errorf("links = %v", linkNumbers(got))
	}

	// Removing the thread removes its links (ON DELETE CASCADE).
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := e.m.opts.DB.QueryRow(`SELECT count(*) FROM session_pull_requests`).Scan(&n); err != nil || n != 0 {
		t.Errorf("rows after remove = %d, %v", n, err)
	}
}

func TestSaveAndLoadLinks(t *testing.T) {
	e := newEnv(t)
	a := e.connected(CreateOptions{Name: "a"})
	b := e.connected(CreateOptions{Name: "b"})
	ctx := e.ctx()
	db := e.m.opts.DB
	at := ts("2026-10-09T18:24:11.771Z")
	l := func(n int) LinkedPullRequest {
		x := link(n)
		x.LinkedAt = at.Add(time.Duration(n) * time.Second)
		return x
	}
	// Insertion order, not number or time, is the order loaded.
	if err := saveLinks(ctx, db, a.ID, []LinkedPullRequest{l(3), l(1)}); err != nil {
		t.Fatal(err)
	}
	if err := saveLinks(ctx, db, b.ID, []LinkedPullRequest{l(2)}); err != nil {
		t.Fatal(err)
	}
	// A URL the session has is ignored, not an error; the first row wins.
	dup := l(3)
	dup.LinkedAt = at.Add(time.Hour)
	if err := saveLinks(ctx, db, a.ID, []LinkedPullRequest{dup, l(4)}); err != nil {
		t.Fatal(err)
	}
	if err := saveLinks(ctx, db, "s-nope", []LinkedPullRequest{l(1)}); err == nil {
		t.Error("saveLinks for an unknown session = nil error (foreign key)")
	}
	got, err := loadLinks(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	ga := linkNumbers(Session{LinkedPullRequests: got[a.ID]})
	gb := linkNumbers(Session{LinkedPullRequests: got[b.ID]})
	if !slices.Equal(ga, []int{3, 1, 4}) || !slices.Equal(gb, []int{2}) || len(got) != 2 {
		t.Errorf("loadLinks: a=%v b=%v (%d sessions)", ga, gb, len(got))
	}
	if !got[a.ID][0].LinkedAt.Equal(at.Add(3*time.Second)) || got[a.ID][0].Slug != "o/r" || got[a.ID][0].URL != link(3).URL {
		t.Errorf("loaded row = %+v", got[a.ID][0])
	}
	sessions, err := loadSessions(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range sessions {
		if s.ID == a.ID && !slices.Equal(linkNumbers(s), []int{3, 1, 4}) {
			t.Errorf("loadSessions links = %v", linkNumbers(s))
		}
	}
}
