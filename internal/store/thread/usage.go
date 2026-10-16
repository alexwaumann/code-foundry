package thread

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/alexwaumann/code-foundry/internal/pricing"
)

// Session usage (docs/notes/session-usage.md, design in
// docs/sketches/session-usage/DESIGN.md).
//
// Every API response is one or more "assistant" records in the transcript carrying
// message.model and message.usage. A streamed response is written as one record per
// content block, each repeating the same requestId and usage: each requestId counts
// once. Usage is a pure fold over the transcript bytes. The store caches the fold and
// only ever replaces the cached value with a complete fold, never adds to it from a
// partial read: that one invariant makes restarts, resumes and forks safe.

// UsageBucket is the token counters for one model on one UTC day of one session.
type UsageBucket struct {
	Model        string // canonical id as written by Claude: "claude-opus-5-5"
	Tier         string // "" or "long" (Haiku 5.5 prompts over 100K tokens); see internal/pricing
	Speed        string // "" (standard) or "fast"; see internal/pricing
	Day          string // "2026-10-09" (UTC) from the record's timestamp; "unknown" if it had none
	Requests     int64
	Input        int64
	Output       int64 // includes thinking tokens (billed as output)
	CacheRead    int64
	CacheWrite5m int64 // cache_creation.ephemeral_5m_input_tokens
	CacheWrite1h int64 // cache_creation.ephemeral_1h_input_tokens
}

// UnknownDay is the Day of a record without a parsable timestamp.
const UnknownDay = "unknown"

// usageKey is a bucket's identity.
type usageKey struct{ model, tier, speed, day string }

func (b UsageBucket) key() usageKey { return usageKey{b.Model, b.Tier, b.Speed, b.Day} }

// add adds o's counters to b.
func (b *UsageBucket) add(o UsageBucket) {
	b.Requests += o.Requests
	b.Input += o.Input
	b.Output += o.Output
	b.CacheRead += o.CacheRead
	b.CacheWrite5m += o.CacheWrite5m
	b.CacheWrite1h += o.CacheWrite1h
}

// compareBuckets orders buckets by (Day, Model, Tier, Speed).
func compareBuckets(a, b UsageBucket) int {
	return cmp.Or(cmp.Compare(a.Day, b.Day), cmp.Compare(a.Model, b.Model),
		cmp.Compare(a.Tier, b.Tier), cmp.Compare(a.Speed, b.Speed))
}

// SumUsage adds up buckets with the same (Model, Tier, Speed, Day) across lists and
// returns them sorted by (Day, Model, Tier, Speed): a new slice, nil for none. The
// inputs are not modified.
func SumUsage(lists ...[]UsageBucket) []UsageBucket {
	m := map[usageKey]*UsageBucket{}
	for _, l := range lists {
		for _, b := range l {
			if cur, ok := m[b.key()]; ok {
				cur.add(b)
			} else {
				c := b
				m[b.key()] = &c
			}
		}
	}
	return sortedBuckets(m)
}

func sortedBuckets(m map[usageKey]*UsageBucket) []UsageBucket {
	if len(m) == 0 {
		return nil
	}
	out := make([]UsageBucket, 0, len(m))
	for _, b := range m {
		out = append(out, *b)
	}
	slices.SortFunc(out, compareBuckets)
	return out
}

var quotedCacheRead = []byte(`"cache_read_input_tokens"`)

// usageRecord is the subset of an assistant record that usage counting reads.
type usageRecord struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		Model string `json:"model"`
		Usage *struct {
			Speed         string `json:"speed"` // "standard" | "fast"
			Input         int64  `json:"input_tokens"`
			Output        int64  `json:"output_tokens"`
			CacheRead     int64  `json:"cache_read_input_tokens"`
			CacheCreation int64  `json:"cache_creation_input_tokens"`
			Tiers         *struct {
				M5 int64 `json:"ephemeral_5m_input_tokens"`
				H1 int64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`
}

// usageFold accumulates usage records of one transcript. The zero value is ready. A
// fold is per file (the parent transcript now; one per subagent run later), so
// several can be summed with SumUsage.
type usageFold struct {
	// notBefore, when set, skips records timestamped before it. A forked thread's
	// transcript starts with a copy of its parent's records, which were billed to the
	// parent; the copies keep their original times, while the fork's own requests come
	// after the fork was created. (Claude rewrites the copies' sessionId to the fork's,
	// and session_id does not reliably name the requester: docs/notes/session-usage.md.)
	notBefore time.Time

	buckets  map[usageKey]*UsageBucket
	lastReq  string // requestId of the previous counted record: streaming repeats are consecutive
	requests int64  // records counted so far (lets a caller see whether a batch changed anything)
}

// Line folds one transcript line. Lines that cannot carry usage are rejected by a byte
// search before any JSON decoding (same pattern as parsePRLink): this runs on every
// line.
func (f *usageFold) Line(line []byte) {
	if !bytes.Contains(line, quotedCacheRead) {
		return
	}
	var rec usageRecord
	if json.Unmarshal(line, &rec) != nil || rec.Type != "assistant" || rec.Message == nil || rec.Message.Usage == nil {
		return
	}
	if rec.Message.Model == "<synthetic>" || rec.Message.Model == "" {
		return
	}
	ts, tsErr := time.Parse(time.RFC3339Nano, rec.Timestamp)
	if tsErr == nil && ts.Before(f.notBefore) {
		return // a fork's copy of its parent's history
	}
	if rec.RequestID != "" && rec.RequestID == f.lastReq {
		return // streaming repeat
	}
	f.lastReq = rec.RequestID
	u := rec.Message.Usage
	b := UsageBucket{Model: rec.Message.Model, Day: UnknownDay, Requests: 1,
		Input: u.Input, Output: u.Output, CacheRead: u.CacheRead}
	if tsErr == nil {
		b.Day = ts.UTC().Format(time.DateOnly)
	}
	if u.Tiers != nil {
		b.CacheWrite5m, b.CacheWrite1h = u.Tiers.M5, u.Tiers.H1
	} else {
		b.CacheWrite5m = u.CacheCreation
	}
	if u.Speed != "" && u.Speed != "standard" {
		b.Speed = pricing.SpeedFast
	}
	if pricing.HasLongTier(b.Model) &&
		u.Input+u.CacheRead+max(u.CacheCreation, b.CacheWrite5m+b.CacheWrite1h) > pricing.LongPromptTokens {
		b.Tier = pricing.TierLong
	}
	if f.buckets == nil {
		f.buckets = map[usageKey]*UsageBucket{}
	}
	if cur, ok := f.buckets[b.key()]; ok {
		cur.add(b)
	} else {
		f.buckets[b.key()] = &b
	}
	f.requests++
}

// Buckets returns the fold's counters sorted by (Day, Model, Tier, Speed): a new slice,
// nil when nothing was counted.
func (f *usageFold) Buckets() []UsageBucket { return sortedBuckets(f.buckets) }

// setUsage replaces a session's usage, runs and changed sources with a complete
// fold's (threadUsage.snapshot), persists them in one transaction, and publishes the
// session when its usage or runs changed.
func (m *Manager) setUsage(id string, up usageUpdate) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return
	}
	same := slices.Equal(rec.s.Usage, up.total) && sameRuns(rec.s.AgentRuns, up.runs)
	if same && len(up.sources) == 0 {
		return
	}
	var changedRuns []AgentRun
	for _, r := range up.runs {
		i := slices.IndexFunc(rec.s.AgentRuns, func(o AgentRun) bool { return o.ID == r.ID })
		if i < 0 || !sameRunInfo(rec.s.AgentRuns[i], r) {
			changedRuns = append(changedRuns, r)
		}
	}
	if err := saveUsageUpdate(context.Background(), m.opts.DB, id, up, changedRuns); err != nil {
		m.log.Error("persist thread usage", "thread", id, "err", err)
	}
	if same {
		return
	}
	rec.s.Usage, rec.s.AgentRuns = up.total, up.runs
	m.commitLocked(rec, false)
}

// discoverTranscript records that the thread's conversation is now in transcript cid:
// it becomes ClaudeSessionID and, if new, the last of Transcripts (persisted).
func (m *Manager) discoverTranscript(id, cid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return
	}
	rec.s.ClaudeSessionID = cid
	if !slices.Contains(rec.s.Transcripts, cid) {
		if err := saveTranscript(context.Background(), m.opts.DB, id, cid, len(rec.s.Transcripts)); err != nil {
			m.log.Error("persist thread transcript", "thread", id, "err", err)
		}
		rec.s.Transcripts = append(slices.Clip(rec.s.Transcripts), cid)
	}
	m.commitLocked(rec, true)
}
