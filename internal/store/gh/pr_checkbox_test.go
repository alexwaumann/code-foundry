package gh

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
)

// The fake's pull requests (mergeWorld): #1 open, #2 draft, #3 merged, all on o/r.

func TestSetPullRequestCheckbox(t *testing.T) {
	ctx := context.Background()
	const body = "Intro\r\n\r\n- [ ] one\r\n- [x] two\r\n"
	tests := []struct {
		name   string
		number int
		req    CheckboxChange
		setup  func(g *fakeGitHub, s *Store)
		want   CheckboxResult
		err    error
		errHas string
		// ops are the description reads and writes sent.
		ops []string
		// written is the description after the call; "" is body.
		written string
		// event says clients were told to re-read.
		event bool
	}{
		{name: "ticks one box, every other byte kept", number: 1, req: CheckboxChange{Index: 0, Text: "one", Checked: true},
			want: CheckboxResult{Changed: true, Message: "Checked task 1 on #1"}, ops: []string{"read PR_1", "write PR_1"},
			written: "Intro\r\n\r\n- [x] one\r\n- [x] two\r\n", event: true},
		{name: "unticks", number: 1, req: CheckboxChange{Index: 1, Text: "two"},
			want: CheckboxResult{Changed: true, Message: "Unchecked task 2 on #1"}, ops: []string{"read PR_1", "write PR_1"},
			written: "Intro\r\n\r\n- [ ] one\r\n- [ ] two\r\n", event: true},
		{name: "a draft can be edited", number: 2, req: CheckboxChange{Text: "one", Checked: true},
			want: CheckboxResult{Changed: true, Message: "Checked task 1 on #2"}, ops: []string{"read PR_2", "write PR_2"},
			written: "Intro\r\n\r\n- [x] one\r\n- [x] two\r\n", event: true},
		{name: "a merged one can be edited, as on GitHub", number: 3, req: CheckboxChange{Text: "one", Checked: true},
			want: CheckboxResult{Changed: true, Message: "Checked task 1 on #3"}, ops: []string{"read PR_3", "write PR_3"},
			written: "Intro\r\n\r\n- [x] one\r\n- [x] two\r\n", event: true},
		{name: "already so: nothing sent, clients re-read", number: 1, req: CheckboxChange{Index: 1, Text: "two", Checked: true},
			want: CheckboxResult{Message: "Task 2 on #1 was already checked"}, ops: []string{"read PR_1"}, event: true},
		{name: "the fresh copy decides, not the cache", number: 1, req: CheckboxChange{Index: 0, Text: "edited", Checked: true},
			setup: func(g *fakeGitHub, s *Store) {
				if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
					t.Fatal(err)
				}
				g.setBody("PR_1", "- [ ] edited\n")
			},
			want: CheckboxResult{Changed: true, Message: "Checked task 1 on #1"}, ops: []string{"read PR_1", "write PR_1"},
			written: "- [x] edited\n", event: true},
		{name: "an edit since it was shown keeps every other change", number: 1, req: CheckboxChange{Index: 1, Text: "two"},
			setup: func(g *fakeGitHub, _ *Store) { g.setBody("PR_1", "New intro\n\n- [x] one\n- [x] two\n\nNew end\n") },
			want:  CheckboxResult{Changed: true, Message: "Unchecked task 2 on #1"}, ops: []string{"read PR_1", "write PR_1"},
			written: "New intro\n\n- [x] one\n- [ ] two\n\nNew end\n", event: true},
		{name: "the item changed: refused, nothing sent, clients re-read", number: 1, req: CheckboxChange{Index: 0, Text: "shown", Checked: true},
			err: ErrFailedPrecondition, errHas: `pull request #1 has a different task 1 in its description now ("one", was "shown"); look again and retry`,
			ops: []string{"read PR_1"}, event: true},
		{name: "the item moved: refused", number: 1, req: CheckboxChange{Index: 0, Text: "two", Checked: true},
			err: ErrFailedPrecondition, errHas: "has a different task 1", ops: []string{"read PR_1"}, event: true},
		{name: "the item is gone: refused", number: 1, req: CheckboxChange{Index: 5, Text: "x", Checked: true},
			err: ErrFailedPrecondition, errHas: "has no task 6 in its description any more (it has 2)", ops: []string{"read PR_1"}, event: true},
		{name: "no description at all: refused", number: 4, req: CheckboxChange{Text: "x", Checked: true},
			setup: func(g *fakeGitHub, _ *Store) {
				g.mu.Lock()
				defer g.mu.Unlock()
				delete(g.detail.body, "PR_4")
			},
			err: ErrFailedPrecondition, errHas: "has no task 1 in its description any more (it has 0)", ops: []string{"read PR_4"}, event: true},
		{name: "FORBIDDEN is permission denied", number: 1, req: CheckboxChange{Text: "one", Checked: true},
			setup: func(g *fakeGitHub, _ *Store) {
				g.refuseBodyWrites("FORBIDDEN", "Resource not accessible by integration")
			},
			err: ErrPermissionDenied, errHas: "Resource not accessible", ops: []string{"read PR_1", "write PR_1"}},
		{name: "another refusal is a failed precondition with GitHub's message", number: 1, req: CheckboxChange{Text: "one", Checked: true},
			setup: func(g *fakeGitHub, _ *Store) { g.refuseBodyWrites("UNPROCESSABLE", "Pull request is locked") },
			err:   ErrFailedPrecondition, errHas: "Pull request is locked", ops: []string{"read PR_1", "write PR_1"}, event: true},
		{name: "the read fails: nothing sent", number: 1, req: CheckboxChange{Text: "one", Checked: true},
			setup: func(g *fakeGitHub, _ *Store) { g.failNext("PullRequestBody", fmt.Errorf("%w: reset", ErrNetwork)) },
			err:   ErrNetwork, errHas: "pull request #1: cannot read its description"},
		{name: "no answer to the write: it may have happened", number: 1, req: CheckboxChange{Text: "one", Checked: true},
			setup: func(g *fakeGitHub, _ *Store) {
				g.failNext("UpdatePullRequestBody", fmt.Errorf("%w: Bad Gateway (HTTP 502)", ErrServerTimeout))
			},
			err: ErrServerTimeout, errHas: "GitHub did not confirm changing task 1, and it may have happened", ops: []string{"read PR_1"}, event: true},
		{name: "unknown pull request", number: 99, req: CheckboxChange{Text: "one"}, err: ErrNotFound},
		{name: "bad number", number: 0, err: ErrInvalidArgument},
		{name: "negative index", number: 1, req: CheckboxChange{Index: -1}, err: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g, _, s, _, events := mergeWorld(t)
			for _, id := range []string{"PR_1", "PR_2", "PR_3", "PR_4"} {
				g.setBody(id, body)
			}
			if tt.setup != nil {
				tt.setup(g, s)
			}
			drain(events)
			got, err := s.SetPullRequestCheckbox(ctx, "o/r", tt.number, tt.req)
			if tt.err != nil {
				if !errors.Is(err, tt.err) || !strings.Contains(err.Error(), tt.errHas) {
					t.Errorf("err = %v, want %v containing %q", err, tt.err, tt.errHas)
				}
			} else if err != nil || got != tt.want {
				t.Errorf("got %+v, %v; want %+v", got, err, tt.want)
			}
			if got := g.bodyOps(); !slices.Equal(got, tt.ops) {
				t.Errorf("ops = %q, want %q", got, tt.ops)
			}
			written := g.bodiesWritten()
			if tt.written == "" && len(written) != 0 || tt.written != "" && !slices.Equal(written, []string{tt.written}) {
				t.Errorf("written = %q, want %q", written, tt.written)
			}
			if sent := drain(events) > 0; sent != tt.event {
				t.Errorf("detail event sent = %t, want %t", sent, tt.event)
			}
			if tt.written == "" {
				return
			}
			// The next read fetches: the detail shows the new description.
			if d, err := s.FullPullRequest(ctx, "o/r", tt.number, false); err != nil || d.Body != tt.written {
				t.Errorf("detail body = %q, %v; want %q", d.Body, err, tt.written)
			}
		})
	}
}

// An edit on GitHub between two toggles survives the second: each reads again.
func TestSetPullRequestCheckboxReadsAgainEachTime(t *testing.T) {
	ctx := context.Background()
	g, _, s, _, _ := mergeWorld(t)
	g.setBody("PR_1", "- [ ] one\n- [ ] two\n")
	if _, err := s.SetPullRequestCheckbox(ctx, "o/r", 1, CheckboxChange{Text: "one", Checked: true}); err != nil {
		t.Fatal(err)
	}
	g.setBody("PR_1", g.body("PR_1")+"\nAdded on GitHub\n")
	if _, err := s.SetPullRequestCheckbox(ctx, "o/r", 1, CheckboxChange{Index: 1, Text: "two", Checked: true}); err != nil {
		t.Fatal(err)
	}
	if got, want := g.body("PR_1"), "- [x] one\n- [x] two\n\nAdded on GitHub\n"; got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

// Quick clicks on one pull request run one at a time, each from the last one's result:
// none overwrites another.
func TestSetPullRequestCheckboxSerialisesPerPullRequest(t *testing.T) {
	ctx := context.Background()
	g, _, s, _, _ := mergeWorld(t)
	const n = 8
	var body strings.Builder
	for i := range n {
		fmt.Fprintf(&body, "- [ ] task %d\n", i)
	}
	g.setBody("PR_1", body.String())
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Go(func() {
			_, errs[i] = s.SetPullRequestCheckbox(ctx, "o/r", 1, CheckboxChange{Index: i, Text: fmt.Sprintf("task %d", i), Checked: true})
		})
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("toggle %d: %v", i, err)
		}
	}
	if got, want := g.body("PR_1"), strings.ReplaceAll(body.String(), "[ ]", "[x]"); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
	ops := g.bodyOps()
	if len(ops) != 2*n {
		t.Fatalf("ops = %q", ops)
	}
	for i, op := range ops {
		if want := []string{"read PR_1", "write PR_1"}[i%2]; op != want {
			t.Errorf("op %d = %q, want %q: reads and writes must alternate (%q)", i, op, want, ops)
		}
	}
}

// Another pull request is not held up, and its lock is released after a refusal.
func TestSetPullRequestCheckboxLockIsPerPullRequestAndReleased(t *testing.T) {
	ctx := context.Background()
	g, _, s, _, _ := mergeWorld(t)
	g.setBody("PR_1", "- [ ] a\n")
	g.setBody("PR_2", "- [ ] b\n")
	if _, err := s.SetPullRequestCheckbox(ctx, "o/r", 1, CheckboxChange{Text: "stale", Checked: true}); !errors.Is(err, ErrFailedPrecondition) {
		t.Fatalf("err = %v", err)
	}
	unlock, err := s.full.mergeLocks.lock(ctx, fullKey{"o/r", 1})
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if _, err := s.SetPullRequestCheckbox(ctx, "o/r", 2, CheckboxChange{Text: "b", Checked: true}); err != nil {
		t.Errorf("another pull request: %v", err)
	}
	gone, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.SetPullRequestCheckbox(gone, "o/r", 1, CheckboxChange{Text: "a", Checked: true}); !errors.Is(err, context.Canceled) {
		t.Errorf("held lock, caller gone: %v", err)
	}
}
