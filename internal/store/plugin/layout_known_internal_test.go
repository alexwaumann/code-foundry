package plugin

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// Known issues found by the layout fuzzing pass (/tmp/cf-layout-fuzz/sdk.md). They fail
// today; set CF_KNOWN_ISSUES=1 to run them (the fix agent turns each into a plain test).
func knownIssue(t *testing.T) {
	t.Helper()
	if os.Getenv("CF_KNOWN_ISSUES") == "" {
		t.Skip("known issue (sdk.md); CF_KNOWN_ISSUES=1 runs it")
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
