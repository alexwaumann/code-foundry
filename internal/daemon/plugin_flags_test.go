package daemon

//lint:file-ignore SA1019 tests of the deprecated thread/setFlag's reroute (pluginsdk/removals.go)

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// fakeFlagThreads is the thread store as flags read it: s-1, s-2 and the archived s-arch;
// seen says which the user sees now.
type fakeFlagThreads struct {
	mu   sync.Mutex
	seen map[string]bool
	snap *thread.Snapshot
	hook func(string)
}

func newFakeFlagThreads() *fakeFlagThreads {
	return &fakeFlagThreads{seen: map[string]bool{}, snap: &thread.Snapshot{Threads: []thread.Thread{
		{ID: "s-1"}, {ID: "s-2"}, {ID: "s-arch", ArchivedAt: time.Unix(1, 0)},
	}}}
}

func (f *fakeFlagThreads) Snapshot() *thread.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

func (f *fakeFlagThreads) Seen(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.seen[id]
}

func (f *fakeFlagThreads) SetSeenHook(h func(string)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hook = h
}

func (f *fakeFlagThreads) archive(id string) thread.Thread {
	f.mu.Lock()
	defer f.mu.Unlock()
	threads := slices.Clone(f.snap.Threads)
	i := slices.IndexFunc(threads, func(t thread.Thread) bool { return t.ID == id })
	threads[i].ArchivedAt = time.Unix(2, 0)
	f.snap = &thread.Snapshot{Threads: threads}
	return threads[i]
}

// flagState is every flag notification as "source key level title state", by key.
func flagState(s *notificationtest.Store) []string {
	var out []string
	for _, n := range s.List(true) {
		if n.IsFlag() || strings.HasPrefix(n.Key, notification.FlagKeyPrefix) {
			out = append(out, fmt.Sprintf("%s %s %s %q %s", n.Source, n.Key, n.Level, n.Title, n.Status()))
		}
	}
	slices.Sort(out)
	return out
}

func spec(level, reason string, untilSeen bool) plugin.FlagSpec {
	return plugin.FlagSpec{Plugin: "hello", DisplayName: "Hello", Level: level, Reason: reason, UntilSeen: untilSeen}
}

// Each reroute rule of thread/setFlag: a flag is a notification naming its thread.
func TestPluginFlagsReroute(t *testing.T) {
	const (
		attention = pluginsdk.FlagAttention
		errLevel  = pluginsdk.FlagError
		none      = pluginsdk.FlagNone
	)
	type step struct {
		do      func(f pluginFlags, th *fakeFlagThreads, s *notificationtest.Store) (bool, error)
		changed bool
		err     error
		want    []string // flagState after it
	}
	set := func(id string, sp plugin.FlagSpec) func(pluginFlags, *fakeFlagThreads, *notificationtest.Store) (bool, error) {
		return func(f pluginFlags, _ *fakeFlagThreads, _ *notificationtest.Store) (bool, error) {
			return f.SetFlag(context.Background(), id, sp)
		}
	}
	dismiss := func(key string) func(pluginFlags, *fakeFlagThreads, *notificationtest.Store) (bool, error) {
		return func(_ pluginFlags, _ *fakeFlagThreads, s *notificationtest.Store) (bool, error) {
			n, ok := s.Active("hello", key)
			if !ok {
				return false, errors.New("nothing to dismiss")
			}
			_, err := s.Dismiss(context.Background(), n.ID)
			return false, err
		}
	}
	see := func(id string) func(pluginFlags, *fakeFlagThreads, *notificationtest.Store) (bool, error) {
		return func(_ pluginFlags, th *fakeFlagThreads, _ *notificationtest.Store) (bool, error) {
			th.mu.Lock()
			defer th.mu.Unlock()
			th.seen[id] = true
			return false, nil
		}
	}
	sticky := `hello flag:s-1 warning "deploy failed" shown`
	tests := []struct {
		name  string
		steps []step
	}{
		{"attention is a warning titled with the reason; the same again is no change", []step{
			{do: set("s-1", spec(attention, "deploy failed", false)), changed: true, want: []string{sticky}},
			{do: set("s-1", spec(attention, "deploy failed", false)), changed: false, want: []string{sticky}},
		}},
		{"error is an error, updated in place", []step{
			{do: set("s-1", spec(attention, "deploy failed", false)), changed: true},
			{do: set("s-1", spec(errLevel, "deploy broke", false)), changed: true, want: []string{`hello flag:s-1 error "deploy broke" shown`}},
		}},
		{"an empty reason names the plugin", []step{
			{do: set("s-1", spec(attention, "", false)), changed: true, want: []string{`hello flag:s-1 warning "Hello flagged this thread" shown`}},
		}},
		{"none withdraws; none again is no change", []step{
			{do: set("s-1", spec(attention, "deploy failed", false)), changed: true},
			{do: set("s-1", spec(none, "", false)), changed: true, want: []string{`hello flag:s-1 warning "deploy failed" withdrawn`}},
			{do: set("s-1", spec(none, "", false)), changed: false},
			{do: set("s-1", spec(attention, "deploy failed", false)), changed: true, want: []string{sticky}},
		}},
		{"one flag per plugin and thread: until-seen replaces sticky and back", []step{
			{do: set("s-1", spec(attention, "deploy failed", false)), changed: true},
			{do: set("s-1", spec(attention, "look", true)), changed: true, want: []string{
				`hello flag:s-1 warning "deploy failed" withdrawn`, `hello flag:s-1:until-seen warning "look" shown`}},
			{do: set("s-1", spec(none, "", true)), changed: true, want: []string{
				`hello flag:s-1 warning "deploy failed" withdrawn`, `hello flag:s-1:until-seen warning "look" withdrawn`}},
		}},
		{"until-seen on a thread the user sees is never shown", []step{
			{do: see("s-1")},
			{do: set("s-1", spec(attention, "look", true)), changed: false, want: nil},
			{do: set("s-1", spec(attention, "kept", false)), changed: true, want: []string{`hello flag:s-1 warning "kept" shown`}},
			{do: set("s-1", spec(attention, "look", true)), changed: true, want: []string{`hello flag:s-1 warning "kept" withdrawn`}},
		}},
		{"a dismissed flag stays dismissed while it says the same; changed, it is back", []step{
			{do: set("s-1", spec(attention, "deploy failed", false)), changed: true},
			{do: dismiss("flag:s-1"), want: []string{`hello flag:s-1 warning "deploy failed" dismissed`}},
			{do: set("s-1", spec(attention, "deploy failed", false)), changed: false, want: []string{`hello flag:s-1 warning "deploy failed" dismissed`}},
			{do: set("s-1", spec(errLevel, "deploy failed", false)), changed: true, want: []string{`hello flag:s-1 error "deploy failed" shown`}},
		}},
		{"an archived thread refuses a flag; none is fine", []step{
			{do: set("s-arch", spec(attention, "x", false)), err: plugin.ErrFailedPrecondition},
			{do: set("s-arch", spec(none, "", false)), changed: false},
		}},
		{"an unknown thread", []step{
			{do: set("s-9", spec(attention, "x", false)), err: plugin.ErrNotFound},
			{do: set("s-9", spec(none, "", false)), err: plugin.ErrNotFound},
		}},
		{"a bad level", []step{
			{do: set("s-1", spec("loud", "x", false)), err: plugin.ErrInvalidArgument},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := notificationtest.New(t, notificationtest.Options{})
			th := newFakeFlagThreads()
			f := pluginFlags{threads: th, notes: s}
			for i, st := range tt.steps {
				changed, err := st.do(f, th, s)
				if st.err != nil {
					if !errors.Is(err, st.err) {
						t.Fatalf("step %d: err %v, want %v", i, err, st.err)
					}
					continue
				}
				if err != nil || changed != st.changed {
					t.Fatalf("step %d: changed %v, %v; want %v", i, changed, err, st.changed)
				}
				if st.want != nil || i == len(tt.steps)-1 {
					if got := flagState(s); !slices.Equal(got, st.want) {
						t.Fatalf("step %d: %q, want %q", i, got, st.want)
					}
				}
			}
		})
	}
}

// Of reads the live flags back from the active flag notifications: not the plugin's own
// notifications, not another plugin's, not a dismissed or withdrawn one.
func TestPluginFlagsOf(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	th := newFakeFlagThreads()
	f := pluginFlags{threads: th, notes: s}
	must := func(_ bool, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(f.SetFlag(ctx, "s-1", spec(pluginsdk.FlagError, "red", false)))
	s.Clock.Advance(time.Second)
	must(f.SetFlag(ctx, "s-2", spec(pluginsdk.FlagAttention, "look", true)))
	must(f.SetFlag(ctx, "s-1", plugin.FlagSpec{Plugin: "other", DisplayName: "Other", Level: pluginsdk.FlagAttention, Reason: "theirs"}))
	if _, err := s.Post(ctx, notification.Post{Source: "hello", Key: "own", Title: "not a flag"}); err != nil {
		t.Fatal(err)
	}
	summary := func() []string {
		var out []string
		for _, fl := range f.Of("hello") {
			out = append(out, fmt.Sprintf("%s %s %s seen=%v %s", fl.ThreadID, fl.Level, fl.Reason, fl.UntilSeen, fl.SetAt.UTC().Format(time.TimeOnly)))
		}
		return out
	}
	want := []string{"s-1 error red seen=false 09:00:00", "s-2 attention look seen=true 09:00:01"}
	if got := summary(); !slices.Equal(got, want) {
		t.Fatalf("Of = %q, want %q", got, want)
	}
	// The user dismissing one takes it off the list, as a user's clear did.
	n, _ := s.Active("hello", notification.FlagKey("s-1", false))
	if _, err := s.Dismiss(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if got := summary(); !slices.Equal(got, want[1:]) {
		t.Fatalf("after a dismiss Of = %q, want %q", got, want[1:])
	}
}

// The seen hook withdraws the thread's until-seen flags of every plugin, and nothing
// else; archiving a thread withdraws its flags, on its event and in the sweep.
func TestFlagNotificationsGlue(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	th := newFakeFlagThreads()
	f := pluginFlags{threads: th, notes: s}
	for _, x := range []struct {
		id string
		sp plugin.FlagSpec
	}{
		{"s-1", spec(pluginsdk.FlagAttention, "seen one", true)},
		{"s-1", plugin.FlagSpec{Plugin: "other", DisplayName: "Other", Level: pluginsdk.FlagError, Reason: "seen two", UntilSeen: true}},
		{"s-2", spec(pluginsdk.FlagAttention, "sticky", false)},
		{"s-2", plugin.FlagSpec{Plugin: "other", DisplayName: "Other", Level: pluginsdk.FlagAttention, Reason: "elsewhere", UntilSeen: true}},
	} {
		if _, err := f.SetFlag(ctx, x.id, x.sp); err != nil {
			t.Fatal(err)
		}
	}
	b := bus.New()
	stop := startFlagNotifications(ctx, slog.Default(), th, f, b)
	defer stop()
	th.mu.Lock()
	hook := th.hook
	th.mu.Unlock()
	hook("s-1")
	want := []string{
		`hello flag:s-1:until-seen warning "seen one" withdrawn`,
		`hello flag:s-2 warning "sticky" shown`,
		`other flag:s-1:until-seen error "seen two" withdrawn`,
		`other flag:s-2:until-seen warning "elsewhere" shown`,
	}
	if got := flagState(s); !slices.Equal(got, want) {
		t.Fatalf("after seeing s-1: %q, want %q", got, want)
	}
	bus.Publish[thread.Event](b, thread.Updated{Thread: th.archive("s-2")})
	want[1] = `hello flag:s-2 warning "sticky" withdrawn`
	want[3] = `other flag:s-2:until-seen warning "elsewhere" withdrawn`
	deadline := time.Now().Add(5 * time.Second)
	for got := flagState(s); !slices.Equal(got, want); got = flagState(s) {
		if time.Now().After(deadline) {
			t.Fatalf("after archiving s-2: %q, want %q", got, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
	// The sweep catches an archive whose event never came.
	if _, err := s.Post(ctx, notification.Post{Source: "hello", Key: notification.FlagKey("s-1", false), Title: "late", ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	th.archive("s-1")
	if n, err := f.withdrawArchived(ctx, ""); err != nil || n != 1 {
		t.Fatalf("sweep withdrew %d, %v", n, err)
	}
}

// fakeLegacy is thread_flags as the conversion reads it.
type fakeLegacy struct {
	rows    []thread.LegacyFlag
	dropped []string
}

func (l *fakeLegacy) LegacyFlags(context.Context) ([]thread.LegacyFlag, error) {
	return slices.Clone(l.rows), nil
}

func (l *fakeLegacy) DropLegacyFlag(_ context.Context, id, source string) error {
	l.dropped = append(l.dropped, id+"/"+source)
	l.rows = slices.DeleteFunc(l.rows, func(r thread.LegacyFlag) bool { return r.ThreadID == id && r.Source == source })
	return nil
}

// Flags stored before they were notifications become notifications once, through the
// same path; a row that can never convert is dropped too, and a second start changes
// nothing.
func TestConvertLegacyFlags(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	f := pluginFlags{threads: newFakeFlagThreads(), notes: s}
	legacy := &fakeLegacy{rows: []thread.LegacyFlag{
		{ThreadID: "s-1", Source: "hello", SourceName: "Hello", Level: "attention", Reason: "deploy failed"},
		{ThreadID: "s-2", Source: "ci", SourceName: "CI", Level: "error", Reason: "red", UntilSeen: true},
		{ThreadID: "s-arch", Source: "hello", SourceName: "Hello", Level: "error", Reason: "archived"},
		{ThreadID: "s-gone", Source: "hello", SourceName: "Hello", Level: "error", Reason: "gone"},
	}}
	if n := convertLegacyFlags(ctx, slog.Default(), legacy, f); n != 2 {
		t.Fatalf("converted %d, want 2", n)
	}
	want := []string{`ci flag:s-2:until-seen error "red" shown`, `hello flag:s-1 warning "deploy failed" shown`}
	if got := flagState(s); !slices.Equal(got, want) {
		t.Fatalf("after conversion %q, want %q", got, want)
	}
	if len(legacy.rows) != 0 || len(legacy.dropped) != 4 {
		t.Fatalf("rows left %v, dropped %v", legacy.rows, legacy.dropped)
	}
	// Idempotent by key: the same rows again (a crash before the drop) change nothing.
	legacy.rows = []thread.LegacyFlag{{ThreadID: "s-1", Source: "hello", SourceName: "Hello", Level: "attention", Reason: "deploy failed"}}
	convertLegacyFlags(ctx, slog.Default(), legacy, f)
	if got := flagState(s); !slices.Equal(got, want) {
		t.Fatalf("after a second start %q, want %q", got, want)
	}
	if v := s.Snapshot().Version; v != 2 {
		t.Errorf("snapshot version %d, want 2 (no change on the second start)", v)
	}
}

// The reserved prefix is the same on both sides of the module boundary.
func TestFlagKeyPrefix(t *testing.T) {
	if notification.FlagKeyPrefix != pluginsdk.FlagKeyPrefix {
		t.Fatalf("notification.FlagKeyPrefix %q, pluginsdk.FlagKeyPrefix %q", notification.FlagKeyPrefix, pluginsdk.FlagKeyPrefix)
	}
}
