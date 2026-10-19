package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	sdktest "github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// Regressions from the layout fuzzing pass (2026-10-19,
// docs/notes/plugins-layout-fixes-sdk.md).

// A 978 KB view of 3300 nested tabs nodes (8 tabs each) took 1.7 GB of heap in
// validateView when Validate built and kept every level's full path; the refused
// subtree is no longer walked.
func TestValidateViewDeepIsCheap(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"nodes":[`)
	const levels = 3300
	for i := range levels {
		fmt.Fprintf(&b, `{"key":"k%d","tabs":{"active":"a%d-0","items":[`, i, i)
		for j := range 8 {
			if j > 0 {
				b.WriteString(",")
			}
			fmt.Fprintf(&b, `{"key":"a%d-%d","label":"A"}`, i, j)
		}
		b.WriteString(`],"children":[`)
	}
	b.WriteString(`{"key":"leaf","text":{"content":"x"}}`)
	for range levels {
		b.WriteString(`]}}`)
	}
	b.WriteString(`]}`)
	raw := json.RawMessage(b.String())
	if len(raw) > maxRawView {
		t.Fatalf("%d bytes", len(raw))
	}
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	start := time.Now()
	v, _, errs := validateView(raw, "p", fuzzPerms)
	took := time.Since(start)
	runtime.ReadMemStats(&after)
	mb := (after.TotalAlloc - before.TotalAlloc) >> 20
	t.Logf("validateView of a %d KB view: %d MB allocated in %s", len(raw)>>10, mb, took)
	if v != nil || len(errs) == 0 || !strings.Contains(errs[0], "inside 5 containers (tabs > tabs > tabs > tabs > tabs), at most 4") {
		t.Fatalf("errs %q", errs)
	}
	if mb > 64 { // decoding the view is most of it
		t.Errorf("validateView allocated %d MB", mb)
	}
	if took > 5*time.Second {
		t.Errorf("validateView took %s", took)
	}
}

// The invalid-view notice a dev plugin gets above its previous view stepped around the
// previous view's node keys only, so a column, grid item, node tab or row keyed
// "cf-invalid-view" shared its key. Keys starting "cf-" are now the host's: Validate
// refuses them anywhere, and the notice's key is reserved.
func TestRejectNoticeKeyIsReserved(t *testing.T) {
	for _, raw := range []string{
		`{"nodes":[{"key":"c","columns":{"items":[{"key":"cf-invalid-view","children":[]},{"key":"c2","children":[]}]}}]}`,
		`{"nodes":[{"key":"g","grid":{"items":[{"key":"cf-invalid-view","children":[]}]}}]}`,
		`{"nodes":[{"key":"t","tabs":{"active":"cf-invalid-view","items":[{"key":"cf-invalid-view","label":"A"},{"key":"b","label":"B"}],"children":[]}}]}`,
		`{"nodes":[{"key":"md","masterDetail":{"list":{"rows":[{"key":"cf-invalid-view","title":"R"}]},"detail":[]}}]}`,
		`{"nodes":[{"key":"cf-x","text":{"content":"x"}}]}`,
		`{"nodes":[],"footer":[{"key":"a","actions":{"buttons":[{"key":"cf-go","label":"Go","action":{"event":"go"}}]}}]}`,
	} {
		_, _, errs := validateView(json.RawMessage(raw), "p", fuzzPerms)
		if len(errs) != 1 || !strings.Contains(errs[0], `keys starting "cf-" are the host's`) {
			t.Errorf("%s: %q", raw, errs)
		}
	}
	if !strings.HasPrefix(invalidViewKey, ui.ReservedKeyPrefix) {
		t.Errorf("the notice's key %q is not reserved", invalidViewKey)
	}
}

// FuzzOwnedParams crasher (2026-10-19): a terminal/create without a title took
// filepath.Base(argv[0]) as its title without the one-line and length rules a given
// title meets, so a newline or more than 80 bytes reached the store. The derived title
// now meets them too: refused like a bad given one (testdata/fuzz/FuzzOwnedParams has
// both inputs as seeds).
func TestTerminalTitleFromArgv(t *testing.T) {
	home := t.TempDir()
	for _, c := range []struct {
		params, title, err string
	}{
		{`{"argv":["/bin/sh","-c","x"]}`, "sh", ""},
		{`{"argv":["  /usr/bin/my tool "]}`, "my tool", ""},
		{`{"argv":["/bin/a\nb"]}`, "", "title (argv[0]'s base name without one; pass a title) is one line of at most 80 bytes"},
		{"{\"Argv\":[\"" + strings.Repeat("\xb8", 27) + "\"]}", "", "is one line of at most 80 bytes"}, // 27 U+FFFD after decoding: 81 bytes
		{`{"argv":["/bin/a\nb"],"title":"Shell"}`, "Shell", ""},
		{`{"argv":["sh"],"title":"a\nb"}`, "", "terminal/create: title is one line of at most 80 bytes"},
	} {
		terms := &recordingTerms{}
		m := &Manager{log: slog.New(slog.DiscardHandler), opts: Options{Home: home, DataDir: filepath.Join(home, "data"), Terminals: terms}}
		a := &actor{m: m, name: "p", logs: newLogBuffer(filepath.Join(home, "p.log"), 1<<20, 10, time.Now)}
		_, err := a.terminalCreate(context.Background(), json.RawMessage(c.params))
		switch {
		case c.err != "":
			if err == nil || !strings.Contains(err.Error(), c.err) {
				t.Errorf("%q: %v, want %q", c.params, err, c.err)
			}
		case err != nil:
			t.Errorf("%q: %v", c.params, err)
		case terms.term.Title != c.title:
			t.Errorf("%q: title %q, want %q", c.params, terms.term.Title, c.title)
		}
	}
}

// A version's elements are kept keptFor after a newer one replaced it, at most
// keptVersions; the current one always (finding live #3: at 40 views a second, a fixed
// four versions failed 27 % of clicks).
func TestKeptVersions(t *testing.T) {
	in := newFuzzInstance()
	t0 := time.Unix(1000, 0)
	accept := func(i int, at time.Time) {
		t.Helper()
		v, canon, errs := validateView(json.RawMessage(fmt.Sprintf(`{"nodes":[{"key":"b","actions":{"buttons":[{"key":"go","label":"Go %d","action":{"event":"go"}}]}}]}`, i)), "p", fuzzPerms)
		if len(errs) > 0 {
			t.Fatal(errs)
		}
		in.accept(v, canon, at)
	}
	for i := range 100 {
		accept(i, t0)
	}
	if len(in.index) != keptVersions || in.index[100] == nil || in.index[100-keptVersions+1] == nil || in.index[100-keptVersions] != nil {
		t.Fatalf("after 100 views at once: %d kept", len(in.index))
	}
	// 2.9 s after the last replacement everything replaced then is still kept; 3.1 s
	// after, only the newest two (the one just replaced and the current one).
	accept(100, t0.Add(2900*time.Millisecond))
	if len(in.index) != keptVersions {
		t.Fatalf("at 2.9 s: %d kept", len(in.index))
	}
	accept(101, t0.Add(6100*time.Millisecond))
	if len(in.index) != 2 || in.index[102] == nil || in.index[101] == nil {
		t.Fatalf("at 6.1 s: %d kept", len(in.index))
	}
	// A view shown for long and just replaced still acts (its age counts from its
	// replacement): the one replaced 3.1 s ago goes.
	accept(102, t0.Add(9200*time.Millisecond))
	if len(in.index) != 2 || in.index[103] == nil || in.index[102] == nil {
		t.Fatalf("a long-shown view replaced: %d kept", len(in.index))
	}
}

// requiredLists (fuzz_test.go's null-list check) names every list of the view model
// without omitempty: it lacked masterDetail's detail.
func TestRequiredListsAreEveryRequiredList(t *testing.T) {
	seen := map[reflect.Type]bool{}
	var walk func(rt reflect.Type)
	walk = func(rt reflect.Type) {
		for rt.Kind() == reflect.Pointer || rt.Kind() == reflect.Slice || rt.Kind() == reflect.Map {
			rt = rt.Elem()
		}
		if rt.Kind() != reflect.Struct || seen[rt] {
			return
		}
		seen[rt] = true
		for i := range rt.NumField() {
			f := rt.Field(i)
			if !f.IsExported() {
				continue
			}
			name, opts, _ := strings.Cut(f.Tag.Get("json"), ",")
			if f.Type.Kind() == reflect.Slice && name != "" && name != "-" && !strings.Contains(opts, "omitempty") && !slices.Contains(requiredLists, name) {
				t.Errorf("%s.%s (%q) is a list without omitempty that requiredLists lacks", rt.Name(), f.Name, name)
			}
			walk(f.Type)
		}
	}
	walk(reflect.TypeFor[ui.View]())
}

// plugintest's fake host announces this host's capabilities by default, so a plugin
// test sees what the real host announces (it announced none, and a plugin that checks
// view.node.masterDetail rendered its fallback under test).
func TestPluginTestAnnouncesTheHostsCapabilities(t *testing.T) {
	got, want := slices.Sorted(slices.Values(sdktest.HostCapabilities)), slices.Sorted(slices.Values(hostCapabilities))
	if !slices.Equal(got, want) {
		t.Errorf("pluginsdk/plugintest.HostCapabilities\n%v\nthe host's\n%v", got, want)
	}
}
