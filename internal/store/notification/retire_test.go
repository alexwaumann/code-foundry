package notification_test

import (
	"context"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
)

// Retire withdraws a key in any state but withdrawn, so the same content posted later is a
// new arrival (Withdraw leaves a dismissed one dismissed); Keys lists what it would change.
func TestRetireKeys(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	yes := true
	post := func(source, key string) notification.PostResult {
		t.Helper()
		r, err := s.Post(ctx, notification.Post{Source: source, Key: key, Title: "Hello stopped", Body: "boom",
			Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Docs", Kind: notification.KindOpen, URL: "https://example.com"}, Resolves: &yes}}})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	post("plugins", "shown")
	dismissed := post("plugins", "dismissed")
	resolved := post("plugins", "resolved")
	post("plugins", "withdrawn")
	post("other", "shown")
	if _, err := s.Dismiss(ctx, dismissed.Notification.ID); err != nil {
		t.Fatal(err)
	}
	ran := func(context.Context, notification.Notification, notification.Action) error { return nil }
	if n, _, err := s.Act(ctx, resolved.Notification.ID, 0, ran); err != nil || n.State != notification.StateResolved {
		t.Fatalf("Act = %v, %v", n.State, err)
	}
	if _, err := s.Withdraw(ctx, "plugins", "withdrawn"); err != nil {
		t.Fatal(err)
	}
	if got := s.Keys("plugins"); !slices.Equal(got, []string{"dismissed", "resolved", "shown"}) {
		t.Fatalf("Keys = %v", got)
	}

	// Withdraw leaves the dismissed one closed: the same content stays dismissed.
	if n, err := s.Withdraw(ctx, "plugins", "dismissed"); err != nil || n.State != notification.StateDismissed {
		t.Fatalf("Withdraw(dismissed) = %v, %v", n.State, err)
	}
	if r := post("plugins", "dismissed"); r.Outcome != notification.OutcomeUnchanged {
		t.Fatalf("re-post of a dismissed one: %s", r.Outcome)
	}

	for _, tt := range []struct {
		key  string
		want bool
	}{{"shown", true}, {"dismissed", true}, {"resolved", true}, {"withdrawn", false}, {"none", false}, {"shown", false}} {
		if got, err := s.Retire(ctx, "plugins", tt.key); got != tt.want || err != nil {
			t.Errorf("Retire(%s) = %v, %v; want %v", tt.key, got, err, tt.want)
		}
	}
	if got := s.Keys("plugins"); len(got) != 0 {
		t.Errorf("Keys after = %v", got)
	}
	if _, ok := s.Active("other", "shown"); !ok {
		t.Error("another source's went")
	}
	// Retired, the same content is a new arrival.
	if r := post("plugins", "dismissed"); r.Outcome != notification.OutcomePosted || r.Notification.Status() != notification.StatusShown {
		t.Errorf("re-post after Retire: %s %s", r.Outcome, r.Notification.Status())
	}
}
