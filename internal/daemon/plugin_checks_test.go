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
	changed := func(slug string, number int, kinds ...gh.ChangeKind) func() {
		return func() {
			e := gh.PullRequestChanged{Slug: slug, Number: number}
			for _, k := range kinds {
				e.Changes = append(e.Changes, gh.Change{Kind: k})
			}
			bus.Publish(b, e)
		}
	}
	// Markers that always invalidate, published on the event's own topic: per-topic
	// order then proves the event before the marker has been handled.
	changedMarker := changed("marker", 9, gh.ChangeChecks)
	detailMarker := func() { bus.Publish(b, gh.PullRequestDetailUpdated{Slug: "marker", Number: 9}) }
	tests := []struct {
		name        string
		publish     func()
		marker      func()
		invalidates bool
	}{
		{"checks", changed("o/r", 1, gh.ChangeChecks), changedMarker, true},
		{"head pushed", changed("o/r", 1, gh.ChangeHeadPushed), changedMarker, true},
		{"merged with new checks", changed("o/r", 1, gh.ChangeMerged, gh.ChangeChecks), changedMarker, true},
		{"review", changed("o/r", 1, gh.ChangeReviews, gh.ChangeReviewDecision), changedMarker, false},
		{"title", changed("o/r", 1, gh.ChangeTitle), changedMarker, false},
		{"appeared", changed("o/r", 1, gh.ChangeAppeared), changedMarker, false},
		{"detail updated", func() { bus.Publish(b, gh.PullRequestDetailUpdated{Slug: "o/r", Number: 1}) }, detailMarker, true},
		{"detail fetched, unchanged", func() { bus.Publish(b, gh.PullRequestDetailUpdated{Slug: "o/r", Number: 1, Unchanged: true}) }, detailMarker, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := len(r.calls())
			tt.publish()
			tt.marker()
			want := before + 1
			if tt.invalidates {
				want++
			}
			deadline := time.Now().Add(5 * time.Second)
			for len(r.calls()) < want && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			got := r.calls()[before:]
			wantCalls := []string{"marker#9"}
			if tt.invalidates {
				wantCalls = []string{"o/r#1", "marker#9"}
			}
			if !slices.Equal(got, wantCalls) {
				t.Errorf("calls %v, want %v", got, wantCalls)
			}
		})
	}
}
