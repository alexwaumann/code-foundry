package session

import (
	"os"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

func TestTurnContext(t *testing.T) {
	u := &claudestream.APIUsage{InputTokens: 2, CacheReadInputTokens: 22411, CacheCreationInputTokens: 2190, OutputTokens: 180}
	tests := []struct {
		name   string
		last   int64
		result *claudestream.APIUsage
		want   int64
	}{
		{name: "the last response wins over the turn's sum", last: 24783, result: &claudestream.APIUsage{InputTokens: 4, CacheReadInputTokens: 37430, CacheCreationInputTokens: 9582, OutputTokens: 298}, want: 24783},
		{name: "no streamed response: the result's usage", result: u, want: 24783},
		{name: "a streamed response and an empty result (interrupt)", last: 22388, result: &claudestream.APIUsage{}, want: 22388},
		{name: "nothing at all (a local command)", result: &claudestream.APIUsage{}, want: 0},
		{name: "no usage object", want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := turnContext(tt.last, tt.result); got != tt.want {
				t.Errorf("turnContext = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestCacheExpiry(t *testing.T) {
	at := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		last time.Time
		ttl  time.Duration
		want time.Time
	}{
		{name: "an hour", last: at, ttl: time.Hour, want: at.Add(time.Hour)},
		{name: "a minute", last: at, ttl: time.Minute, want: at.Add(time.Minute)},
		{name: "no result yet", ttl: time.Hour},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cacheExpiry(tt.last, tt.ttl); !got.Equal(tt.want) {
				t.Errorf("cacheExpiry = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestProjectContext replays each fixture through the projector and checks the context
// size every result leaves behind: the last top-level response's input + cache read +
// cache write + output (a tool turn's result sums two calls), the compaction's
// post-compaction size for /compact, the streamed usage for an interrupt (its result
// reports zeros).
func TestProjectContext(t *testing.T) {
	tests := []struct {
		fixture string
		want    []int64
		model   string
	}{
		{"text-table", []int64{22061}, "claude-haiku-5-5"},
		{"write-allow", []int64{24457}, "claude-haiku-5-5"},
		{"bash", []int64{24783}, "claude-haiku-5-5"},
		{"interrupt", []int64{22388}, "claude-haiku-5-5"},
		{"compact", []int64{22221, 1885}, ""},
		{"task", []int64{25217}, "claude-haiku-5-5"},
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			data, err := os.ReadFile(fixturePath(tt.fixture))
			if err != nil {
				t.Fatal(err)
			}
			log := newThreadLog("s", bus.New(), time.Now, nil)
			p := newProjector(itemWriter{log: log, save: func(Item) {}}, runningTotals{known: true})
			var got []int64
			var model string
			var sp claudestream.Splitter
			for _, line := range sp.Split(nil, data) {
				ev := claudestream.Parse(line)
				p.event(ev)
				if _, ok := ev.(*claudestream.Result); ok {
					got, model = append(got, p.last.tokens), p.last.model
				}
			}
			if len(got) != len(tt.want) {
				t.Fatalf("contexts = %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("contexts = %v, want %v", got, tt.want)
				}
			}
			if model != tt.model {
				t.Errorf("last model = %q, want %q", model, tt.model)
			}
		})
	}
}

// A rendered thread records its context after each result, persists it, and its cache
// expiry follows the TTL: at load, and live through SetCacheTTL (which republishes).
func TestRenderedContextTotals(t *testing.T) {
	now := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	clock := func(o *Options) { o.Now = func() time.Time { return now } }
	re := newRenderedEnv(t, "text-table")
	re.restart(func(o *Options) { re.mutate(o); clock(o) })
	s := re.create(CreateOptions{InitialPrompt: "a table please"})
	got := re.waitFor(s.ID, "context totals", func(s Session) bool { return s.ContextTokens > 0 })
	if got.ContextTokens != 22061 || got.ContextModel != "claude-haiku-5-5" || !got.LastResultAt.Equal(now) ||
		!got.CacheExpiresAt.Equal(now.Add(DefaultCacheTTL)) {
		t.Fatalf("after the result: tokens %d model %q last %v expires %v", got.ContextTokens, got.ContextModel, got.LastResultAt, got.CacheExpiresAt)
	}

	// Live: a shorter TTL moves the expiry and publishes the thread.
	sub := bus.Subscribe[Event](re.bus, 64)
	defer sub.Close()
	re.m.SetCacheTTL(time.Minute)
	if got, _ := re.m.Get(re.ctx(), s.ID); !got.CacheExpiresAt.Equal(now.Add(time.Minute)) {
		t.Errorf("after SetCacheTTL(1m): expires %v", got.CacheExpiresAt)
	}
	// Other updates (status) may come first; one carries the new expiry.
	deadline := time.After(2 * time.Second)
	for published := false; !published; {
		select {
		case ev := <-sub.C():
			u, ok := ev.(Updated)
			published = ok && u.Session.ID == s.ID && u.Session.CacheExpiresAt.Equal(now.Add(time.Minute))
		case <-deadline:
			t.Fatal("SetCacheTTL published no update with the new expiry")
		}
	}

	// Persisted: a restart with another TTL loads the totals and computes from it.
	re.restart(func(o *Options) { re.mutate(o); clock(o); o.CacheTTL = 5 * time.Minute })
	got, err := re.m.Get(re.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ContextTokens != 22061 || got.ContextModel != "claude-haiku-5-5" || !got.LastResultAt.Equal(now) ||
		!got.CacheExpiresAt.Equal(now.Add(5*time.Minute)) {
		t.Errorf("after restart: tokens %d model %q last %v expires %v", got.ContextTokens, got.ContextModel, got.LastResultAt, got.CacheExpiresAt)
	}

	// /clear: nothing cached, nothing to re-read.
	re.m.recordContext(s.ID, 0, "")
	if got, _ := re.m.Get(re.ctx(), s.ID); got.ContextTokens != 0 || !got.LastResultAt.IsZero() || !got.CacheExpiresAt.IsZero() {
		t.Errorf("after a reset: %+v", got)
	}
}

// A terminal thread never has totals.
func TestTerminalThreadHasNoContextTotals(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{RepoID: "r1", Name: "t"})
	e.m.SetCacheTTL(time.Minute)
	got, _ := e.m.Get(e.ctx(), s.ID)
	if got.ContextTokens != 0 || !got.LastResultAt.IsZero() || !got.CacheExpiresAt.IsZero() {
		t.Errorf("terminal thread: %+v", got)
	}
}
