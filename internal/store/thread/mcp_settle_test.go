package thread

import (
	"reflect"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// An answer listing no servers from a process that has listed none yet keeps the
// cached servers, as pending; a late answer of an ended process is dropped.
func TestThreadLogAnswerMcp(t *testing.T) {
	cached := []McpServer{
		{Name: "docs", Status: McpConnected, ServerName: "Docs", Version: "0.1.0", Scope: "claudeai", Source: "claudeai", Transport: "claudeai-proxy", Tools: []McpTool{{Name: "query"}}},
		{Name: "broken", Status: McpFailed, Error: "ENOENT", Scope: "dynamic", Source: "dynamic", Transport: "stdio"},
	}
	pending := []McpServer{
		{Name: "docs", Status: McpPending, Scope: "claudeai", Source: "claudeai", Transport: "claudeai-proxy"},
		{Name: "broken", Status: McpPending, Scope: "dynamic", Source: "dynamic", Transport: "stdio"},
	}
	listed := []McpServer{{Name: "docs", Status: McpConnected, Transport: "claudeai-proxy"}}
	none := []McpServer{}
	old, cur := new(claudestream.Conn), new(claudestream.Conn)
	tests := []struct {
		name  string
		cache []McpServer        // cached before (nil: nothing)
		prev  *claudestream.Conn // whose answer cached it (nil: none since a process ended)
		// prevListed: that answer listed servers.
		prevListed  bool
		answer      []McpServer
		keep        bool
		drop        bool // the process ended while the check was in flight
		want        []McpServer
		wantFirst   bool
		wantApplied bool
	}{
		{name: "new process lists none: cached servers pending", cache: cached, answer: none, keep: true,
			want: pending, wantFirst: true, wantApplied: true},
		{name: "same process, none listed yet", cache: pending, prev: cur, answer: none, keep: true,
			want: pending, wantApplied: true},
		{name: "same process listed servers before", cache: cached, prev: cur, prevListed: true, answer: none, keep: true,
			want: none, wantApplied: true},
		{name: "a process after another", cache: cached, prev: old, prevListed: true, answer: none, keep: true,
			want: pending, wantFirst: true, wantApplied: true},
		{name: "not kept (last poll, a turn's check)", cache: cached, answer: none,
			want: none, wantFirst: true, wantApplied: true},
		{name: "nothing cached", answer: none, keep: true, want: none, wantFirst: true, wantApplied: true},
		{name: "cached none", cache: none, answer: none, keep: true, want: none, wantFirst: true, wantApplied: true},
		{name: "servers listed replace the cache", cache: cached, answer: listed, keep: true,
			want: listed, wantFirst: true, wantApplied: true},
		{name: "late answer of an ended process", cache: cached, prev: cur, answer: none, keep: true, drop: true,
			want: cached, wantFirst: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := bus.New()
			sub := bus.Subscribe[ThreadEvent](b, 16)
			defer sub.Close()
			log := newThreadLog("s1", b, time.Now, nil)
			switch {
			case tt.prev != nil:
				n := 0
				if tt.prevListed {
					n = len(tt.cache)
				}
				log.answerMcp(log.mcpTicket(), tt.prev, &McpStatus{Servers: tt.cache}, n, false)
			case tt.cache != nil:
				log.setMcp(log.mcpTicket(), &McpStatus{Servers: tt.cache})
			}
			for len(sub.C()) > 0 {
				<-sub.C()
			}
			ticket := log.mcpTicket()
			if tt.drop {
				log.dropMcpChecks()
			}
			s := &McpStatus{Trigger: McpTriggerRefresh, Servers: tt.answer}
			first := log.answerMcp(ticket, cur, s, len(tt.answer), tt.keep)
			if first != tt.wantFirst {
				t.Errorf("first = %v, want %v", first, tt.wantFirst)
			}
			got := log.mcpStatus()
			if applied := got == s; applied != tt.wantApplied {
				t.Errorf("applied = %v, want %v", applied, tt.wantApplied)
			}
			var gotServers []McpServer
			if got != nil {
				gotServers = got.Servers
			}
			if !reflect.DeepEqual(gotServers, tt.want) {
				t.Errorf("cached %+v\nwant   %+v", gotServers, tt.want)
			}
			if published := len(sub.C()) > 0; published != tt.wantApplied {
				t.Errorf("published = %v", published)
			}
		})
	}
}

// A refresh or a reconnect of a stopped thread starts Claude without a prompt and asks
// at once, while Claude is still starting its servers: the answer shows the cached
// servers connecting (never none of none), and polls settle it.
func TestMcpSettlesAfterStart(t *testing.T) {
	tests := []struct {
		name      string
		knobs     []string
		reconnect string // reconnect this server instead of refreshing
		// wantGone: Claude never lists a server again; the last poll takes that.
		wantGone bool
	}{
		{name: "refresh, none then all", knobs: []string{"CF_FAKE_CLAUDE_MCP_EMPTY=1"}},
		{name: "refresh, pending then connected", knobs: []string{"CF_FAKE_CLAUDE_MCP_PENDING=1"}},
		{name: "refresh, none, pending, connected", knobs: []string{"CF_FAKE_CLAUDE_MCP_EMPTY=2", "CF_FAKE_CLAUDE_MCP_PENDING=2"}},
		{name: "reconnect, none then all", knobs: []string{"CF_FAKE_CLAUDE_MCP_EMPTY=1"}, reconnect: "broken"},
		{name: "reconnect, pending then connected", knobs: []string{"CF_FAKE_CLAUDE_MCP_PENDING=1"}, reconnect: "broken"},
		{name: "refresh, servers gone", knobs: []string{"CF_FAKE_CLAUDE_MCP_EMPTY=99"}, wantGone: true},
	}
	settled := func(m *McpStatus) bool {
		return m != nil && len(m.Servers) == 5 && m.Connected() == 1 && !m.anyPending()
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			re := newFixtureEnvAt(t, fixturePath("text-table"), append([]string{"CF_FAKE_CLAUDE_MCP=" + mcpFixture()}, tt.knobs...),
				func(o *Options) { o.McpPollInterval = 10 * time.Millisecond })
			s := re.connected(CreateOptions{})
			if tt.wantGone {
				// Servers to lose: a status cached by an earlier process.
				log, err := re.m.thread(re.ctx(), s.ID)
				if err != nil {
					t.Fatal(err)
				}
				log.setMcp(log.mcpTicket(), &McpStatus{Servers: []McpServer{{Name: "docs", Status: McpConnected, Scope: "user", Transport: "http"}}})
			} else {
				// No turn: the first read asks, and the process's first answers are
				// polled past.
				if _, err := re.m.McpStatus(re.ctx(), s.ID, false); err != nil {
					t.Fatal(err)
				}
				re.waitMcp(s.ID, "settled before the close", settled)
			}
			if err := re.m.Close(re.ctx(), s.ID); err != nil {
				t.Fatal(err)
			}
			cachedBefore := re.items(s.ID).Mcp
			sub := bus.Subscribe[ThreadEvent](re.bus, 1024)
			defer sub.Close()

			var got *McpStatus
			if tt.reconnect != "" {
				res, err := re.m.McpReconnect(re.ctx(), s.ID, tt.reconnect)
				if err != nil {
					t.Fatal(err)
				}
				got = res.Status
				if got.Trigger != McpTriggerReconnect || got.Server != tt.reconnect {
					t.Errorf("reconnect status %+v", got)
				}
			} else {
				var err error
				if got, err = re.m.McpStatus(re.ctx(), s.ID, true); err != nil {
					t.Fatal(err)
				}
				if got.Trigger != McpTriggerRefresh {
					t.Errorf("refresh status %+v", got)
				}
			}
			// The first answer: the cached servers, connecting.
			if len(got.Servers) != len(cachedBefore.Servers) || got.Connected() != 0 {
				t.Fatalf("first answer %+v, cached %+v", got, cachedBefore)
			}
			for i, sv := range got.Servers {
				was := cachedBefore.Servers[i]
				want := McpServer{Name: was.Name, Status: McpPending, Scope: was.Scope, Source: was.Source, Transport: was.Transport}
				if !reflect.DeepEqual(sv, want) {
					t.Errorf("server %d = %+v\nwant %+v", i, sv, want)
				}
			}

			var last *McpStatus
			if tt.wantGone {
				last = re.waitMcp(s.ID, "the last poll's none", func(m *McpStatus) bool { return m != nil && len(m.Servers) == 0 })
			} else {
				last = re.waitMcp(s.ID, "settled", settled)
			}
			if !tt.wantGone {
				if b := serverOf(t, last, "broken"); b.Status != McpFailed || b.Error == "" {
					t.Errorf("broken %+v", b)
				}
			}
			// Every answer published before the last one listed the servers.
			var events []*McpStatus
			for len(sub.C()) > 0 {
				if e, ok := (<-sub.C()).(McpChanged); ok && e.ThreadID == s.ID {
					events = append(events, e.Status)
				}
			}
			if len(events) < 2 || events[len(events)-1] != last {
				t.Fatalf("events %+v, last %+v", events, last)
			}
			for i, e := range events[:len(events)-1] {
				if len(e.Servers) == 0 {
					t.Errorf("event %d listed no servers: %+v", i, e)
				}
			}
			if tt.wantGone && len(events) != mcpPendingPolls+1 {
				t.Errorf("%d answers, want the first and %d polls", len(events), mcpPendingPolls)
			}
		})
	}
}
