package notification_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
)

// Check refuses what Post would, without posting; WithdrawSource withdraws one source's
// active notifications only; Sources and Active read the active ones.
func TestCheckWithdrawSourceSources(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{Threads: []string{"s-1"}})
	checks := []struct {
		name string
		p    notification.Post
		want error
	}{
		{"ok", notification.Post{Source: "ci", Title: "Build failed"}, nil},
		{"no title", notification.Post{Source: "ci"}, notification.ErrInvalidArgument},
		{"unknown thread", notification.Post{Source: "ci", Title: "x", ThreadID: "s-2"}, notification.ErrNotFound},
		{"command action from command", notification.Post{Source: notification.SourceCommand, Title: "x",
			Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Go", Kind: notification.KindCommand, Command: "go"}}}}, notification.ErrInvalidArgument},
	}
	for _, c := range checks {
		if err := s.Check(c.p); !errors.Is(err, c.want) || (c.want == nil && err != nil) {
			t.Errorf("%s: Check = %v, want %v", c.name, err, c.want)
		}
	}
	if n := len(s.Snapshot().Notifications); n != 0 {
		t.Fatalf("Check posted %d notifications", n)
	}

	for _, p := range []notification.Post{
		{Source: "ci", Key: "a", Title: "A"}, {Source: "ci", Key: "b", Title: "B"}, {Source: "deploy", Key: "a", Title: "A"},
	} {
		if _, err := s.Post(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	dismissed, _ := s.Active("ci", "b")
	if _, err := s.Dismiss(ctx, dismissed.ID); err != nil {
		t.Fatal(err)
	}
	if got := s.Sources(); !slices.Equal(got, []string{"ci", "deploy"}) {
		t.Errorf("Sources = %v", got)
	}
	n, err := s.WithdrawSource(ctx, "ci")
	if err != nil || n != 1 {
		t.Fatalf("WithdrawSource = %d, %v; want the one active", n, err)
	}
	if got := s.Sources(); !slices.Equal(got, []string{"deploy"}) {
		t.Errorf("Sources after = %v", got)
	}
	if _, ok := s.Active("deploy", "a"); !ok {
		t.Error("another source's notification went")
	}
	if got, _ := s.Get(dismissed.ID); got.State != notification.StateDismissed {
		t.Errorf("a dismissed one became %s", got.State)
	}
	if n, err := s.WithdrawSource(ctx, "ci"); err != nil || n != 0 {
		t.Errorf("again = %d, %v", n, err)
	}
}
