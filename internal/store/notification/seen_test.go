package notification_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
)

// seenOf returns whether id is seen, failing the test when it is not in the store.
func seenOf(t *testing.T, s *notificationtest.Store, id string) bool {
	t.Helper()
	n, err := s.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	return n.Seen
}

func mustPost(t *testing.T, s *notificationtest.Store, p notification.Post) string {
	t.Helper()
	res, err := s.Post(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	return res.Notification.ID
}

func mustSee(t *testing.T, s *notificationtest.Store, id string) int {
	t.Helper()
	k, err := s.See(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// Every arrival makes a notification unseen; an in-place update, a snooze or a show_at still
// to come does not; See marks every shown one or one by id; acting marks only that one.
func TestSeen(t *testing.T) {
	ctx := context.Background()
	other := notification.Post{Source: "ci", Key: "deploy", Title: "Deploy waiting"}
	open := []notification.ActionSpec{{Action: notification.Action{Label: "Logs", Kind: notification.KindOpen, URL: "https://ci.example.com/1"}}}
	for _, tt := range []struct {
		name string
		// do runs on a store holding the "build" notification (id), posted and seen, and
		// "deploy" (otherID), posted and unseen.
		do          func(t *testing.T, s *notificationtest.Store, id, otherID string)
		wantSeen    bool
		wantOther   bool
		wantUnseen  int // the snapshot's count
		wantArrived bool
	}{
		{name: "seen stays seen", do: func(*testing.T, *notificationtest.Store, string, string) {},
			wantSeen: true, wantUnseen: 1},
		{name: "an in-place update keeps it seen", do: func(t *testing.T, s *notificationtest.Store, _, _ string) {
			p := post("Build failed")
			p.Body = "3 tests failed"
			mustPost(t, s, p)
		}, wantSeen: true, wantUnseen: 1},
		{name: "an in-place update keeps the other unseen", do: func(t *testing.T, s *notificationtest.Store, _, _ string) {
			p := other
			p.Body = "two approvals"
			mustPost(t, s, p)
		}, wantSeen: true, wantUnseen: 1},
		{name: "a show_at coming due arrives unseen", do: func(t *testing.T, s *notificationtest.Store, _, _ string) {
			p := post("Build failed")
			p.ShowAt = s.Clock.Now().Add(time.Hour)
			mustPost(t, s, p) // leaves the bell until then
			s.Clock.Advance(time.Hour)
			s.Tick()
		}, wantUnseen: 2, wantArrived: true},
		{name: "a snooze ending arrives unseen", do: func(t *testing.T, s *notificationtest.Store, id, _ string) {
			if _, err := s.Snooze(ctx, id, s.Clock.Now().Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			if !seenOf(t, s, id) {
				t.Error("snoozing made it unseen")
			}
			s.Clock.Advance(time.Hour)
			s.Tick()
		}, wantUnseen: 2, wantArrived: true},
		{name: "a dismissed key with new content arrives unseen", do: func(t *testing.T, s *notificationtest.Store, id, _ string) {
			if _, err := s.Dismiss(ctx, id); err != nil {
				t.Fatal(err)
			}
			mustPost(t, s, post("Build failed again"))
		}, wantUnseen: 2, wantArrived: true},
		{name: "a withdrawn key posted again arrives unseen", do: func(t *testing.T, s *notificationtest.Store, _, _ string) {
			if _, err := s.Withdraw(ctx, "ci", "build"); err != nil {
				t.Fatal(err)
			}
			mustPost(t, s, post("Build failed"))
		}, wantUnseen: 2, wantArrived: true},
		{name: "see all", do: func(t *testing.T, s *notificationtest.Store, _, _ string) {
			if k := mustSee(t, s, ""); k != 1 {
				t.Errorf("see all marked %d, want 1", k)
			}
		}, wantSeen: true, wantOther: true},
		{name: "see one", do: func(t *testing.T, s *notificationtest.Store, _, otherID string) {
			if k := mustSee(t, s, otherID); k != 1 {
				t.Errorf("see one marked %d, want 1", k)
			}
			if k := mustSee(t, s, otherID); k != 0 {
				t.Errorf("seeing it again marked %d, want 0", k)
			}
		}, wantSeen: true, wantOther: true},
		{name: "see all leaves a snoozed one for its arrival", do: func(t *testing.T, s *notificationtest.Store, _, otherID string) {
			if _, err := s.Snooze(ctx, otherID, s.Clock.Now().Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			if k := mustSee(t, s, ""); k != 0 {
				t.Errorf("see all marked %d, want 0", k)
			}
			s.Clock.Advance(time.Hour)
			s.Tick()
		}, wantSeen: true, wantUnseen: 1, wantArrived: true},
		{name: "acting marks that one seen, not the others", do: func(t *testing.T, s *notificationtest.Store, _, _ string) {
			p := notification.Post{Source: "ci", Key: "logs", Title: "Logs ready", Actions: open}
			id := mustPost(t, s, p)
			if _, _, err := s.Act(ctx, id, 0, func(context.Context, notification.Notification, notification.Action) error { return nil }); err != nil {
				t.Fatal(err)
			}
			if !seenOf(t, s, id) {
				t.Error("acted on, still unseen")
			}
		}, wantSeen: true, wantUnseen: 1, wantArrived: true},
		{name: "a failed action still marks it seen", do: func(t *testing.T, s *notificationtest.Store, _, _ string) {
			p := notification.Post{Source: "ci", Key: "logs", Title: "Logs ready", Actions: open}
			id := mustPost(t, s, p)
			if _, _, err := s.Act(ctx, id, 0, func(context.Context, notification.Notification, notification.Action) error { return errors.New("boom") }); err == nil {
				t.Fatal("the failure was lost")
			}
			if !seenOf(t, s, id) {
				t.Error("acted on, still unseen")
			}
		}, wantSeen: true, wantUnseen: 1, wantArrived: true},
		{name: "a refused act does not mark it seen", do: func(t *testing.T, s *notificationtest.Store, _, _ string) {
			p := notification.Post{Source: "ci", Key: "logs", Title: "Logs ready", Actions: open}
			id := mustPost(t, s, p)
			if _, _, err := s.Act(ctx, id, 3, func(context.Context, notification.Notification, notification.Action) error { return nil }); !errors.Is(err, notification.ErrInvalidArgument) {
				t.Fatalf("err %v", err)
			}
			if seenOf(t, s, id) {
				t.Error("a refused act marked it seen")
			}
		}, wantSeen: true, wantUnseen: 2, wantArrived: true},
		{name: "a restart keeps both", do: func(t *testing.T, s *notificationtest.Store, _, _ string) {
			s.Reopen(t)
		}, wantSeen: true, wantUnseen: 1},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := notificationtest.New(t, notificationtest.Options{})
			id := mustPost(t, s, post("Build failed"))
			if seenOf(t, s, id) {
				t.Fatal("a first post arrived seen")
			}
			if k := mustSee(t, s, ""); k != 1 {
				t.Fatalf("see all marked %d, want 1", k)
			}
			otherID := mustPost(t, s, other)
			ev := watch(t, s)
			tt.do(t, s, id, otherID)
			if got := seenOf(t, s, id); got != tt.wantSeen {
				t.Errorf("build seen %v, want %v", got, tt.wantSeen)
			}
			if got := seenOf(t, s, otherID); got != tt.wantOther {
				t.Errorf("deploy seen %v, want %v", got, tt.wantOther)
			}
			if got := s.Snapshot().Unseen; got != tt.wantUnseen {
				t.Errorf("snapshot unseen %d, want %d", got, tt.wantUnseen)
			}
			if arrived, _ := ev.take(); (len(arrived) > 0) != tt.wantArrived {
				t.Errorf("arrived %v, want an arrival %v", arrived, tt.wantArrived)
			}
		})
	}
}

// See publishes the change with no arrival or update (nothing toasts), leaves UpdatedAt,
// and refuses an unknown id.
func TestSeeEvent(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	id := mustPost(t, s, post("Build failed"))
	before, _ := s.Get(id)
	ev := watch(t, s)
	s.Clock.Advance(time.Minute)
	v := s.Snapshot().Version
	mustSee(t, s, id)
	if s.Snapshot().Version != v+1 {
		t.Errorf("version %d, want %d", s.Snapshot().Version, v+1)
	}
	if arrived, updated := ev.take(); len(arrived)+len(updated) != 0 {
		t.Errorf("seeing it arrived %v updated %v", arrived, updated)
	}
	if after, _ := s.Get(id); !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Errorf("updated at %s, want %s kept", after.UpdatedAt, before.UpdatedAt)
	}
	if _, err := s.See(ctx, "n-000000000000"); !errors.Is(err, notification.ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
	v = s.Snapshot().Version
	if k := mustSee(t, s, ""); k != 0 || s.Snapshot().Version != v {
		t.Errorf("nothing to see marked %d and moved the version to %d", k, s.Snapshot().Version)
	}
}

// A row written without the seen column (as every row before migration 0064) loads seen: an
// upgrade lights no badge for notifications the user already had.
func TestSeenDefaultsForOldRows(t *testing.T) {
	s := notificationtest.New(t, notificationtest.Options{})
	if _, err := s.DB.Exec(`INSERT INTO notifications (id, source, key, level, title, state, created_at, updated_at, arrived_at)
		VALUES ('n-0123456789ab', 'ci', 'old', 'info', 'From before', 'active', 1, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	s.Reopen(t)
	if !seenOf(t, s, "n-0123456789ab") || s.Snapshot().Unseen != 0 {
		t.Errorf("an old row: seen %v, snapshot unseen %d", seenOf(t, s, "n-0123456789ab"), s.Snapshot().Unseen)
	}
}
