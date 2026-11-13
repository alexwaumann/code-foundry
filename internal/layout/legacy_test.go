package layout

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// The first-load import (legacy.go), adapted from docs/notes/shell-plan.md section 3's table
// to the specification's empty space: captured stores of several versions, threads with zero,
// one and three terminals, archived and snoozed threads, and a layout that is not empty.

var t0 = time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)

// lterm is a terminal of thread th (none: a project's shell) of kind kind, started at minute m.
func lterm(id, th, kind string, m int) LegacyTerminal {
	l := map[string]string{"kind": kind, "project": "web", "worktree": "/wt/web"}
	if th != "" {
		l["thread"] = th
	}
	return LegacyTerminal{ID: id, Labels: l, StartedAt: t0.Add(time.Duration(m) * time.Minute)}
}

func store6(byKey any) []byte {
	b, _ := json.Marshal(map[string]any{"version": 6, "state": map[string]any{"byKey": byKey}})
	return b
}

func bottom1(byKey any) []byte {
	b, _ := json.Marshal(map[string]any{"version": 1, "state": map[string]any{"byKey": byKey}})
	return b
}

func ptab(kind, title string, params map[string]string) map[string]any {
	if params == nil {
		params = map[string]string{}
	}
	return map[string]any{"id": panelTabID(kind, params), "kind": kind, "title": title, "params": params}
}

func group(active string, tabs ...map[string]any) map[string]any {
	g := map[string]any{"tabs": tabs, "activeTabId": nil}
	if active != "" {
		g["activeTabId"] = active
	}
	return g
}

var (
	pFile  = ptab("files", "a.ts", map[string]string{"project": "web", "base": "/wt/web", "path": "/wt/web/a.ts", "line": "4"})
	pDiff  = ptab("diff", "Diff", map[string]string{"project": "web", "worktree": "/wt/web", "own": "1"})
	pPR    = ptab("pullrequest", "#7", map[string]string{"slug": "Octo/Web", "number": "7"})
	pMCP   = ptab("mcp", "MCP", nil)
	pEmber = ptab("ember", "Board", nil)
	pPlug  = ptab("plugin.notes.pad", "Notes", nil)
	pOdd   = ptab("weather", "Weather", nil)
	pBadPR = ptab("pullrequest", "#x", map[string]string{"slug": "o/w", "number": "x"})
)

// remembered is a thread's remembered set as "kind[:terminal]" in order, and its quick
// terminal as "quick=<open>/<height>".
func remembered(st *State, thread string) string {
	ts := st.Threads[thread]
	if ts == nil {
		return "-"
	}
	var parts []string
	if ts.Remembered != nil {
		if ts.Remembered.Pane != "" {
			parts = append(parts, "pane="+ts.Remembered.Pane)
		}
		for _, rt := range ts.Remembered.Tabs {
			s := rt.Tab.Kind
			if term := rt.Tab.Params[TerminalParam]; term != "" {
				s += ":" + term
			}
			if rt.Fresh != nil {
				s += "(fresh)"
			}
			parts = append(parts, s)
		}
	}
	if q := ts.Quick; q != nil {
		parts = append(parts, fmt.Sprintf("quick=%v/%g", q.Open, q.Height))
	}
	return strings.Join(parts, " ")
}

func emptyLayout(t *testing.T, st *State) {
	t.Helper()
	for _, sp := range st.Spaces {
		if sp.Root != nil {
			t.Errorf("space %s is not empty: %s", sp.ID, layoutShape(sp.Root))
		}
	}
}

func TestImportLegacy(t *testing.T) {
	threads := []LegacyThread{{ID: "s-0"}, {ID: "s-1"}, {ID: "s-3"}, {ID: "s-arch", Archived: true}, {ID: "s-snz"}}
	terms := []LegacyTerminal{
		lterm("t-3c", "s-3", "action", 3),
		lterm("t-3a", "s-3", "shell", 1),
		lterm("t-3b", "s-3", "shell", 2),
		lterm("t-1", "s-1", "shell", 4),
		lterm("t-proj", "", "shell", 5),
		{ID: "t-plug", Labels: map[string]string{"kind": "plugin", "plugin": "notes", "thread": "s-1"}, StartedAt: t0},
		{ID: "t-free", Labels: map[string]string{"kind": "shell"}, StartedAt: t0},
	}
	panel := store6(map[string]any{
		"thread:s-0":    map[string]any{"open": true, "groups": []any{group(pDiff["id"].(string), pFile, pDiff), group("", pPR)}},
		"thread:s-1":    map[string]any{"open": false, "groups": []any{group("", pMCP, pEmber, pPlug, pOdd, pBadPR)}},
		"thread:s-arch": map[string]any{"open": true, "groups": []any{group("", pFile)}},
		"thread:s-snz":  map[string]any{"open": true, "groups": []any{group("", pDiff)}},
		"thread:s-gone": map[string]any{"open": true, "groups": []any{group("", pFile)}},
		"view:projects": map[string]any{"open": true, "groups": []any{group("", pDiff)}},
		"compose:home:": map[string]any{"open": true, "groups": []any{group("", pFile)}},
	})
	bottom := bottom1(map[string]any{
		"thread:s-1":    map[string]any{"open": true, "height": 260},
		"thread:s-3":    map[string]any{"open": false, "height": 300, "activeTerminalId": "t-3b"},
		"thread:s-snz":  map[string]any{"open": true, "height": 200},
		"view:projects": map[string]any{"open": true},
	})
	cases := []struct {
		name      string
		state     *State
		in        LegacyInput
		want      map[string]string // thread -> remembered()
		quick     map[string]string
		removed   []string
		dropped   []string
		wantSpace string // layoutShape of the first space; "" = empty
	}{
		{
			name:  "a fresh install: no stores, no threads",
			state: NewState("sp-a", "Main"),
			want:  map[string]string{},
		},
		{
			name:  "threads with zero, one and three terminals; archived, snoozed and gone threads; pages and composers",
			state: NewState("sp-a", "Main"),
			in:    LegacyInput{Panel: panel, Bottom: bottom, Threads: threads, Terminals: terms},
			want: map[string]string{
				"s-0":    "file diff pullrequest",
				"s-1":    "mcp ember.board plugin.notes.pad quick=true/260",
				"s-3":    "terminal:t-3b terminal:t-3c quick=false/300",
				"s-arch": "-",
				"s-snz":  "diff quick=false/200",
			},
			quick: map[string]string{"s-1": "t-1", "s-3": "t-3a"},
			dropped: []string{
				`thread s-1: side panel tab pullrequest?number=x&slug=o%2Fw: param number "x" is not a pull request number: invalid argument`,
				`thread s-1: side panel tab weather: no "weather" surface in the shell`,
				"thread s-arch is archived or gone: its side panel is dropped",
				"thread s-gone is archived or gone: its side panel is dropped",
			},
		},
		{
			name:  "a thread whose shell is already its quick terminal keeps it; its other shells are tabs",
			state: NewState("sp-a", "Main"),
			in: LegacyInput{Bottom: bottom, Threads: threads, Terminals: []LegacyTerminal{
				lterm("t-3a", "s-3", "shell", 1),
				func() LegacyTerminal { tm := lterm("t-3q", "s-3", "shell", 2); tm.Labels["slot"] = "quick"; return tm }(),
			}},
			want: map[string]string{"s-1": "quick=false/260", "s-3": "terminal:t-3a quick=false/300", "s-snz": "quick=false/200"},
		},
		{
			name:  "an exited action run comes back as a tab to read; an exited shell is never the quick terminal",
			state: NewState("sp-a", "Main"),
			in: LegacyInput{Bottom: bottom, Threads: threads, Terminals: []LegacyTerminal{
				func() LegacyTerminal { tm := lterm("t-run", "s-1", "action", 1); tm.Exited = true; return tm }(),
			}},
			want: map[string]string{"s-1": "terminal:t-run quick=false/260", "s-3": "quick=false/300", "s-snz": "quick=false/200"},
		},
		{
			name: "classic shells' automatic tabs: folded into their threads or taken out, and the space is empty",
			state: stateWith(t, `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[
				{"id":"sp-a","name":"Main","focus":"p-1","mru":["t-x","t-p"],"root":{"t":"split","id":"s-1","dir":"row","sizes":[0.5,0.5],"kids":[
					{"t":"pane","id":"p-1","active":"t-p","tabs":[
						{"id":"t-p","kind":"terminal","params":{"terminal":"t-proj"}},
						{"id":"t-x","kind":"terminal","thread":"s-3","params":{"terminal":"t-3b"},"name":"build"}]},
					{"t":"pane","id":"p-2","active":"t-y","tabs":[
						{"id":"t-y","kind":"terminal","thread":"s-3","params":{"terminal":"t-3a"}},
						{"id":"t-d","kind":"diff","thread":"s-1","params":{"project":"web","worktree":"/wt/web"}},
						{"id":"t-g","kind":"terminal","thread":"s-1","params":{"terminal":"t-dead"}},
						{"id":"t-z","kind":"file","thread":"s-arch","params":{"path":"/a"}}]}]}}]}`),
			in: LegacyInput{Panel: panel, Bottom: bottom, Threads: threads, Terminals: terms},
			want: map[string]string{
				"s-0":   "file diff pullrequest",
				"s-1":   "mcp ember.board plugin.notes.pad diff quick=true/260",
				"s-3":   "terminal:t-3b terminal:t-3c quick=false/300",
				"s-snz": "diff quick=false/200",
			},
			quick:   map[string]string{"s-1": "t-1", "s-3": "t-3a"},
			removed: []string{"t-p"},
		},
		{
			name: "a space arranged with the new verbs stays as it is; legacy tabs already open are not remembered again",
			state: stateWith(t, `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[
				{"id":"sp-a","name":"Main","focus":"p-1","root":{"t":"split","id":"s-1","dir":"row","sizes":[0.5,0.5],"kids":[
					{"t":"pane","id":"p-1","active":"t-0","tabs":[{"id":"t-0","kind":"thread","thread":"s-0"}]},
					{"t":"pane","id":"p-2","active":"t-d","tabs":[
						{"id":"t-d","kind":"diff","thread":"s-0","params":{"project":"web","worktree":"/wt/web"}},
						{"id":"t-x","kind":"terminal","thread":"s-3","params":{"terminal":"t-3b"}},
						{"id":"t-f","kind":"terminal","params":{"terminal":"t-free"}}]}]}}],
				"threads":{"s-1":{"space":"sp-a","remembered":{"pane":"p-9","tabs":[
					{"tab":{"id":"t-m","kind":"mcp","thread":"s-1"},"pane":"p-9","index":0}]}}}}`),
			in: LegacyInput{Panel: panel, Bottom: bottom, Threads: threads, Terminals: terms},
			want: map[string]string{
				"s-0":   "file pullrequest",
				"s-1":   "pane=p-9 mcp ember.board plugin.notes.pad quick=true/260",
				"s-3":   "terminal:t-3c quick=false/300",
				"s-snz": "diff quick=false/200",
			},
			quick:     map[string]string{"s-1": "t-1", "s-3": "t-3a"},
			wantSpace: "row(p-1[thread:s-0]*thread:s-0:0.500000000, p-2[t-d t-x t-f]*t-d:0.500000000)",
		},
		{
			name: "a thread's dormant tab in another space was put there by hand: kept",
			state: stateWith(t, `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[
				{"id":"sp-a","name":"Main"},
				{"id":"sp-b","name":"Review","focus":"p-1","root":{"t":"pane","id":"p-1","active":"t-d","tabs":[
					{"id":"t-d","kind":"diff","thread":"s-0","params":{"project":"web","worktree":"/wt/web"}}]}}]}`),
			in: LegacyInput{Panel: panel, Threads: threads},
			// The diff is open in another space only: the thread's own space gets it back too.
			want:      map[string]string{"s-0": "file diff pullrequest", "s-1": "mcp ember.board plugin.notes.pad", "s-snz": "diff"},
			wantSpace: "-",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			before := mustEncode(t, c.state)
			got, res, err := ImportLegacy(c.state, c.in, &SeqIDs{})
			if err != nil {
				t.Fatal(err)
			}
			if mustEncode(t, c.state) != before {
				t.Error("the input state changed")
			}
			if err := Check(got); err != nil {
				t.Fatal(err)
			}
			if c.wantSpace == "" || c.wantSpace == "-" {
				for _, sp := range got.Spaces {
					if sp.ID == "sp-a" && sp.Root != nil {
						t.Errorf("space sp-a: %s, want empty", layoutShape(sp.Root))
					}
				}
			} else if s := layoutShape(got.Spaces[0].Root); s != c.wantSpace {
				t.Errorf("space: %s\nwant %s", s, c.wantSpace)
			}
			for th, want := range c.want {
				if g := remembered(got, th); g != want {
					t.Errorf("thread %s: %s, want %s", th, g, want)
				}
			}
			for th := range got.Threads {
				if _, ok := c.want[th]; !ok {
					t.Errorf("thread %s has a record: %s", th, remembered(got, th))
				}
			}
			if c.quick == nil {
				c.quick = map[string]string{}
			}
			if fmt.Sprint(res.Quick) != fmt.Sprint(c.quick) {
				t.Errorf("quick %v, want %v", res.Quick, c.quick)
			}
			var removed []string
			for _, tb := range res.Removed {
				removed = append(removed, tb.ID)
			}
			if !slices.Equal(removed, c.removed) {
				t.Errorf("removed %v, want %v", removed, c.removed)
			}
			if c.dropped != nil && !slices.Equal(res.Dropped, c.dropped) {
				t.Errorf("dropped\n%s\nwant\n%s", strings.Join(res.Dropped, "\n"), strings.Join(c.dropped, "\n"))
			}
			for _, r := range res.Threads {
				if remembered(got, r.Thread) == "-" {
					t.Errorf("result lists thread %s, which has no record", r.Thread)
				}
			}
		})
	}
}

func stateWith(t *testing.T, doc string) *State {
	t.Helper()
	st, repairs, err := Decode([]byte(doc), &SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	if len(repairs) > 0 {
		t.Fatalf("state needs repair: %v", repairs)
	}
	return st
}

func mustEncode(t *testing.T, st *State) string {
	t.Helper()
	b, err := Encode(st)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestImportLegacyKeepsTheTabsAsTheyWere(t *testing.T) {
	panel := store6(map[string]any{"thread:s-0": map[string]any{"open": true, "groups": []any{group(pDiff["id"].(string), pFile, pDiff)}}})
	got, _, err := ImportLegacy(NewState("sp-a", "Main"), LegacyInput{Panel: panel, Threads: []LegacyThread{{ID: "s-0"}}}, &SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	rem := got.Threads["s-0"].Remembered
	if rem.Pane != "" {
		t.Errorf("remembered pane %q: the set has no pane, it is placed fresh", rem.Pane)
	}
	f, d := rem.Tabs[0], rem.Tabs[1]
	if f.Tab.Kind != "file" || f.Tab.Thread != "s-0" || f.Tab.Title != "a.ts" || f.Tab.Params["line"] != "4" || f.Tab.Key != "file:/wt/web/a.ts" || f.Active {
		t.Errorf("file tab %+v", f)
	}
	if d.Tab.Key != "diff:s-0:web:/wt/web" || !d.Active || d.Pane != "" || d.Beside != nil {
		t.Errorf("diff tab %+v", d)
	}
}

// After the import, opening a thread brings its tabs and terminals back beside it, the
// terminals the same ones, and nothing else opens.
func TestImportLegacyThenOpenTheThread(t *testing.T) {
	panel := store6(map[string]any{"thread:s-3": map[string]any{"open": true, "groups": []any{group("", pDiff, pFile)}}})
	in := LegacyInput{
		Panel: panel, Bottom: bottom1(map[string]any{"thread:s-3": map[string]any{"open": true, "height": 280}}),
		Threads:   []LegacyThread{{ID: "s-3"}, {ID: "s-4"}},
		Terminals: []LegacyTerminal{lterm("t-3a", "s-3", "shell", 1), lterm("t-3b", "s-3", "shell", 2), lterm("t-3c", "s-3", "action", 3)},
	}
	ids := &SeqIDs{}
	st, _, err := ImportLegacy(NewState("sp-a", "Main"), in, ids)
	if err != nil {
		t.Fatal(err)
	}
	emptyLayout(t, st)
	st, res, err := Apply(st, &OpenThread{Thread: "s-3", Focus: true}, ids)
	if err != nil {
		t.Fatal(err)
	}
	if got := layoutShape(st.Spaces[0].Root); got != "row(p-n1[thread:s-3]*thread:s-3:0.550000000, p-n2[t-n1 t-n2 t-n3 t-n4]*t-n1:0.450000000)" {
		t.Errorf("after open: %s", got)
	}
	if len(res.Placed) != 4 || len(res.Fresh) != 0 {
		t.Errorf("placed %v fresh %v", res.Placed, res.Fresh)
	}
	if !Holds(st, "t-3b") || !Holds(st, "t-3c") || Holds(st, "t-3a") {
		t.Errorf("held terminals %v", HeldTerminals(st))
	}
	if q := st.Threads["s-3"].Quick; q == nil || !q.Open || q.Height != 280 {
		t.Errorf("quick %+v", q)
	}
}

// A terminal that no longer exists when the import runs (a daemon restart ended it, as every
// update's does) is not carried: it is in no remembered set, nothing marks it to come back as a
// fresh shell, and opening its thread starts no shell for it. A terminal still running (started
// on the new daemon while an old window was open; the classic window gave it a layout tab) is
// carried as before, the same terminal. docs/notes/shell-20-cutover.md, "Terminals at import".
func TestImportLegacyCarriesOnlyLiveTerminals(t *testing.T) {
	// The layout as the new daemon's shells left it: automatic tabs of a terminal that died with
	// the old daemon (t-dead) and of one started since (t-live, t-live2).
	st := NewState("sp-a", "Main")
	ids := &SeqIDs{}
	var err error
	for _, term := range []string{"t-dead", "t-live", "t-live2"} {
		tab := &Tab{Kind: "terminal", Thread: "s-3", Params: map[string]string{TerminalParam: term}}
		if st, _, err = Apply(st, &OpenSurface{Tab: tab}, ids); err != nil {
			t.Fatal(err)
		}
	}
	in := LegacyInput{
		// The bottom store says the thread's terminals were open; it names no terminal.
		Bottom:    bottom1(map[string]any{"thread:s-3": map[string]any{"open": true, "height": 280}, "thread:s-4": map[string]any{"open": true, "height": 200}}),
		Threads:   []LegacyThread{{ID: "s-3"}, {ID: "s-4"}},
		Terminals: []LegacyTerminal{lterm("t-live", "s-3", "shell", 5), lterm("t-live2", "s-3", "shell", 6)},
	}
	st, res, err := ImportLegacy(st, in, ids)
	if err != nil {
		t.Fatal(err)
	}
	emptyLayout(t, st)
	// t-live is the quick shell, t-live2 a remembered tab; t-dead is nowhere.
	if got := remembered(st, "s-3"); got != "terminal:t-live2 quick=true/280" {
		t.Errorf("s-3: %s", got)
	}
	if res.Quick["s-3"] != "t-live" {
		t.Errorf("quick %v", res.Quick)
	}
	if !slices.ContainsFunc(res.Dropped, func(d string) bool { return strings.Contains(d, "terminal t-dead is gone") }) {
		t.Errorf("dropped %v: want t-dead's tab listed", res.Dropped)
	}
	// s-4 had bottom terminals that all died: no terminal, no fresh shell, its quick slot closed.
	if got := remembered(st, "s-4"); strings.Contains(got, "terminal") || strings.Contains(got, "quick=true") {
		t.Errorf("s-4: %s", got)
	}
	for _, th := range []string{"s-3", "s-4"} {
		st2, open, err := Apply(st, &OpenThread{Thread: th, Focus: true}, ids)
		if err != nil {
			t.Fatal(err)
		}
		if len(open.Fresh) != 0 {
			t.Errorf("%s: opening it starts shells %v", th, open.Fresh)
		}
		if Holds(st2, "t-dead") {
			t.Errorf("%s: the layout holds the dead terminal", th)
		}
	}
	if !Holds(st, "t-live2") {
		t.Errorf("held %v: want the live terminal kept", HeldTerminals(st))
	}
}

func TestReadBottom(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want string
	}{
		{``, `map[]`},
		{`not json`, `map[]`},
		{`{"version":1,"state":{"byKey":{"thread:s-1":{"open":true,"height":240},"thread:s-2":{"open":"yes","height":-4},"x":7}}}`, `map[thread:s-1:{true 240} thread:s-2:{false 0}]`},
		{`{"state":{"byKey":{"thread:s-1":{"open":true}}}}`, `map[thread:s-1:{true 0}]`},
		{`{"version":2,"state":{"byKey":{"thread:s-1":{"open":true}}}}`, `map[]`},
		{`{"version":1,"state":{"byKey":7}}`, `map[]`},
	} {
		got := map[string]bottomEntry{}
		for k, v := range readBottom([]byte(c.raw)) {
			got[k] = *v
		}
		if s := fmt.Sprint(got); s != c.want {
			t.Errorf("readBottom(%s) = %s, want %s", c.raw, s, c.want)
		}
	}
}

func TestImportLegacyCapturedStores(t *testing.T) {
	// Every captured store, as a thread's, through the import: what its panel holds of known
	// kinds is remembered, nothing more; a store with {} groups, absent or garbage gives nothing.
	data, err := os.ReadFile("testdata/legacy/panel.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []panelCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		raw := []byte(c.Stored)
		if c.Raw != nil {
			raw = []byte(*c.Raw)
		}
		// Rename every key to a thread's, as if each entry were a thread's panel.
		raw = []byte(strings.NewReplacer(`"k":`, `"thread:s-k":`, `"view:projects":`, `"thread:s-v":`, `"a":`, `"thread:s-a":`, `"b":`, `"thread:s-b":`).Replace(string(raw)))
		threads := []LegacyThread{{ID: "s-k"}, {ID: "s-v"}, {ID: "s-a"}, {ID: "s-b"}, {ID: "s-1"}, {ID: "s-2"}}
		st, res, err := ImportLegacy(NewState("sp-a", "Main"), LegacyInput{Panel: raw, Threads: threads}, &SeqIDs{})
		if err != nil {
			t.Fatalf("%s: %v", c.Doc, err)
		}
		emptyLayout(t, st)
		entries := readPanel(raw)
		for _, th := range threads {
			// What the thread should get: one tab per identity of a known kind; the rest dropped.
			keys, bad := map[string]bool{}, 0
			if e := entries["thread:"+th.ID]; e != nil {
				for _, g := range e.Groups {
					for _, pt := range g.Tabs {
						kind := legacyKinds[pt.Kind]
						if strings.HasPrefix(pt.Kind, "plugin.") {
							kind = pt.Kind
						}
						_, key, err := Identify(&Tab{Kind: kind, Thread: th.ID, Params: pt.Params})
						if err != nil {
							bad++
						} else {
							keys[key] = true
						}
					}
				}
			}
			got := 0
			if ts := st.Threads[th.ID]; ts != nil && ts.Remembered != nil {
				got = len(ts.Remembered.Tabs)
			}
			dropped := 0
			for _, d := range res.Dropped {
				if strings.HasPrefix(d, "thread "+th.ID+":") {
					dropped++
				}
			}
			if got != len(keys) || dropped != bad {
				t.Errorf("%s: thread %s: %d remembered, %d dropped; want %d and %d", c.Doc, th.ID, got, dropped, len(keys), bad)
			}
		}
	}
}

// A tab whose project is no longer registered, or whose plugin surface no installed plugin
// offers, would open as "Project not found" or "This surface is gone": the import drops it
// and lists it, from the side panel and from the layout's folded tabs alike. A diff of a
// registered project and a surface an installed plugin offers are kept. Nil lists check
// nothing (docs/notes/shell-24a-import-moves.md, item 1).
func TestImportLegacyDropsGoneProjectsAndPlugins(t *testing.T) {
	gDiff := ptab("diff", "Diff", map[string]string{"project": "gone", "worktree": "/wt/gone"})
	gPlug := ptab("plugin.weather.radar", "Radar", nil)
	panel := store6(map[string]any{
		"thread:s-0": map[string]any{"open": true, "groups": []any{group("", pFile, pDiff, gDiff, pPlug, gPlug)}},
	})
	// A classic shell's automatic diff of the gone project, folded from the layout.
	layoutDoc := `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[
		{"id":"sp-a","name":"Main","focus":"p-1","root":{"t":"pane","id":"p-1","active":"t-g","tabs":[
			{"id":"t-g","kind":"diff","thread":"s-1","params":{"project":"gone","worktree":"/wt/gone"}},
			{"id":"t-w","kind":"plugin.weather.radar","thread":"s-1"}]}}]}`
	known := map[string]bool{"web": true}
	plugins := map[string]bool{"plugin.notes.pad": true}
	tests := []struct {
		name     string
		projects map[string]bool
		surfaces map[string]bool
		want     map[string]string
		dropped  []string
	}{
		{
			name: "a gone project's diff and an uninstalled plugin's surface are dropped", projects: known, surfaces: plugins,
			want: map[string]string{"s-0": "file diff plugin.notes.pad", "s-1": "-"},
			dropped: []string{
				"thread s-0: side panel tab diff?project=gone&worktree=%2Fwt%2Fgone: project gone is not registered",
				"thread s-0: side panel tab plugin.weather.radar: no installed plugin offers plugin.weather.radar",
				"thread s-1: tab t-g: project gone is not registered",
				"thread s-1: tab t-w: no installed plugin offers plugin.weather.radar",
			},
		},
		{
			name: "no plugins installed: every plugin surface is dropped", projects: known, surfaces: map[string]bool{},
			want: map[string]string{"s-0": "file diff", "s-1": "-"},
			dropped: []string{
				"thread s-0: side panel tab diff?project=gone&worktree=%2Fwt%2Fgone: project gone is not registered",
				"thread s-0: side panel tab plugin.notes.pad: no installed plugin offers plugin.notes.pad",
				"thread s-0: side panel tab plugin.weather.radar: no installed plugin offers plugin.weather.radar",
				"thread s-1: tab t-g: project gone is not registered",
				"thread s-1: tab t-w: no installed plugin offers plugin.weather.radar",
			},
		},
		{
			name: "nothing known: nothing checked",
			want: map[string]string{"s-0": "file diff diff plugin.notes.pad plugin.weather.radar", "s-1": "diff plugin.weather.radar"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			in := LegacyInput{Panel: panel, Threads: []LegacyThread{{ID: "s-0"}, {ID: "s-1"}}, Projects: tc.projects, Surfaces: tc.surfaces}
			got, res, err := ImportLegacy(stateWith(t, layoutDoc), in, &SeqIDs{})
			if err != nil {
				t.Fatal(err)
			}
			emptyLayout(t, got)
			for th, want := range tc.want {
				if g := remembered(got, th); g != want {
					t.Errorf("thread %s: %s, want %s", th, g, want)
				}
			}
			if !slices.Equal(res.Dropped, tc.dropped) {
				t.Errorf("dropped\n%s\nwant\n%s", strings.Join(res.Dropped, "\n"), strings.Join(tc.dropped, "\n"))
			}
		})
	}
}

// The set an import gives a thread marks as active only the tab the classic window showed:
// the focused group's active tab. Opening the thread then shows that tab in the set's pane;
// with none (the focused group was picking), the first (item 2).
func TestImportLegacyActiveTab(t *testing.T) {
	split := func(focused int, a0, a1 string) []byte {
		return store6(map[string]any{"thread:s-0": map[string]any{"open": true, "focused": focused, "ratio": 0.5,
			"groups": []any{group(a0, pFile, pDiff), group(a1, pPR, pMCP)}}})
	}
	tests := []struct {
		name   string
		panel  []byte
		active string // the remembered tab marked active ("" none)
		shown  string // the kind the set's pane shows after the thread opens
	}{
		{"first group focused: its active tab", split(0, pDiff["id"].(string), pMCP["id"].(string)), "diff", "diff"},
		{"second group focused: its active tab", split(1, pDiff["id"].(string), pMCP["id"].(string)), "mcp", "mcp"},
		{"the focused group was picking: none, the first shows", split(1, pDiff["id"].(string), ""), "", "file"},
		{"one group, its active tab", store6(map[string]any{"thread:s-0": map[string]any{"open": true,
			"groups": []any{group(pPR["id"].(string), pFile, pPR)}}}), "pullrequest", "pullrequest"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ids := &SeqIDs{}
			st, _, err := ImportLegacy(NewState("sp-a", "Main"), LegacyInput{Panel: tc.panel, Threads: []LegacyThread{{ID: "s-0"}}}, ids)
			if err != nil {
				t.Fatal(err)
			}
			var active []string
			for _, rt := range st.Threads["s-0"].Remembered.Tabs {
				if rt.Active {
					active = append(active, rt.Tab.Kind)
				}
			}
			if want := slices.DeleteFunc([]string{tc.active}, func(s string) bool { return s == "" }); !slices.Equal(active, want) {
				t.Errorf("active records %v, want %v", active, want)
			}
			st, res, err := Apply(st, &OpenThread{Thread: "s-0", Focus: true}, ids)
			if err != nil {
				t.Fatal(err)
			}
			_, p, _ := st.FindTab(res.Placed[0])
			if got := p.ActiveTab().Kind; got != tc.shown {
				t.Errorf("the set's pane shows %s, want %s: %s", got, tc.shown, layoutShape(st.Spaces[0].Root))
			}
		})
	}
}
