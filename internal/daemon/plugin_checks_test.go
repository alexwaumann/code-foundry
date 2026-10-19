package daemon

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

type recordChecks struct {
	mu  sync.Mutex
	got []string
}

func (r *recordChecks) InvalidatePullRequestChecks(slug string, number int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, fmt.Sprintf("%s#%d", slug, number))
}

func (r *recordChecks) calls() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.got)
}

func TestPluginChecksFollowGhEvents(t *testing.T) {
	b := bus.New()
	r := &recordChecks{}
	stop := startPluginChecks(context.Background(), b, r)
	defer stop()
	changed := func(kinds ...gh.ChangeKind) func() {
		return func() {
			e := gh.PullRequestChanged{Slug: "o/r", Number: 1}
			for _, k := range kinds {
				e.Changes = append(e.Changes, gh.Change{Kind: k})
			}
			bus.Publish(b, e)
		}
	}
	tests := []struct {
		name        string
		publish     func()
		invalidates bool
	}{
		{"checks", changed(gh.ChangeChecks), true},
		{"head pushed", changed(gh.ChangeHeadPushed), true},
		{"merged with new checks", changed(gh.ChangeMerged, gh.ChangeChecks), true},
		{"review", changed(gh.ChangeReviews, gh.ChangeReviewDecision), false},
		{"title", changed(gh.ChangeTitle), false},
		{"appeared", changed(gh.ChangeAppeared), false},
		{"detail updated", func() { bus.Publish(b, gh.PullRequestDetailUpdated{Slug: "o/r", Number: 1}) }, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := len(r.calls())
			tt.publish()
			// A marker that always invalidates.
			bus.Publish(b, gh.PullRequestDetailUpdated{Slug: "marker", Number: 9})
			want := before + 1
			if tt.invalidates {
				want++
			}
			deadline := time.Now().Add(5 * time.Second)
			for len(r.calls()) < want && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			// The two topics are separate channels: the marker may be handled first.
			got := slices.Sorted(slices.Values(r.calls()[before:]))
			wantCalls := []string{"marker#9"}
			if tt.invalidates {
				wantCalls = []string{"marker#9", "o/r#1"}
			}
			if !slices.Equal(got, wantCalls) {
				t.Errorf("calls %v, want %v", got, wantCalls)
			}
		})
	}
}
