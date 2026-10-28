package thread

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// The picker over rows given newest first: exclusions, runs, forks, query, limit.
func TestPromptPicker(t *testing.T) {
	t0 := time.UnixMilli(1_800_000_000_000)
	at := func(min int) time.Time { return t0.Add(time.Duration(min) * time.Minute) }
	threads := map[string]Thread{
		"a":    {ID: "a", Name: "Alpha", CreatedAt: at(0)},
		"b":    {ID: "b", Name: "Beta", CreatedAt: at(1)},
		"fork": {ID: "fork", Name: "Alpha fork", CreatedAt: at(50)},
	}
	row := func(thread, item string, min int, text string) promptRow {
		return promptRow{threadID: thread, itemID: item, createdAt: at(min), text: text}
	}
	type got struct{ thread, item, text string }
	tests := []struct {
		name  string
		rows  []promptRow // newest first
		query string
		limit int
		want  []got
	}{
		{
			name: "newest first across threads",
			rows: []promptRow{row("b", "b2", 30, "two"), row("a", "a1", 20, "one")},
			want: []got{{"b", "b2", "two"}, {"a", "a1", "one"}},
		},
		{
			name: "threads outside the scope are skipped",
			rows: []promptRow{row("x", "x1", 30, "elsewhere"), row("a", "a1", 20, "one")},
			want: []got{{"a", "a1", "one"}},
		},
		{
			name: "wakes, other threads' messages, subagents and attachment-only messages are left out",
			rows: []promptRow{
				{threadID: "a", itemID: "w", createdAt: at(40), text: "wake", origin: OriginWake},
				{threadID: "a", itemID: "by", createdAt: at(39), text: "from a lead", sentBy: "s-lead"},
				{threadID: "a", itemID: "sub", createdAt: at(38), text: "subagent", parentToolUseID: "toolu_1"},
				{threadID: "a", itemID: "img", createdAt: at(37), text: "[Image: a.png; ref=/x]", composer: "![a.png](cf-attachment://0)"},
				row("a", "a1", 20, "mine"),
			},
			want: []got{{"a", "a1", "mine"}},
		},
		{
			name: "a run of the same text in one thread is its newest",
			rows: []promptRow{row("a", "a3", 30, "retry"), row("a", "a2", 20, "retry"), row("a", "a1", 10, "retry")},
			want: []got{{"a", "a3", "retry"}},
		},
		{
			name: "the same text with another prompt between is listed twice",
			rows: []promptRow{row("a", "a3", 30, "retry"), row("a", "a2", 20, "other"), row("a", "a1", 10, "retry")},
			want: []got{{"a", "a3", "retry"}, {"a", "a2", "other"}, {"a", "a1", "retry"}},
		},
		{
			name: "runs are per thread",
			rows: []promptRow{row("a", "a2", 30, "retry"), row("b", "b1", 25, "retry"), row("a", "a1", 20, "retry")},
			want: []got{{"a", "a2", "retry"}, {"b", "b1", "retry"}},
		},
		{
			name: "an excluded message does not break a run",
			rows: []promptRow{row("a", "a2", 30, "retry"),
				{threadID: "a", itemID: "w", createdAt: at(25), text: "wake", origin: OriginWake}, row("a", "a1", 20, "retry")},
			want: []got{{"a", "a2", "retry"}},
		},
		{
			name: "runs compare the text as shown",
			rows: []promptRow{row("a", "a2", 30, "see src/a.ts"), {threadID: "a", itemID: "a1", createdAt: at(20), text: "x",
				composer: "see [a.ts](cf-file://r-1/src/a.ts)"}},
			want: []got{{"a", "a2", "see src/a.ts"}},
		},
		{
			name: "a fork's copy is listed once under the older thread, whichever comes first",
			rows: []promptRow{row("fork", "a1", 20, "one"), row("a", "a1", 20, "one")},
			want: []got{{"a", "a1", "one"}},
		},
		{
			name: "query is a case-insensitive substring",
			rows: []promptRow{row("a", "a3", 30, "Fix the Resize race"), row("a", "a2", 20, "tidy"), row("b", "b1", 10, "resize again")},
			query: "RESIZE",
			want:  []got{{"a", "a3", "Fix the Resize race"}, {"b", "b1", "resize again"}},
		},
		{
			name: "query matches the text as shown, not the token",
			rows: []promptRow{{threadID: "a", itemID: "a1", createdAt: at(20), text: "x", composer: "[#12](cf-pr://o/r/12)"}},
			query: "cf-pr",
			want:  nil,
		},
		{
			name:  "limit keeps the newest",
			rows:  []promptRow{row("a", "a3", 30, "three"), row("a", "a2", 20, "two"), row("a", "a1", 10, "one")},
			limit: 2,
			want:  []got{{"a", "a3", "three"}, {"a", "a2", "two"}},
		},
		{
			name:  "limit still folds a fork's copy sent at the same time",
			rows:  []promptRow{row("fork", "a1", 20, "one"), row("a", "a1", 20, "one"), row("b", "b0", 20, "same minute")},
			limit: 1,
			want:  []got{{"a", "a1", "one"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := newPromptPicker(threads, func(string) (string, bool) { return "", false }, tt.query, tt.limit)
			for _, r := range tt.rows {
				if !p.add(r) {
					break
				}
			}
			var out []got
			for _, sp := range p.out {
				out = append(out, got{sp.ThreadID, sp.ItemID, sp.Text})
			}
			if !slices.Equal(out, tt.want) {
				t.Errorf("picked %v, want %v", out, tt.want)
			}
		})
	}
}

func TestPromptLimits(t *testing.T) {
	for _, tt := range []struct{ in, want int }{{0, DefaultPromptLimit}, {-3, DefaultPromptLimit}, {7, 7}, {500, 500}, {9000, MaxPromptLimit}} {
		if got := newPromptPicker(nil, nil, "", tt.in).limit; got != tt.want {
			t.Errorf("limit %d = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestSharesProject(t *testing.T) {
	tests := []struct {
		ids, set []string
		want     bool
	}{
		{[]string{"r1"}, []string{"r1"}, true},
		{[]string{"r1", "r2"}, []string{"r2", "r3"}, true},
		{[]string{"r1"}, []string{"r2"}, false},
		{nil, nil, true},
		{nil, []string{"r1"}, false},
		{[]string{"r1"}, nil, false},
	}
	for _, tt := range tests {
		if got := sharesProject(tt.ids, tt.set); got != tt.want {
			t.Errorf("sharesProject(%v, %v) = %v, want %v", tt.ids, tt.set, got, tt.want)
		}
	}
}

// ListPrompts over real threads and rows: each scope's threads, hidden children, plugin
// threads, archived threads, refs and errors.
func TestListPromptsScopes(t *testing.T) {
	e := newEnv(t)
	api := filepath.Join(t.TempDir(), "api")
	if err := os.MkdirAll(api, 0o755); err != nil {
		t.Fatal(err)
	}
	e.projects.Put(project.Project{ID: "r2", Path: api, Name: "api", Git: true, Worktrees: []project.Worktree{{ProjectID: "r2", Path: api, IsMain: true}}})
	a := e.connected(CreateOptions{Name: "A"})
	b := e.connected(CreateOptions{Name: "B"})
	other := e.connected(CreateOptions{Name: "Other", ProjectID: "r2"})
	loose := e.connected(CreateOptions{Name: "Loose", NoProject: true})
	child := e.connected(CreateOptions{Name: "Child", CreatedBy: a.ID})
	owned := e.connected(CreateOptions{Name: "Owned", Owner: "plugin:demo"})
	if _, err := e.m.Archive(e.ctx(), b.ID, true); err != nil {
		t.Fatal(err)
	}
	t0 := time.UnixMilli(1_800_000_000_000)
	put := func(s Thread, n int, text string) {
		t.Helper()
		at := t0.Add(time.Duration(n) * time.Minute)
		it := Item{ID: s.ID + "-p" + text, Ordinal: int64(100 + n), Kind: KindUserMessage, Text: text, CreatedAt: at, UpdatedAt: at}
		if err := saveItem(e.ctx(), e.m.opts.DB, s.ID, it); err != nil {
			t.Fatal(err)
		}
	}
	put(a, 1, "a-one")
	put(b, 2, "b-one")
	put(other, 3, "other-one")
	put(loose, 4, "loose-one")
	put(child, 5, "child-one")
	put(owned, 6, "owned-one")
	put(a, 7, "a-two")

	tests := []struct {
		name    string
		q       PromptQuery
		want    []string
		wantErr error
	}{
		{name: "thread", q: PromptQuery{Scope: PromptScopeThread, ThreadID: a.ID}, want: []string{"a-two", "a-one"}},
		{name: "a hidden child in thread scope", q: PromptQuery{Scope: PromptScopeThread, ThreadID: child.ID}, want: []string{"child-one"}},
		{name: "a plugin's thread has none", q: PromptQuery{Scope: PromptScopeThread, ThreadID: owned.ID}, want: nil},
		{name: "project by anchor: shown threads sharing it, archived too", q: PromptQuery{Scope: PromptScopeProject, ThreadID: a.ID},
			want: []string{"a-two", "b-one", "a-one"}},
		{name: "a hidden anchor's own prompts count", q: PromptQuery{Scope: PromptScopeProject, ThreadID: child.ID},
			want: []string{"a-two", "child-one", "b-one", "a-one"}},
		{name: "project by ids and names", q: PromptQuery{Scope: PromptScopeProject, ProjectIDs: []string{"api", "r1"}},
			want: []string{"a-two", "other-one", "b-one", "a-one"}},
		{name: "project without a project", q: PromptQuery{Scope: PromptScopeProject, ThreadID: loose.ID}, want: []string{"loose-one"}},
		{name: "an empty project set is the threads without one", q: PromptQuery{Scope: PromptScopeProject}, want: []string{"loose-one"}},
		{name: "all", q: PromptQuery{Scope: PromptScopeAll}, want: []string{"a-two", "loose-one", "other-one", "b-one", "a-one"}},
		{name: "all with a query and a limit", q: PromptQuery{Scope: PromptScopeAll, Query: "ONE", Limit: 2}, want: []string{"loose-one", "other-one"}},
		{name: "no scope", q: PromptQuery{ThreadID: a.ID}, wantErr: ErrInvalidArgument},
		{name: "thread scope needs a thread", q: PromptQuery{Scope: PromptScopeThread}, wantErr: ErrInvalidArgument},
		{name: "an unknown thread", q: PromptQuery{Scope: PromptScopeThread, ThreadID: "s-nope"}, wantErr: ErrNotFound},
		{name: "an anchor and ids are exclusive", q: PromptQuery{Scope: PromptScopeProject, ThreadID: a.ID, ProjectIDs: []string{"r1"}},
			wantErr: ErrInvalidArgument},
		{name: "an unknown project", q: PromptQuery{Scope: PromptScopeProject, ProjectIDs: []string{"nope"}}, wantErr: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := e.m.ListPrompts(e.ctx(), tt.q)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var texts []string
			for _, p := range got {
				texts = append(texts, p.Text)
				if want := p.ThreadID + "-p" + p.Text; p.ItemID != want || p.SentAt.IsZero() {
					t.Errorf("prompt %+v: want item %s and a time", p, want)
				}
			}
			if !slices.Equal(texts, tt.want) {
				t.Errorf("texts %v, want %v", texts, tt.want)
			}
		})
	}
}

// Send records the sending thread on the item, a created thread's first prompt its
// creator, and history leaves both out.
func TestListPromptsLeavesOutThreadSends(t *testing.T) {
	e := newEnv(t)
	lead := e.connected(CreateOptions{Name: "Lead"})
	worker := e.connected(CreateOptions{Name: "Worker", CreatedBy: lead.ID, InitialPrompt: "do the thing"})
	if _, err := e.m.Send(e.ctx(), worker.ID, Message{Text: "status?", ByThreadID: lead.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Send(e.ctx(), worker.ID, Message{Text: "mine"}); err != nil {
		t.Fatal(err)
	}
	items := e.waitItems(worker.ID, "three user messages", func(items []Item) bool {
		n := 0
		for _, it := range items {
			if it.Kind == KindUserMessage {
				n++
			}
		}
		return n == 3
	})
	by := map[string]string{}
	for _, it := range items {
		if it.Kind == KindUserMessage {
			by[it.Text] = it.SentBy
		}
	}
	if by["do the thing"] != lead.ID || by["status?"] != lead.ID || by["mine"] != "" {
		t.Fatalf("senders %v", by)
	}
	got, err := e.m.ListPrompts(e.ctx(), PromptQuery{Scope: PromptScopeThread, ThreadID: worker.ID})
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, p := range got {
		texts = append(texts, p.Text)
	}
	if strings.Join(texts, "|") != "mine" {
		t.Fatalf("prompts %v, want only mine", texts)
	}
}
