package layout

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// panelCase is one case of testdata/legacy/panel.json: a stored side panel value (stored, as
// JSON, or raw, a string that is not JSON) and the entries the TypeScript store held after
// rehydrating it (captured from gui/frontend/src/stores/panel.ts with the inputs of its
// panel.test.ts and panel.migrate.test.ts; docs/notes/shell-18-legacy-import.md).
type panelCase struct {
	Doc    string          `json:"doc"`
	Stored json.RawMessage `json:"stored,omitempty"`
	Raw    *string         `json:"raw,omitempty"`
	Want   json.RawMessage `json:"want"`
}

func TestReadPanelMatchesTheTypeScript(t *testing.T) {
	data, err := os.ReadFile("testdata/legacy/panel.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []panelCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 50 {
		t.Fatalf("%d cases; the capture has more", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Doc, func(t *testing.T) {
			raw := []byte(c.Stored)
			if c.Raw != nil {
				raw = []byte(*c.Raw)
			}
			got := asJSON(t, readPanel(raw))
			want := asJSON(t, c.Want)
			if !reflect.DeepEqual(got, want) {
				g, _ := json.MarshalIndent(got, "", "  ")
				w, _ := json.MarshalIndent(want, "", "  ")
				t.Errorf("got\n%s\nwant\n%s", g, w)
			}
		})
	}
}

// asJSON is v as plain JSON values, so two encodings compare regardless of key order.
func asJSON(t *testing.T, v any) any {
	t.Helper()
	b, ok := v.(json.RawMessage)
	if !ok {
		var err error
		if b, err = json.Marshal(v); err != nil {
			t.Fatal(err)
		}
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestReadPanelKeepsWhatIsSoundInABrokenOldStore(t *testing.T) {
	// The TypeScript throws on these (a tab without params, an entry without a tab list) and
	// keeps nothing; the port keeps the sound entry and tab.
	raw := `{"version":1,"state":{"byKey":{
		"thread:s-1":{"open":true,"tabs":[{"id":"files","kind":"files","title":"Files"},{"id":"mcp","kind":"mcp","title":"MCP","params":{}}],"activeTabId":"mcp"},
		"thread:s-2":{"open":true},
		"thread:s-3":7}}}`
	got := readPanel([]byte(raw))
	if len(got) != 2 || got["thread:s-3"] != nil {
		t.Fatalf("entries %v", got)
	}
	if g := got["thread:s-1"].Groups; len(g) != 1 || len(g[0].Tabs) != 1 || g[0].Tabs[0].Kind != "mcp" || g[0].Active == nil || *g[0].Active != "mcp" {
		t.Errorf("thread:s-1 %+v", g)
	}
	if g := got["thread:s-2"].Groups; len(g) != 1 || len(g[0].Tabs) != 0 {
		t.Errorf("thread:s-2 %+v", g)
	}
}

func TestPanelTabID(t *testing.T) {
	for _, c := range []struct {
		kind   string
		params map[string]string
		want   string
	}{
		{"files", nil, "files"},
		{"pullrequest", map[string]string{"repo": "a/b", "number": "1"}, "pullrequest?number=1&repo=a%2Fb"},
		{"diff", map[string]string{"worktree": "/u/x y", "project": "p"}, "diff?project=p&worktree=%2Fu%2Fx%20y"},
		{"files", map[string]string{"path": "a-_.!~*'()é"}, "files?path=a-_.!~*'()%C3%A9"},
	} {
		if got := panelTabID(c.kind, c.params); got != c.want {
			t.Errorf("panelTabID(%s, %v) = %q, want %q", c.kind, c.params, got, c.want)
		}
	}
}
