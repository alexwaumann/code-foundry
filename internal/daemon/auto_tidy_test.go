package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

const tidyDay = 24 * time.Hour

// tidyFake is the thread store for auto-tidy: its threads, AutoSave and AutoArchive applying
// the store's rules (thread.AutoSaveDue, thread.AutoArchiveDue) as the real one does under its
// lock, and the calls made.
type tidyFake struct {
	mu      sync.Mutex
	now     func() time.Time
	threads []thread.Thread
	calls   []string
}

func (f *tidyFake) Snapshot() *thread.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &thread.Snapshot{Threads: slices.Clone(f.threads)}
}

func (f *tidyFake) find(id string) int {
	return slices.IndexFunc(f.threads, func(t thread.Thread) bool { return t.ID == id })
}

func (f *tidyFake) AutoSave(_ context.Context, id string, after time.Duration, idleBefore time.Time) (thread.Thread, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "save "+id)
	i := f.find(id)
	if i < 0 {
		return thread.Thread{}, false, thread.ErrNotFound
	}
	t := &f.threads[i]
	if !thread.AutoSaveDue(*t, thread.Known(f.threads), idleBefore) {
		return *t, false, nil
	}
	t.SavedAt, t.AutoSavedAfter = f.now(), after
	return *t, true, nil
}

func (f *tidyFake) AutoArchive(_ context.Context, id string, savedBefore time.Time) (thread.Thread, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "archive "+id)
	i := f.find(id)
	if i < 0 {
		return thread.Thread{}, false, thread.ErrNotFound
	}
	t := &f.threads[i]
	if !thread.AutoArchiveDue(*t, thread.Known(f.threads), savedBefore) {
		return *t, false, nil
	}
	t.ArchivedAt, t.SavedAt, t.AutoSavedAfter = f.now(), time.Time{}, 0
	return *t, true, nil
}

// add puts threads idle since `idle` ago at their prompt, named name-1, name-2, ….
func (f *tidyFake) add(name string, n int, idle time.Duration) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var ids []string
	for i := range n {
		id := fmt.Sprintf("s-%s-%d", name, i+1)
		f.threads = append(f.threads, thread.Thread{
			ID: id, Name: fmt.Sprintf("%s %d", name, i+1), State: thread.StateDisconnected, Status: thread.StatusIdle,
			StatusReason: "at prompt", CreatedAt: f.now().Add(-idle), LastActivityAt: f.now().Add(-idle),
		})
		ids = append(ids, id)
	}
	return ids
}

func (f *tidyFake) set(id string, fn func(*thread.Thread)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(&f.threads[f.find(id)])
}

func (f *tidyFake) takeCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.calls
	f.calls = nil
	return c
}

// tidyEnv is auto-tidy over a fake thread store and the real notification store, its
// settings a test changes between ticks.
type tidyEnv struct {
	t        *testing.T
	threads  *tidyFake
	notes    *notificationtest.Store
	mu       sync.Mutex
	settings tidySettings
	a        autoTidy
}

func newTidyEnv(t *testing.T) *tidyEnv {
	notes := notificationtest.New(t, notificationtest.Options{})
	e := &tidyEnv{t: t, notes: notes, threads: &tidyFake{now: notes.Clock.Now}}
	e.settings = tidySettings{SaveAfter: "off", ArchiveAfter: "off"}
	e.a = autoTidy{o: e.options()}
	return e
}

func (e *tidyEnv) options() autoTidyOptions {
	return autoTidyOptions{
		Log: slog.New(slog.DiscardHandler), Threads: e.threads, Notes: e.notes, Now: e.notes.Clock.Now,
		Settings: func() tidySettings {
			e.mu.Lock()
			defer e.mu.Unlock()
			return e.settings
		},
	}
}

func (e *tidyEnv) set(save, archive string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.settings = tidySettings{SaveAfter: save, ArchiveAfter: archive}
}

func (e *tidyEnv) tick() { e.a.tick(context.Background()) }

// cards are SourceThreads' active notifications.
func (e *tidyEnv) cards() []notification.Notification {
	var out []notification.Notification
	for _, n := range e.notes.Snapshot().Notifications {
		if n.Source == notification.SourceThreads {
			out = append(out, n)
		}
	}
	return out
}

// card is the one active card under key; it fails when there is none.
func (e *tidyEnv) card(key string) notification.Notification {
	e.t.Helper()
	n, ok := e.notes.Active(notification.SourceThreads, key)
	if !ok {
		e.t.Fatalf("no active %s card; cards %+v", key, e.cards())
	}
	return n
}

func TestTidyPlan(t *testing.T) {
	now := notificationtest.T0
	idle := func(id string) thread.Thread {
		return thread.Thread{ID: id, State: thread.StateDisconnected, Status: thread.StatusIdle, StatusReason: "at prompt", LastActivityAt: now.Add(-10 * tidyDay)}
	}
	saved := func(id string) thread.Thread {
		s := idle(id)
		s.SavedAt = now.Add(-10 * tidyDay)
		return s
	}
	threads := []thread.Thread{idle("s-1"), idle("s-2"), idle("s-3"), saved("s-4"), saved("s-5")}
	tests := []struct {
		name                    string
		notes                   []notification.Notification
		idleBefore, savedBefore time.Time
		save, archive           []string
	}{
		{name: "both off"},
		{name: "save only", idleBefore: now.Add(-3 * tidyDay), save: []string{"s-1", "s-2", "s-3"}},
		{name: "archive only", savedBefore: now.Add(-7 * tidyDay), archive: []string{"s-4", "s-5"}},
		{name: "both", idleBefore: now.Add(-3 * tidyDay), savedBefore: now.Add(-7 * tidyDay), save: []string{"s-1", "s-2", "s-3"}, archive: []string{"s-4", "s-5"}},
		{name: "a notification names a thread", idleBefore: now.Add(-3 * tidyDay), savedBefore: now.Add(-7 * tidyDay),
			notes: []notification.Notification{{Source: "github", ThreadID: "s-2"}, {Source: "x", ThreadID: "s-4"}},
			save:  []string{"s-1", "s-3"}, archive: []string{"s-5"}},
		{name: "a notification's action names a thread", idleBefore: now.Add(-3 * tidyDay),
			notes: []notification.Notification{{Source: "github", Actions: []notification.Action{{Kind: notification.KindSend, ThreadID: "s-3"}}}},
			save:  []string{"s-1", "s-2"}},
		{name: "not idle long enough", idleBefore: now.Add(-30 * tidyDay), savedBefore: now.Add(-30 * tidyDay)},
	}
	ids := func(ts []thread.Thread) []string {
		var out []string
		for _, t := range ts {
			out = append(out, t.ID)
		}
		return out
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			save, archive := tidyPlan(threads, tt.notes, tt.idleBefore, tt.savedBefore)
			if got := ids(save); !slices.Equal(got, tt.save) {
				t.Errorf("save = %v, want %v", got, tt.save)
			}
			if got := ids(archive); !slices.Equal(got, tt.archive) {
				t.Errorf("archive = %v, want %v", got, tt.archive)
			}
		})
	}
}

func TestTidyCard(t *testing.T) {
	named := func(names ...string) []thread.Thread {
		var out []thread.Thread
		for i, n := range names {
			out = append(out, thread.Thread{ID: fmt.Sprintf("s-%d", i), Name: n})
		}
		return out
	}
	tests := []struct {
		key, title, body string
		threads          []thread.Thread
	}{
		{tidySavedKey, "1 idle thread was saved for later", "Under Snoozed: Fix login.", named("Fix login")},
		{tidySavedKey, "2 idle threads were saved for later", "Under Snoozed: A and B.", named("A", "B")},
		{tidySavedKey, "3 idle threads were saved for later", "Under Snoozed: A, B and C.", named("A", "B", "C")},
		{tidySavedKey, "5 idle threads were saved for later", "Under Snoozed: A, B, C and 2 more.", named("A", "B", "C", "D", "E")},
		{tidySavedKey, "1 idle thread was saved for later", "Under Snoozed: s-0.", named("")},
		{tidyArchivedKey, "1 saved thread was archived", "Under Archived: A.", named("A")},
		{tidyArchivedKey, "4 saved threads were archived", "Under Archived: A, B, C and 1 more.", named("A", "B", "C", "D")},
	}
	store := notificationtest.New(t, notificationtest.Options{})
	for _, tt := range tests {
		p := tidyCard(tt.key, tt.threads)
		if p.Title != tt.title || p.Body != tt.body || p.Level != notification.LevelInfo || p.TimeSensitive || p.Source != notification.SourceThreads || p.Key != tt.key {
			t.Errorf("tidyCard(%s, %d) = %q / %q (%s, ts %v, %s/%s); want %q / %q, info", tt.key, len(tt.threads), p.Title, p.Body, p.Level, p.TimeSensitive, p.Source, p.Key, tt.title, tt.body)
		}
		if len(p.Actions) != 1 || p.Actions[0].Command != "view.settings" || p.Actions[0].Args["page"] != "general" {
			t.Errorf("tidyCard actions = %+v; want Open settings on General", p.Actions)
		}
		if err := store.Check(p); err != nil {
			t.Errorf("tidyCard(%s): the store refuses it: %v", tt.key, err)
		}
	}
}

// Settings off (the default): nothing is saved, archived or posted, however long idle.
func TestAutoTidyOff(t *testing.T) {
	e := newTidyEnv(t)
	e.threads.add("idle", 3, 400*tidyDay)
	e.tick()
	if calls := e.threads.takeCalls(); len(calls) != 0 {
		t.Errorf("calls with both off = %v; want none", calls)
	}
	if cards := e.cards(); len(cards) != 0 {
		t.Errorf("cards with both off = %+v; want none", cards)
	}
}

// Each tick that saved threads posts one card under the fixed key, replacing the last: in
// place while it is shown, anew once the user dismissed it.
func TestAutoTidyOneCardPerTick(t *testing.T) {
	e := newTidyEnv(t)
	e.threads.add("old", 5, 4*tidyDay)
	fresh := e.threads.add("fresh", 1, 2*tidyDay)
	e.set("3d", "off")

	e.tick()
	first := e.card(tidySavedKey)
	if first.Title != "5 idle threads were saved for later" || first.Body != "Under Snoozed: old 1, old 2, old 3 and 2 more." {
		t.Errorf("first card = %q / %q", first.Title, first.Body)
	}
	if n := len(e.cards()); n != 1 {
		t.Errorf("%d cards; want one", n)
	}
	for _, th := range e.threads.Snapshot().Threads {
		saved := th.ID != fresh[0]
		if saved != !th.SavedAt.IsZero() || saved != (th.AutoSavedAfter == 3*tidyDay) {
			t.Errorf("%s: SavedAt %v mark %v; want saved %v by the 3-day setting", th.ID, th.SavedAt, th.AutoSavedAfter, saved)
		}
	}

	// A tick with nothing to do leaves the card.
	e.tick()
	if again := e.card(tidySavedKey); again.ID != first.ID || again.Title != first.Title {
		t.Errorf("after an empty tick: %+v; want the same card", again)
	}

	// The fresh thread comes due: the same card, replaced in place.
	e.notes.Clock.Advance(1*tidyDay + time.Minute)
	e.tick()
	second := e.card(tidySavedKey)
	if second.ID != first.ID || second.Title != "1 idle thread was saved for later" || second.Body != "Under Snoozed: fresh 1." || !second.ArrivedAt.Equal(first.ArrivedAt) {
		t.Errorf("second card = %s %q / %q arrived %v; want %s replaced in place", second.ID, second.Title, second.Body, second.ArrivedAt, first.ID)
	}
	if n := len(e.cards()); n != 1 {
		t.Errorf("%d cards; want one", n)
	}

	// Dismissed, then the same thread saved again (unsnoozed, idle again): it arrives anew.
	if _, err := e.notes.Dismiss(context.Background(), second.ID); err != nil {
		t.Fatal(err)
	}
	e.threads.set(fresh[0], func(th *thread.Thread) { th.SavedAt, th.AutoSavedAfter = time.Time{}, 0 })
	e.notes.Clock.Advance(time.Minute)
	e.tick()
	third := e.card(tidySavedKey)
	if third.Body != second.Body || !third.ArrivedAt.After(second.ArrivedAt) {
		t.Errorf("after a dismissal: %q arrived %v; want the same words arriving anew after %v", third.Body, third.ArrivedAt, second.ArrivedAt)
	}
}

// A setting changed applies at the next tick; archives get their own card.
func TestAutoTidySettingsChange(t *testing.T) {
	e := newTidyEnv(t)
	ids := e.threads.add("idle", 2, 10*tidyDay)
	e.set("1w", "off")
	e.tick()
	if got := e.threads.takeCalls(); !slices.Equal(got, []string{"save " + ids[0], "save " + ids[1]}) {
		t.Fatalf("calls = %v", got)
	}

	// Archive turned on: not before the saves are a month old.
	e.set("off", "1mo")
	e.notes.Clock.Advance(29 * tidyDay)
	e.tick()
	if _, ok := e.notes.Active(notification.SourceThreads, tidyArchivedKey); ok {
		t.Error("archived within the month")
	}
	e.notes.Clock.Advance(2 * tidyDay)
	e.tick()
	card := e.card(tidyArchivedKey)
	if card.Title != "2 saved threads were archived" || card.Body != "Under Archived: idle 1 and idle 2." {
		t.Errorf("archive card = %q / %q", card.Title, card.Body)
	}
	for _, th := range e.threads.Snapshot().Threads {
		if th.ArchivedAt.IsZero() || th.Snoozed() {
			t.Errorf("%s: archived %v snoozed %v; want archived", th.ID, th.ArchivedAt, th.Snoozed())
		}
	}
	if n := len(e.cards()); n != 2 {
		t.Errorf("%d cards; want the save's and the archive's", n)
	}

	// Turned off again: the next tick does nothing.
	e.threads.add("later", 1, 100*tidyDay)
	e.set("off", "off")
	e.takeAndTick()
	if calls := e.threads.takeCalls(); len(calls) != 0 {
		t.Errorf("calls once off = %v", calls)
	}
}

func (e *tidyEnv) takeAndTick() {
	e.threads.takeCalls()
	e.tick()
}

// The first tick runs at start, so what fell due while the daemon was stopped (or the Mac
// asleep) is done then; a dev daemon's day scales the settings, not the mark.
func TestAutoTidyAtStart(t *testing.T) {
	e := newTidyEnv(t)
	ids := e.threads.add("idle", 1, 4*time.Second)
	e.set("3d", "off")
	ticked := make(chan struct{}, 4)
	o := e.options()
	o.Interval, o.Day = time.Hour, time.Second
	o.Ticked = func() { ticked <- struct{}{} }
	stop := startAutoTidy(context.Background(), o)
	<-ticked
	stop()
	got := e.threads.Snapshot().Threads[0]
	if got.ID != ids[0] || got.SavedAt.IsZero() || got.AutoSavedAfter != 3*tidyDay {
		t.Errorf("after the start tick (3 s days): SavedAt %v mark %v; want saved, marked 3 days", got.SavedAt, got.AutoSavedAfter)
	}
	e.card(tidySavedKey)
}
