package plugin

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// withRemovals replaces the SDK's removal list for the test.
func withRemovals(t *testing.T, rs ...pluginsdk.Removal) {
	t.Helper()
	old := pluginsdk.Removals
	pluginsdk.Removals = rs
	t.Cleanup(func() { pluginsdk.Removals = old })
}

// The host's side of the removal list: a deprecated method is served and logged once per
// run; a retired one is answered without acting (its handler never runs, so not even its
// permission is checked) and logged once per run; a retired notification is dropped.
func TestRemovalMethods(t *testing.T) {
	withRemovals(t,
		pluginsdk.Removal{Symbols: []string{"Host.Gone"}, Method: "test/gone", Replacement: "Host.Notify", Hint: "post one",
			Stage: pluginsdk.StageRetired, Deprecated: "2026-01-01", Retired: "2026-02-01"},
		pluginsdk.Removal{Symbols: []string{"Secrets.List"}, Method: pluginsdk.MethodSecretList, Replacement: "nothing", Hint: "keep the keys",
			Stage: pluginsdk.StageRetired, Deprecated: "2026-01-01", Retired: "2026-03-01"},
		pluginsdk.Removal{Symbols: []string{"Host.Old"}, Method: pluginsdk.MethodSecretGet, Replacement: "Host.New", Hint: "call the new one",
			Stage: pluginsdk.StageDeprecated, Deprecated: "2026-04-01"},
		pluginsdk.Removal{Symbols: []string{"Host.Note"}, Method: "test/note", Replacement: "Host.Log", Hint: "log it",
			Stage: pluginsdk.StageRetired, Deprecated: "2026-01-01", Retired: "2026-05-01"},
	)
	logs := newLogBuffer(filepath.Join(t.TempDir(), "p.log"), 1<<20, 100, time.Now)
	a := &actor{name: "p", logs: logs, ignored: map[string]bool{}, removalsLogged: map[string]bool{}}
	ctx := context.Background()
	call := func(method string) (any, error) {
		t.Helper()
		return a.handle(ctx, method, []byte(`{"key":"k"}`))
	}
	for range 2 {
		// Retired, no handler: an empty answer.
		if res, err := call("test/gone"); err != nil || res != (struct{}{}) {
			t.Fatalf("test/gone = %v, %v", res, err)
		}
		// Retired with a handler: answered without acting (no permission refusal).
		if res, err := call(pluginsdk.MethodSecretList); err != nil || res != (struct{}{}) {
			t.Fatalf("secret/list = %v, %v", res, err)
		}
		// Deprecated: served (here refused for want of the secrets permission).
		if _, err := call(pluginsdk.MethodSecretGet); pluginsdk.ErrorCode(err) != pluginsdk.CodePermissionDenied {
			t.Fatalf("secret/get = %v", err)
		}
		a.notify(ctx, "test/note", nil)
	}
	var text []string
	for _, l := range logs.tail(100) {
		text = append(text, l.Level+" "+l.Text)
	}
	got := strings.Join(text, "\n")
	for _, want := range []string{
		"warn Host.Gone (test/gone) was retired on 2026-02-01 and does nothing: use Host.Notify (post one)",
		"warn Secrets.List (secret/list) was retired on 2026-03-01 and does nothing: use nothing (keep the keys)",
		"warn Host.Old (secret/get) is deprecated since 2026-04-01 and will stop working: use Host.New (call the new one)",
		"warn Host.Note (test/note) was retired on 2026-05-01 and does nothing: use Host.Log (log it)",
	} {
		if n := strings.Count(got, want); n != 1 {
			t.Errorf("%q logged %d times, want once:\n%s", want, n, got)
		}
	}
	if strings.Contains(got, "ignored unknown notification") {
		t.Errorf("a retired notification read as unknown:\n%s", got)
	}
	// A new run logs again.
	a.removalsLogged = map[string]bool{}
	_, _ = call("test/gone")
	if n := strings.Count(strings.Join(func() []string {
		var out []string
		for _, l := range logs.tail(100) {
			out = append(out, l.Text)
		}
		return out
	}(), "\n"), "Host.Gone (test/gone) was retired"); n != 2 {
		t.Errorf("after a new run: logged %d times, want 2", n)
	}
}
