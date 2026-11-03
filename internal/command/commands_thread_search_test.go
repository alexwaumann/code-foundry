package command_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.search sends the query, the includes and the limits.
func TestThreadSearch(t *testing.T) {
	children, subagents, owned := v1.SearchInclude_SEARCH_INCLUDE_CHILDREN, v1.SearchInclude_SEARCH_INCLUDE_SUBAGENTS, v1.SearchInclude_SEARCH_INCLUDE_OWNED
	tests := []struct {
		name    string
		args    map[string]string
		wantReq *v1.SearchThreadsRequest
		wantErr string
	}{
		{name: "the query and the defaults", args: map[string]string{"query": "login redirect"},
			wantReq: &v1.SearchThreadsRequest{Query: "login redirect", Limit: 50, PerThread: 5}},
		{name: "includes, once each", args: map[string]string{"query": "x y z", "include": "subagents, children,subagents"},
			wantReq: &v1.SearchThreadsRequest{Query: "x y z", Include: []v1.SearchInclude{subagents, children}, Limit: 50, PerThread: 5}},
		{name: "all", args: map[string]string{"query": "login", "all": "true", "include": "nonsense"},
			wantReq: &v1.SearchThreadsRequest{Query: "login", Include: []v1.SearchInclude{children, subagents, owned}, Limit: 50, PerThread: 5}},
		{name: "projects and limits", args: map[string]string{"query": "login", "project": "web, api", "limit": "10", "per-thread": "1"},
			wantReq: &v1.SearchThreadsRequest{Query: "login", ProjectIds: []string{"web", "api"}, Limit: 10, PerThread: 1}},
		{name: "an unknown include", args: map[string]string{"query": "login", "include": "forks"}, wantErr: "include takes children, subagents, owned"},
		{name: "a limit over the cap", args: map[string]string{"query": "login", "limit": "501"}, wantErr: "limit must be 1 to 500"},
		{name: "no per-thread hits", args: map[string]string{"query": "login", "per-thread": "0"}, wantErr: "per-thread must be 1 or more"},
		{name: "only quotes", args: map[string]string{"query": `""`}, wantErr: "query must have a word"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			res, err := reg.Invoke(context.Background(), command.Context{}, "thread.search", tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != "no matches" {
				t.Errorf("message %q", res.Message)
			}
			if got := b.Requests(); !slices.EqualFunc(got, []proto.Message{tt.wantReq}, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReq)
			}
		})
	}
}

func TestFormatSearch(t *testing.T) {
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) *timestamppb.Timestamp { return timestamppb.New(now.Add(-d)) }
	res := &v1.SearchThreadsResponse{
		Threads:   []*v1.SearchThreadName{{ThreadId: "s-1", Name: "Fix the login redirect"}, {ThreadId: "s-9", Archived: true}},
		TotalHits: 9, TotalThreads: 2,
		Groups: []*v1.SearchThreadGroup{
			{ThreadId: "s-1", ThreadName: "Fix the login redirect", TotalHits: 7, Hits: []*v1.SearchHit{
				{Ordinal: 3, Speaker: v1.SearchSpeaker_SEARCH_SPEAKER_USER, CreatedAt: at(5 * time.Minute), Snippet: "the login page"},
				{Ordinal: 12, Speaker: v1.SearchSpeaker_SEARCH_SPEAKER_ASSISTANT, CreatedAt: at(4 * time.Minute), Snippet: strings.Repeat("x", 130)},
			}},
			{ThreadId: "s-22", Archived: true, TotalHits: 1, Hits: []*v1.SearchHit{
				{Ordinal: 40, Speaker: v1.SearchSpeaker_SEARCH_SPEAKER_QUESTION, CreatedAt: at(3 * time.Hour), Snippet: "Which login? Email", ParentToolUseId: "toolu_1"},
			}},
		},
	}
	want := `Thread names:
  s-1  Fix the login redirect
  s-9  (unnamed) (archived)

Messages: 9 in 2 threads (3 shown)

s-1  Fix the login redirect  (7 hits)
  #3   you     5m  the login page
  #12  claude  4m  ` + strings.Repeat("x", 119) + `…

s-22  (unnamed) (archived)  (1 hit)
  #40  subagent question  3h  Which login? Email

Read around a hit: code-foundry thread read --id <thread> --since <#N-3> --last 6`
	if got := command.FormatSearch(res, now); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	for _, tt := range []struct {
		name string
		res  *v1.SearchThreadsResponse
		want string
	}{
		{"nothing", &v1.SearchThreadsResponse{}, "no matches"},
		{"names only, none", &v1.SearchThreadsResponse{NamesOnly: true}, "no thread names match (messages need a word of 3 characters or more)"},
		{"names only", &v1.SearchThreadsResponse{NamesOnly: true, Threads: []*v1.SearchThreadName{{ThreadId: "s-1", Name: "UI"}}},
			"Thread names:\n  s-1  UI\n(messages need a word of 3 characters or more)"},
		{"a name, no messages", &v1.SearchThreadsResponse{Threads: []*v1.SearchThreadName{{ThreadId: "s-1", Name: "Login"}}},
			"Thread names:\n  s-1  Login\nno messages match"},
	} {
		if got := command.FormatSearch(tt.res, now); got != tt.want {
			t.Errorf("%s: got %q, want %q", tt.name, got, tt.want)
		}
	}
	truncated := command.FormatSearch(&v1.SearchThreadsResponse{TotalHits: 1, TotalThreads: 1, Truncated: true,
		Groups: []*v1.SearchThreadGroup{{ThreadId: "s-1", TotalHits: 1, Hits: []*v1.SearchHit{{Ordinal: 1, CreatedAt: at(time.Minute)}}}}}, now)
	if !strings.Contains(truncated, "more matched than a search reads") {
		t.Errorf("truncated: %q", truncated)
	}
}
