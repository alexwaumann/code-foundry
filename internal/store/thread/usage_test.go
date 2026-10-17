package thread

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// testdata/usage.jsonl is cut from real transcripts (Claude Code, October 2026), every
// record stripped to type, requestId, timestamp, sessionId and message.{model, id,
// usage} (usage kept whole, content dropped):
//
//	0 a user record
//	1, 2 one claude-opus-5-5 response streamed as two records (same requestId and usage)
//	3 claude-haiku-4-5-20251001 (a dated id)
//	4 claude-haiku-5-5, prompt under 100K tokens
//	5 claude-sonnet-5-5
//	6 a <synthetic> record (zero tokens, no requestId)
func usageLines(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "usage.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(string(data), "\n"), "\n")
}

// usageLine is a minimal assistant record. cache is the cache_creation object's JSON,
// or "" to leave it out; speed "" leaves usage.speed out.
func usageLine(req, ts, sid, model string, in, out, read, create int64, cache, speed string) string {
	u := fmt.Sprintf(`"input_tokens":%d,"output_tokens":%d,"cache_read_input_tokens":%d,"cache_creation_input_tokens":%d`,
		in, out, read, create)
	if cache != "" {
		u += `,"cache_creation":` + cache
	}
	if speed != "" {
		u += `,"speed":"` + speed + `"`
	}
	return fmt.Sprintf(`{"type":"assistant","requestId":%q,"timestamp":%q,"sessionId":%q,"message":{"model":%q,"usage":{%s}}}`,
		req, ts, sid, model, u)
}

func h1(n int64) string {
	return fmt.Sprintf(`{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":%d}`, n)
}

func TestUsageFoldLine(t *testing.T) {
	c := usageLines(t)
	const day = "2026-10-09T12:00:00.000Z"
	opus := UsageBucket{Model: "claude-opus-5-5", Day: "2026-10-06", Requests: 1, Input: 2, Output: 199, CacheRead: 27402, CacheWrite1h: 748}
	tests := []struct {
		name      string
		notBefore time.Time
		lines     []string
		want      []UsageBucket
	}{
		{name: "captured user record", lines: c[:1]},
		{name: "captured streamed response counts once", lines: c[1:3], want: []UsageBucket{opus}},
		{name: "captured dated id is kept as written", lines: c[3:4], want: []UsageBucket{
			{Model: "claude-haiku-4-5-20251001", Day: "2026-10-07", Requests: 1, Input: 10, Output: 39, CacheRead: 13898, CacheWrite1h: 8425}}},
		{name: "captured haiku 5.5 under 100K is the base tier", lines: c[4:5], want: []UsageBucket{
			{Model: "claude-haiku-5-5", Day: "2026-10-09", Requests: 1, Input: 2, Output: 298, CacheRead: 23836, CacheWrite1h: 11441}}},
		{name: "captured synthetic record", lines: c[6:7]},
		{name: "captured transcript, sorted by day then model", lines: c, want: []UsageBucket{
			{Model: "claude-opus-5-5", Day: "2026-10-06", Requests: 1, Input: 2, Output: 199, CacheRead: 27402, CacheWrite1h: 748},
			{Model: "claude-sonnet-5-5", Day: "2026-10-06", Requests: 1, Input: 2, Output: 220, CacheRead: 11818, CacheWrite1h: 9713},
			{Model: "claude-haiku-4-5-20251001", Day: "2026-10-07", Requests: 1, Input: 10, Output: 39, CacheRead: 13898, CacheWrite1h: 8425},
			{Model: "claude-haiku-5-5", Day: "2026-10-09", Requests: 1, Input: 2, Output: 298, CacheRead: 23836, CacheWrite1h: 11441},
		}},
		{name: "same model and day add up", lines: []string{
			usageLine("r1", day, "", "claude-opus-5", 1, 10, 100, 5, h1(5), "standard"),
			usageLine("r2", day, "", "claude-opus-5", 2, 20, 200, 7, `{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":4}`, "standard"),
		}, want: []UsageBucket{{Model: "claude-opus-5", Day: "2026-10-09", Requests: 2, Input: 3, Output: 30, CacheRead: 300, CacheWrite5m: 3, CacheWrite1h: 9}}},
		{name: "repeat only when consecutive", lines: []string{
			usageLine("r1", day, "", "claude-opus-5", 1, 0, 0, 0, h1(0), ""),
			usageLine("r2", day, "", "claude-opus-5", 1, 0, 0, 0, h1(0), ""),
			usageLine("r1", day, "", "claude-opus-5", 1, 0, 0, 0, h1(0), ""),
		}, want: []UsageBucket{{Model: "claude-opus-5", Day: "2026-10-09", Requests: 3, Input: 3}}},
		{name: "records without a requestId each count", lines: []string{
			usageLine("", day, "", "claude-opus-5", 1, 0, 0, 0, h1(0), ""),
			usageLine("", day, "", "claude-opus-5", 1, 0, 0, 0, h1(0), ""),
		}, want: []UsageBucket{{Model: "claude-opus-5", Day: "2026-10-09", Requests: 2, Input: 2}}},
		{name: "no cache_creation object: the total is 5m", lines: []string{
			usageLine("r1", day, "", "claude-opus-5", 0, 0, 0, 640, "", ""),
		}, want: []UsageBucket{{Model: "claude-opus-5", Day: "2026-10-09", Requests: 1, CacheWrite5m: 640}}},
		{name: "haiku 5.5 over 100K is the long tier", lines: []string{
			usageLine("r1", day, "", "claude-haiku-5-5", 2, 5, 90000, 20000, h1(20000), ""),
		}, want: []UsageBucket{{Model: "claude-haiku-5-5", Tier: "long", Day: "2026-10-09", Requests: 1, Input: 2, Output: 5, CacheRead: 90000, CacheWrite1h: 20000}}},
		{name: "haiku 5.5 at exactly 100K is the base tier", lines: []string{
			usageLine("r1", day, "", "claude-haiku-5-5", 0, 0, 80000, 20000, h1(20000), ""),
		}, want: []UsageBucket{{Model: "claude-haiku-5-5", Day: "2026-10-09", Requests: 1, CacheRead: 80000, CacheWrite1h: 20000}}},
		{name: "long tier counts a cache write without the tier object", lines: []string{
			usageLine("r1", day, "", "claude-haiku-5-5", 1, 0, 0, 100000, "", ""),
		}, want: []UsageBucket{{Model: "claude-haiku-5-5", Tier: "long", Day: "2026-10-09", Requests: 1, Input: 1, CacheWrite5m: 100000}}},
		{name: "other models have no tier", lines: []string{
			usageLine("r1", day, "", "claude-opus-5-5", 1, 0, 200000, 0, h1(0), ""),
		}, want: []UsageBucket{{Model: "claude-opus-5-5", Day: "2026-10-09", Requests: 1, Input: 1, CacheRead: 200000}}},
		{name: "speed: standard, absent, fast and anything else", lines: []string{
			usageLine("r1", day, "", "claude-opus-5-5", 1, 0, 0, 0, h1(0), "standard"),
			usageLine("r2", day, "", "claude-opus-5-5", 1, 0, 0, 0, h1(0), ""),
			usageLine("r3", day, "", "claude-opus-5-5", 1, 0, 0, 0, h1(0), "fast"),
			usageLine("r4", day, "", "claude-opus-5-5", 1, 0, 0, 0, h1(0), "priority"),
		}, want: []UsageBucket{
			{Model: "claude-opus-5-5", Day: "2026-10-09", Requests: 2, Input: 2},
			{Model: "claude-opus-5-5", Speed: "fast", Day: "2026-10-09", Requests: 2, Input: 2},
		}},
		{name: "day is the UTC date", lines: []string{
			usageLine("r1", "2026-10-09T23:30:00-05:00", "", "claude-opus-5", 1, 0, 0, 0, h1(0), ""),
		}, want: []UsageBucket{{Model: "claude-opus-5", Day: "2026-10-10", Requests: 1, Input: 1}}},
		{name: "unparsable timestamp", lines: []string{
			usageLine("r1", "yesterday", "", "claude-opus-5", 1, 0, 0, 0, h1(0), ""),
		}, want: []UsageBucket{{Model: "claude-opus-5", Day: "unknown", Requests: 1, Input: 1}}},
		// A fork's copy of its parent's history keeps the original times; its sessionId
		// is the fork's (as Claude Code 2.1.296 writes it), so ids do not tell them apart.
		{name: "a fork's copied parent records are skipped by time", notBefore: ts(day), lines: []string{
			usageLine("r1", "2026-10-09T11:59:59.999Z", "child", "claude-opus-5", 1, 0, 0, 0, h1(0), ""),
			usageLine("r2", day, "child", "claude-opus-5", 2, 0, 0, 0, h1(0), ""),
			usageLine("r3", "2026-10-09T13:00:00Z", "child", "claude-opus-5", 4, 0, 0, 0, h1(0), ""),
			usageLine("r4", "yesterday", "child", "claude-opus-5", 8, 0, 0, 0, h1(0), ""),
		}, want: []UsageBucket{
			{Model: "claude-opus-5", Day: "2026-10-09", Requests: 2, Input: 6},
			{Model: "claude-opus-5", Day: "unknown", Requests: 1, Input: 8},
		}},
		{name: "no cutoff when not a fork", lines: []string{
			usageLine("r1", "2020-01-01T00:00:00Z", "parent", "claude-opus-5", 1, 0, 0, 0, h1(0), ""),
			usageLine("r2", day, "child", "claude-opus-5", 2, 0, 0, 0, h1(0), ""),
		}, want: []UsageBucket{
			{Model: "claude-opus-5", Day: "2020-01-01", Requests: 1, Input: 1},
			{Model: "claude-opus-5", Day: "2026-10-09", Requests: 1, Input: 2},
		}},
		{name: "not an assistant record", lines: []string{
			strings.Replace(usageLine("r1", day, "", "claude-opus-5", 1, 0, 0, 0, h1(0), ""), `"assistant"`, `"user"`, 1),
		}},
		{name: "user text naming the field", lines: []string{
			`{"type":"user","message":{"role":"user","content":"what is \"cache_read_input_tokens\"?"}}`,
		}},
		{name: "assistant record without usage", lines: []string{
			`{"type":"assistant","requestId":"r1","message":{"model":"claude-opus-5","content":"cache_read_input_tokens"}}`,
		}},
		{name: "malformed json", lines: []string{
			usageLine("r1", day, "", "claude-opus-5", 1, 0, 0, 0, h1(0), "")[:80] + `"cache_read_input_tokens"`,
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := usageFold{notBefore: tt.notBefore}
			for _, l := range tt.lines {
				f.Line([]byte(l))
			}
			if got := f.Buckets(); !slices.Equal(got, tt.want) {
				t.Errorf("Buckets =\n%+v\nwant\n%+v", got, tt.want)
			}
		})
	}
}

// A fold of a prefix read by scanLines, continued with the lines after it, is the
// fold of the whole file: what backfill plus the tailer compute on a resume.
func TestUsageRescanPlusLiveIsWholeFold(t *testing.T) {
	c := usageLines(t)
	path := filepath.Join(t.TempDir(), "t.jsonl")
	data := strings.Join(c, "\n") + "\n"
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	var whole usageFold
	if err := scanLines(path, 0, whole.Line); err != nil {
		t.Fatal(err)
	}
	for cut := range len(c) + 1 {
		var f usageFold
		limit := int64(len(strings.Join(c[:cut], "\n")))
		if cut > 0 {
			limit++
		}
		if err := scanLines(path, max(limit, 1), f.Line); err != nil {
			t.Fatal(err)
		}
		if cut == 0 {
			f = usageFold{} // limit 0 means the whole file; a resume with nothing skipped has no rescan
		}
		for _, l := range c[cut:] {
			f.Line([]byte(l))
		}
		if !slices.Equal(f.Buckets(), whole.Buckets()) {
			t.Errorf("cut at %d: %+v; want %+v", cut, f.Buckets(), whole.Buckets())
		}
	}
	if whole.requests != 4 {
		t.Errorf("whole fold counted %d requests; want 4", whole.requests)
	}
}

func TestSumBuckets(t *testing.T) {
	a := []UsageBucket{{Model: "m", Day: "2026-10-09", Requests: 1, Input: 1, Output: 2, CacheRead: 3, CacheWrite5m: 4, CacheWrite1h: 5}}
	b := []UsageBucket{
		{Model: "m", Day: "2026-10-09", Requests: 2, Input: 10, Output: 20, CacheRead: 30, CacheWrite5m: 40, CacheWrite1h: 50},
		{Model: "m", Day: "2026-10-08", Requests: 1},
		{Model: "m", Tier: "long", Day: "2026-10-09", Requests: 1},
	}
	got := SumUsage(a, b)
	want := []UsageBucket{
		{Model: "m", Day: "2026-10-08", Requests: 1},
		{Model: "m", Day: "2026-10-09", Requests: 3, Input: 11, Output: 22, CacheRead: 33, CacheWrite5m: 44, CacheWrite1h: 55},
		{Model: "m", Tier: "long", Day: "2026-10-09", Requests: 1},
	}
	if !slices.Equal(got, want) {
		t.Errorf("SumUsage = %+v", got)
	}
	if a[0].Requests != 1 || b[0].Requests != 2 {
		t.Error("SumUsage wrote into its inputs")
	}
	if SumUsage() != nil {
		t.Error("SumUsage() != nil")
	}
}

func totalRequests(bs []UsageBucket) (n int64) {
	for _, b := range bs {
		n += b.Requests
	}
	return n
}

func TestUsageFromLiveTranscript(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "driver"})
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	c := usageLines(t)
	e.writeTranscript(cid, userLine("hi"))
	e.writeTranscript(cid, c[1])
	got := e.waitFor(s.ID, "usage", func(s Thread) bool { return totalRequests(s.Usage) == 1 })
	if got.Usage[0].Output != 199 {
		t.Errorf("usage = %+v", got.Usage)
	}

	// The streamed repeat publishes nothing.
	for len(e.events.C()) > 0 {
		<-e.events.C()
	}
	e.writeTranscript(cid, c[2])
	e.writeTranscript(cid, sentinelLink)
	e.waitFor(s.ID, "sentinel read", linkedSentinel)
	for len(e.events.C()) > 0 {
		// The sentinel's own update is the only one.
		if u, ok := (<-e.events.C()).(Updated); ok && u.Thread.ID == s.ID && !linkedSentinel(u.Thread) {
			t.Errorf("repeat published an update: %+v", u.Thread.Usage)
		}
	}

	e.writeTranscript(cid, c[3:]...)
	got = e.waitFor(s.ID, "all usage", func(s Thread) bool { return totalRequests(s.Usage) == 4 })
	var whole usageFold
	for _, l := range c {
		whole.Line([]byte(l))
	}
	if !slices.Equal(got.Usage, whole.Buckets()) {
		t.Errorf("usage = %+v; want %+v", got.Usage, whole.Buckets())
	}

	// Persisted: a restart loads the same buckets.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	e.open()
	after, err := e.m.Get(e.ctx(), s.ID)
	if err != nil || !slices.Equal(after.Usage, whole.Buckets()) {
		t.Errorf("after restart = %+v, %v", after.Usage, err)
	}
}

func TestUsageRescanOnReconnect(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "driver"})
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	c := usageLines(t)
	e.writeTranscript(cid, userLine("hi"), c[1], c[2])
	e.waitFor(s.ID, "usage", func(s Thread) bool { return totalRequests(s.Usage) == 1 })
	e.exit(s.ID, 0)
	e.waitFor(s.ID, "disconnected", func(s Thread) bool { return s.State == StateDisconnected })

	// History the daemon never saw, and a cached value that is wrong (as after a crash
	// between a transcript write and the persist): the rescan replaces it, it never
	// adds to it.
	e.writeTranscript(cid, c[3:]...)
	stale := []UsageBucket{{Model: "claude-opus-5-5", Day: "2026-10-06", Requests: 99, Input: 99}}
	e.m.setUsage(s.ID, usageUpdate{total: stale})
	if _, err := e.m.Reconnect(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	var whole usageFold
	for _, l := range c {
		whole.Line([]byte(l))
	}
	got := e.waitFor(s.ID, "rescan", func(s Thread) bool { return totalRequests(s.Usage) == 4 })
	if !slices.Equal(got.Usage, whole.Buckets()) {
		t.Errorf("rescanned = %+v; want %+v", got.Usage, whole.Buckets())
	}

	// New records after the resume add to the rescanned fold.
	e.writeTranscript(cid, usageLine("r-new", "2026-10-10T01:00:00Z", cid, "claude-opus-5-5", 1, 1, 1, 0, h1(0), "standard"))
	got = e.waitFor(s.ID, "live after rescan", func(s Thread) bool { return totalRequests(s.Usage) == 5 })
	if last := got.Usage[len(got.Usage)-1]; last.Day != "2026-10-10" || last.Requests != 1 {
		t.Errorf("usage = %+v", got.Usage)
	}
}

func TestForkSkipsParentUsage(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "driver"})
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	c := usageLines(t)
	e.writeTranscript(cid, userLine("hi"), c[1])
	e.waitFor(s.ID, "usage", func(s Thread) bool { return totalRequests(s.Usage) == 1 })

	f, err := e.m.Fork(e.ctx(), s.ID, "fork")
	if err != nil {
		t.Fatal(err)
	}
	fargv := e.spec(f.ID).Argv
	fcid := argOf(fargv, "--session-id")
	if fcid == "" || fcid == cid {
		t.Fatalf("fork argv = %q", fargv)
	}
	// Claude starts the fork's file with a copy of the parent's records (original
	// times, the fork's sessionId), then the fork's own.
	own := usageLine("r-own", time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano), fcid,
		"claude-haiku-5-5", 2, 4, 25896, 13021, h1(13021), "standard")
	e.writeTranscript(fcid, userLine("hi"), c[1], c[3], own)
	got := e.waitFor(f.ID, "fork usage", func(s Thread) bool { return len(s.Usage) > 0 })
	if totalRequests(got.Usage) != 1 || got.Usage[0].Model != "claude-haiku-5-5" {
		t.Errorf("fork usage = %+v; want only its own haiku request", got.Usage)
	}

	// The rescan on reconnect skips the copies too.
	e.exit(f.ID, 0)
	e.waitFor(f.ID, "fork disconnected", func(s Thread) bool { return s.State == StateDisconnected })
	e.m.setUsage(f.ID, usageUpdate{})
	if _, err := e.m.Reconnect(e.ctx(), f.ID); err != nil {
		t.Fatal(err)
	}
	got = e.waitFor(f.ID, "fork rescan", func(s Thread) bool { return len(s.Usage) > 0 })
	if totalRequests(got.Usage) != 1 || got.Usage[0].Model != "claude-haiku-5-5" {
		t.Errorf("fork usage after rescan = %+v", got.Usage)
	}
}

func TestRemoveRetiresUsage(t *testing.T) {
	e := newEnv(t)
	a := e.connected(CreateOptions{Name: "a"})
	b := e.connected(CreateOptions{Name: "b"})
	ua := []UsageBucket{{Model: "claude-opus-5-5", Day: "2026-10-09", Requests: 2, Input: 3, Output: 4, CacheRead: 5, CacheWrite5m: 6, CacheWrite1h: 7}}
	ub := []UsageBucket{
		{Model: "claude-haiku-5-5", Day: "2026-10-08", Requests: 1, Output: 1},
		{Model: "claude-opus-5-5", Day: "2026-10-09", Requests: 1, Input: 1, Output: 1, CacheRead: 1, CacheWrite5m: 1, CacheWrite1h: 1},
	}
	e.m.setUsage(a.ID, usageUpdate{total: ua})
	e.m.setUsage(b.ID, usageUpdate{total: ub})
	for len(e.events.C()) > 0 {
		<-e.events.C()
	}

	if err := e.m.Remove(e.ctx(), a.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.m.Snapshot().RetiredUsage; !slices.Equal(got, ua) {
		t.Errorf("retired after a = %+v", got)
	}
	var retiredEv *RetiredUsage
	for len(e.events.C()) > 0 {
		if r, ok := (<-e.events.C()).(RetiredUsage); ok {
			retiredEv = &r
		}
	}
	if retiredEv == nil || !slices.Equal(retiredEv.Buckets, ua) {
		t.Errorf("RetiredUsage event = %+v", retiredEv)
	}

	if err := e.m.Remove(e.ctx(), b.ID); err != nil {
		t.Fatal(err)
	}
	want := []UsageBucket{
		{Model: "claude-haiku-5-5", Day: "2026-10-08", Requests: 1, Output: 1},
		{Model: "claude-opus-5-5", Day: "2026-10-09", Requests: 3, Input: 4, Output: 5, CacheRead: 6, CacheWrite5m: 7, CacheWrite1h: 8},
	}
	if got := e.m.Snapshot().RetiredUsage; !slices.Equal(got, want) {
		t.Errorf("retired after b = %+v", got)
	}

	// A thread without usage retires nothing and publishes no RetiredUsage.
	c := e.connected(CreateOptions{Name: "c"})
	for len(e.events.C()) > 0 {
		<-e.events.C()
	}
	if err := e.m.Remove(e.ctx(), c.ID); err != nil {
		t.Fatal(err)
	}
	for len(e.events.C()) > 0 {
		if r, ok := (<-e.events.C()).(RetiredUsage); ok {
			t.Errorf("removing a thread without usage published %+v", r)
		}
	}

	var n int
	if err := e.m.opts.DB.QueryRow(`SELECT count(*) FROM session_usage`).Scan(&n); err != nil || n != 0 {
		t.Errorf("session_usage rows after remove = %d, %v", n, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	e.open()
	if got := e.m.Snapshot().RetiredUsage; !slices.Equal(got, want) {
		t.Errorf("retired after restart = %+v", got)
	}
}

func TestSaveAndLoadUsage(t *testing.T) {
	e := newEnv(t)
	a := e.connected(CreateOptions{Name: "a"})
	ctx := e.ctx()
	db := e.m.opts.DB
	first := []UsageBucket{
		{Model: "m", Day: "2026-10-08", Requests: 1},
		{Model: "m", Tier: "long", Speed: "fast", Day: "2026-10-09", Requests: 2, Input: 1, Output: 2, CacheRead: 3, CacheWrite5m: 4, CacheWrite1h: 5},
	}
	if err := saveUsage(ctx, db, a.ID, first); err != nil {
		t.Fatal(err)
	}
	// Saving replaces the thread's rows; it never merges.
	second := []UsageBucket{{Model: "n", Day: "2026-10-10", Requests: 7}}
	if err := saveUsage(ctx, db, a.ID, second); err != nil {
		t.Fatal(err)
	}
	if err := saveUsage(ctx, db, "s-nope", second); err == nil {
		t.Error("saveUsage for an unknown thread = nil error (foreign key)")
	}
	got, err := loadUsage(ctx, db)
	if err != nil || len(got) != 1 || !slices.Equal(got[a.ID], second) {
		t.Errorf("loadUsage = %+v, %v", got, err)
	}
	if err := saveUsage(ctx, db, a.ID, first); err != nil {
		t.Fatal(err)
	}
	threads, err := loadThreads(ctx, db)
	if err != nil || len(threads) != 1 || !slices.Equal(threads[0].Usage, first) {
		t.Errorf("loadThreads usage = %+v, %v", threads, err)
	}
	if err := saveUsage(ctx, db, a.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got, err := loadUsage(ctx, db); err != nil || len(got) != 0 {
		t.Errorf("after saving none = %+v, %v", got, err)
	}
}
