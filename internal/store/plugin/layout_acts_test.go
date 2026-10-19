package plugin_test

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// Select and node tab acts that do not name an acting element, or name one of another
// kind, are refused before they reach the plugin; stale versions are refused once gone
// and otherwise reach the plugin with the version (and node) acted on. The surf panel
// has a master-detail pmd (rows pr1, pr2) whose detail is a tabs node ptabs (pt1, pt2).
func TestLayoutActEdges(t *testing.T) {
	e := newSurfEnv(t, nil)
	w := e.watch("panel", s1)
	w.view("first view", contains("count 0"))
	waitOpen(t, e, w.key)
	for _, c := range []struct {
		name string
		req  plugin.ActRequest
		want string
	}{
		{"the master-detail itself", plugin.ActRequest{Key: "pmd"}, `no acting element "pmd"`},
		{"the tabs node itself", plugin.ActRequest{Key: "ptabs", Action: "tab"}, `no acting element "ptabs"`},
		{"a row as a tab", plugin.ActRequest{Key: "pr1", Action: "tab"}, `element "pr1"'s action is "select", not "tab"`},
		{"a node tab as a select", plugin.ActRequest{Key: "pt1", Action: "select"}, `element "pt1"'s action is "tab", not "select"`},
		{"a missing row", plugin.ActRequest{Key: "pr9", Action: "select"}, `no acting element "pr9"`},
		{"a version never sent", plugin.ActRequest{Key: "pr1", Version: 99}, "the view changed before this action reached it; try again"},
	} {
		if _, err := e.act(w.key, c.req); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", c.name, err, c.want)
		}
	}
	// A select from an older (kept) version reaches the plugin with that version.
	if _, err := e.act(w.key, plugin.ActRequest{Key: "inc"}); err != nil {
		t.Fatal(err)
	}
	w.view("after inc", contains("count 2"))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pr1", Version: 1}); err != nil {
		t.Fatal(err)
	}
	w.view("the stale select", contains(`node=\"pmd\" values=null version=1`))
	// Values (and a value) on a select or a tab are dropped: the act carries its key as
	// its value and no form's values (the GUI sends none).
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pr2", Value: new("pr1"), Values: map[string]any{"name": "Ada"}}); err != nil {
		t.Fatal(err)
	}
	w.view("the select with values", contains(`got select:select key=pr2 value=pr2 node=\"pmd\" values=null`))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pt2", Values: map[string]any{"name": "Ada"}}); err != nil {
		t.Fatal(err)
	}
	w.view("the tab with values", contains(`got tab:tab key=pt2 value=pt2 node=\"ptabs\" values=null`))
}

// Under a fast stream the version on screen is often several behind (the GUI coalesces
// at 100 ms, and an act takes a round trip): a version replaced less than keptFor ago
// still acts however many came since (up to 64), and one replaced longer ago is refused
// with words the GUI's toast can show (no instance key), as a failed precondition.
func TestActsOnRecentVersions(t *testing.T) {
	var skew atomic.Int64
	e := newSurfEnv(t, func(o *plugin.Options) {
		o.Now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	})
	w := e.watch("panel", s1)
	w.view("first view", contains("count 0"))
	waitOpen(t, e, w.key)
	first, err := e.act(w.key, plugin.ActRequest{Key: "inc"})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for range 20 {
		if _, err := e.act(w.key, plugin.ActRequest{Key: "inc"}); err != nil {
			t.Fatal(err)
		}
	}
	w.view("after the stream", contains("count 22"))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pr2", Version: first}); err != nil {
		t.Fatalf("an act on version %d, 21 versions back and %s old: %v", first, time.Since(start).Round(time.Millisecond), err)
	}
	w.view("the select on the old version", contains(`version=`+strconvU(first)))
	// Four seconds on, the next view prunes it.
	skew.Store(int64(4 * time.Second))
	if _, err := e.act(w.key, plugin.ActRequest{Key: "inc"}); err != nil {
		t.Fatal(err)
	}
	_, err = e.act(w.key, plugin.ActRequest{Key: "pr2", Version: first})
	if !errors.Is(err, plugin.ErrFailedPrecondition) || err.Error() != "the view changed before this action reached it; try again" {
		t.Fatalf("an act on an ancient version: %v", err)
	}
	if _, err := e.act(w.key, plugin.ActRequest{Key: "pr2"}); err != nil {
		t.Fatalf("an act on the current version: %v", err)
	}
}

func strconvU(v uint64) string { return strconv.FormatUint(v, 10) }

// An act the plugin does not answer in time is a deadline exceeded, and one it stops
// while handling is unavailable (the API maps both: plugin_surface_test.go), each with
// its own words; neither is an internal error (finding live #11: the GUI saw HTTP 500).
func TestActTimeoutAndStop(t *testing.T) {
	e := newSurfEnv(t, func(o *plugin.Options) { o.ActTimeout = 300 * time.Millisecond })
	w := e.watch("panel", s1)
	w.view("first view", contains("count 0"))
	waitOpen(t, e, w.key)
	_, err := e.act(w.key, plugin.ActRequest{Key: "hang"})
	if !errors.Is(err, context.DeadlineExceeded) || err.Error() != "plugin surf did not answer within 300ms" {
		t.Errorf("an unanswered act: %v", err)
	}
	_, err = e.act(w.key, plugin.ActRequest{Key: "exit"})
	if !errors.Is(err, plugin.ErrUnavailable) || err.Error() != "plugin surf stopped while handling the action" {
		t.Errorf("an act the plugin stops on: %v", err)
	}
}

// waitOpen waits until the instance's surface/open has been answered: the first view
// comes while the plugin is still handling the open, and an act before the answer is
// refused ("not open"). It acts on "inc" until one goes through.
func waitOpen(t *testing.T, e *surfEnv, key string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, err := e.act(key, plugin.ActRequest{Key: "inc"})
		if err == nil {
			return
		}
		if !strings.Contains(err.Error(), "is not open") || time.Now().After(deadline) {
			t.Fatalf("waiting for the open: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
