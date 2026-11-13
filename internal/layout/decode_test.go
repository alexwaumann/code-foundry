package layout

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestDecodeRepairs(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		repairs []string // substrings, one per repair, in order
		check   func(t *testing.T, st *State)
	}{
		{
			name:    "nothing at all gets one space",
			in:      `{}`,
			repairs: []string{"no space"},
			check: func(t *testing.T, st *State) {
				if len(st.Spaces) != 1 || st.Spaces[0].Name != "Main" || st.CurrentSpace != st.Spaces[0].ID || st.DefaultSpace != st.Spaces[0].ID {
					t.Errorf("state %+v", st)
				}
			},
		},
		{
			name: "a normal state needs no repair",
			in: `{"v":1,"spaces":[{"id":"sp-a","name":"Main","root":{"t":"pane","id":"p-a","tabs":[{"id":"t-a","kind":"prs"}],"active":"t-a"},"focus":"p-a","mru":["t-a"]}],
			      "current_space":"sp-a","default_space":"sp-a"}`,
		},
		{
			name:    "version 0 reads as 1; unknown current and default spaces fall back to the first",
			in:      `{"spaces":[{"id":"sp-a","name":"Main","root":null}],"current_space":"sp-x"}`,
			repairs: []string{"current space \"sp-x\"", "default space \"\""},
		},
		{
			name: "tabs that cannot be shown are dropped, an emptied pane goes with its split",
			in: `{"v":1,"spaces":[{"id":"sp-a","name":"Main","root":{"t":"split","id":"s-1","dir":"row","sizes":[0.5,0.5],"kids":[
			        {"t":"pane","id":"p-a","tabs":[{"id":"t-a","kind":"files","params":{"path":"/a"}}],"active":"t-a"},
			        {"t":"pane","id":"p-b","tabs":[{"id":"t-b","kind":"prs"}],"active":"t-b"}]},"focus":"p-a","mru":["t-a","t-b"]}],
			      "current_space":"sp-a","default_space":"sp-a"}`,
			repairs: []string{"dropped tab \"t-a\"", "normal form", "focus \"p-a\"", "MRU repaired"},
			check: func(t *testing.T, st *State) {
				if shape(st.Spaces[0].Root) != "p-b" || st.Spaces[0].Focus != "p-b" {
					t.Errorf("tree %s focus %s", shape(st.Spaces[0].Root), st.Spaces[0].Focus)
				}
			},
		},
		{
			name: "a second open surface is dropped, a repeated id is renewed, a wrong key is recomputed",
			in: `{"v":1,"spaces":[{"id":"sp-a","name":"Main","root":{"t":"pane","id":"p-a","tabs":[
			        {"id":"t-a","kind":"prs","key":"wrong"},{"id":"t-b","kind":"prs"},{"id":"t-a","kind":"projects"}],"active":"t-a"},"focus":"p-a"}],
			      "current_space":"sp-a","default_space":"sp-a"}`,
			repairs: []string{"key \"wrong\"", "dropped tab \"t-b\", a second prs", "tab \"t-a\": new id"},
		},
		{
			name: "a split of an unknown direction becomes a row; one with sizes missing gets equal ones; unknown nodes go",
			in: `{"v":1,"spaces":[{"id":"sp-a","name":"Main","root":{"t":"split","id":"s-1","dir":"diagonal","kids":[
			        {"t":"pane","id":"p-a","tabs":[{"id":"t-a","kind":"prs"}]},{"t":"blob","id":"x"},{"t":"pane","id":"p-b","tabs":[{"id":"t-b","kind":"projects"}]}]},"focus":"p-a"}],
			      "current_space":"sp-a","default_space":"sp-a"}`,
			repairs: []string{"direction \"diagonal\"", "0 sizes for 3 children", "dropped node \"x\"", "normal form"},
			check: func(t *testing.T, st *State) {
				if got := shape(st.Spaces[0].Root); got != "s-1:row(p-a .5, p-b .5)" {
					t.Errorf("tree %s", got)
				}
			},
		},
		{
			name: "a thread lives where its tab is; a thread state in a gone space moves to the default",
			in: `{"v":1,"spaces":[{"id":"sp-a","name":"Main","root":null},{"id":"sp-b","name":"","root":{"t":"pane","id":"p-a","tabs":[{"id":"t-a","kind":"thread","thread":"th-1"}],"active":"t-a"},"focus":"p-a"}],
			      "current_space":"sp-a","default_space":"sp-a","threads":{"th-2":{"space":"sp-gone"},"th-3":null}}`,
			repairs: []string{"space sp-b: named \"Space 2\"", "", "", "thread th-1: its tab is in space sp-b"},
			check: func(t *testing.T, st *State) {
				if st.SpaceOf("th-1") != "sp-b" || st.SpaceOf("th-2") != "sp-a" || st.Threads["th-3"] != nil {
					t.Errorf("threads %+v", st.Threads)
				}
			},
		},
		{
			name:    "a repeated space id is renewed; a manual name on a kind without one is dropped",
			in:      `{"v":1,"spaces":[{"id":"sp-a","name":"A","root":{"t":"pane","id":"p-a","tabs":[{"id":"t-a","kind":"prs","name":"x"}]}},{"id":"sp-a","name":"B","root":null}],"current_space":"sp-a","default_space":"sp-a"}`,
			repairs: []string{"space \"sp-a\": new id", "dropped the name", "normal form", "focus \"\""},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st, repairs, err := Decode([]byte(tt.in), &SeqIDs{})
			if err != nil {
				t.Fatal(err)
			}
			if err := Check(st); err != nil {
				t.Fatalf("not in normal form: %v", err)
			}
			if len(repairs) != len(tt.repairs) {
				t.Fatalf("repairs %q, want %d like %q", repairs, len(tt.repairs), tt.repairs)
			}
			for i, want := range tt.repairs {
				if !strings.Contains(repairs[i], want) {
					t.Errorf("repair %d is %q, want it to name %q", i, repairs[i], want)
				}
			}
			if tt.check != nil {
				tt.check(t, st)
			}
		})
	}
}

func TestDecodeRefuses(t *testing.T) {
	tests := []struct {
		in   string
		want error
	}{
		{`{"v":2}`, ErrNewerVersion},
		{`not json`, ErrInvalidArgument},
		{`{"spaces":"x"}`, ErrInvalidArgument},
	}
	for _, tt := range tests {
		if _, _, err := Decode([]byte(tt.in), &SeqIDs{}); !errors.Is(err, tt.want) {
			t.Errorf("Decode(%s) = %v, want %v", tt.in, err, tt.want)
		}
	}
}

func TestDocsRoundTrip(t *testing.T) {
	space := &Space{ID: "sp-a", Name: "Main", Root: pn("p-a"), Focus: "p-a", MRU: []string{"tp-a"}}
	b, err := EncodeSpaceDoc(space)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(b), `{"v":1,`) {
		t.Errorf("space doc %s has no version first", b)
	}
	got, err := DecodeSpaceDoc("sp-a", "Main", b)
	if err != nil || !reflect.DeepEqual(got, space) {
		t.Errorf("space doc round trip: %+v, %v", got, err)
	}
	if _, err := DecodeSpaceDoc("sp-a", "Main", []byte(`{"v":9}`)); !errors.Is(err, ErrNewerVersion) {
		t.Errorf("newer space doc: %v", err)
	}
	if _, err := DecodeSpaceDoc("sp-a", "Main", []byte(`[`)); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("broken space doc: %v", err)
	}

	ts := &ThreadState{
		Space: "sp-a",
		Quick: &Quick{Open: true, Height: 200},
		Remembered: &Remembered{Pane: "p-a", Tabs: []RememberedTab{{
			Tab:  &Tab{ID: "t-1", Kind: "terminal", Thread: "th-1", Key: "term:x", Params: map[string]string{"terminal": "x"}},
			Pane: "p-b", Index: 1, Active: true, Adjacent: true,
			Beside: &Beside{Neighbours: []string{"p-a"}, Edge: Right, Frac: 0.45},
			Fresh:  &Fresh{Ran: "make dev"},
		}}},
		Last: map[string]string{"diff": "t-9"},
		Info: new(bool),
	}
	b, err = EncodeThreadDoc(ts)
	if err != nil {
		t.Fatal(err)
	}
	got2, err := DecodeThreadDoc("sp-a", b)
	if err != nil || !reflect.DeepEqual(got2, ts) {
		t.Errorf("thread doc round trip: %+v, %v", got2, err)
	}
	if !reflect.DeepEqual(ts.clone(), ts) {
		t.Error("clone of a thread state differs")
	}
	if _, err := DecodeThreadDoc("sp-a", []byte(`{"v":2}`)); !errors.Is(err, ErrNewerVersion) {
		t.Errorf("newer thread doc: %v", err)
	}
}

func TestOpJSON(t *testing.T) {
	idx := 2
	ops := []Op{
		&AddTab{Pane: "p-a", Tab: &Tab{Kind: "prs"}, Index: &idx, Focus: true},
		&SplitPane{Pane: "p-a", Edge: Right, Tab: &Tab{Kind: "prs"}, Frac: 0.3},
		&SwitchSpace{Space: "sp-a"},
		&ReorderSpaces{},
	}
	for _, op := range ops {
		b, err := EncodeOp(op)
		if err != nil {
			t.Fatal(err)
		}
		got, err := DecodeOp(b)
		if err != nil {
			t.Fatalf("%s: %v", b, err)
		}
		if !reflect.DeepEqual(got, op) {
			t.Errorf("round trip of %s: %+v", b, got)
		}
	}
	for _, bad := range []string{`{"op":"nope"}`, `{"op":"close_tab","tabb":"t-a"}`, `[1]`, `{"op":"close_tab","tab":3}`} {
		if _, err := DecodeOp([]byte(bad)); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("DecodeOp(%s) = %v, want invalid argument", bad, err)
		}
	}
}
