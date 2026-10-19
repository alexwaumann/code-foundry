package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// knownIssue skips a test of a finding that is not fixed yet (CF_KNOWN_ISSUES=1 runs it).
func knownIssue(t *testing.T) {
	t.Helper()
	if os.Getenv("CF_KNOWN_ISSUES") == "" {
		t.Skip("known issue (sdk.md); CF_KNOWN_ISSUES=1 runs it")
	}
}

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

// The invalid-view notice a dev plugin gets above its previous view steps around the
// previous view's node keys only; a column, grid item, node tab or row keyed
// "cf-invalid-view" then shares its key.
func TestKnownRejectNoticeKeyCollides(t *testing.T) {
	knownIssue(t)
	for _, raw := range []string{
		`{"nodes":[{"key":"c","columns":{"items":[{"key":"cf-invalid-view","children":[]},{"key":"c2","children":[]}]}}]}`,
		`{"nodes":[{"key":"g","grid":{"items":[{"key":"cf-invalid-view","children":[]}]}}]}`,
		`{"nodes":[{"key":"t","tabs":{"active":"cf-invalid-view","items":[{"key":"cf-invalid-view","label":"A"},{"key":"b","label":"B"}],"children":[]}}]}`,
		`{"nodes":[{"key":"md","masterDetail":{"list":{"rows":[{"key":"cf-invalid-view","title":"R"}]},"detail":[]}}]}`,
	} {
		v, canon, errs := validateView(json.RawMessage(raw), "p", fuzzPerms)
		if len(errs) > 0 {
			t.Fatal(errs)
		}
		in := newFuzzInstance()
		in.accept(v, canon, time.Unix(0, 0))
		in.reject("P", []string{"x: bad"}, true)
		if out := string(in.renderLocked()); strings.Count(out, `"key":"cf-invalid-view"`) > 1 {
			t.Errorf("two elements keyed cf-invalid-view: %s", out)
		}
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
