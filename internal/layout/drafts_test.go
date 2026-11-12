package layout

import (
	"reflect"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDecodeDrafts(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		repairs []string // substrings, one per repair, in order
		check   func(t *testing.T, st *State)
	}{
		{
			name: "a document written before drafts needs no repair: its composer is the empty one",
			in: `{"v":1,"spaces":[{"id":"sp-a","name":"Main","root":{"t":"pane","id":"p-a","tabs":[
			        {"id":"t-a","kind":"compose","key":"compose","params":{"project":"pj"}}],"active":"t-a"},"focus":"p-a"}],
			      "current_space":"sp-a","default_space":"sp-a"}`,
			check: func(t *testing.T, st *State) {
				if _, tb := emptyComposer(st.Spaces[0]); tb == nil || tb.ID != "t-a" || st.Spaces[0].Drafts != nil {
					t.Errorf("empty composer %+v, drafts %+v", tb, st.Spaces[0].Drafts)
				}
			},
		},
		{
			name: "a document from before PR 2 with two composers keeps the first as the empty one",
			in: `{"v":1,"spaces":[{"id":"sp-a","name":"Main","root":{"t":"pane","id":"p-a","tabs":[
			        {"id":"t-a","kind":"compose","key":"compose:home"},{"id":"t-b","kind":"compose","key":"compose:project:pj","params":{"project":"pj"}}],"active":"t-a"},"focus":"p-a"}],
			      "current_space":"sp-a","default_space":"sp-a"}`,
			repairs: []string{"key \"compose:home\"", "key \"compose:project:pj\"", "dropped tab \"t-b\", a second compose"},
		},
		{
			name: "draft lists are repaired",
			in: `{"v":1,"spaces":[
			        {"id":"sp-a","name":"A","root":{"t":"pane","id":"p-a","tabs":[
			          {"id":"t-1","kind":"compose","params":{"draft":"d-1","project":"pj"}},
			          {"id":"t-3","kind":"compose","params":{"draft":"d-3"}}],"active":"t-1"},"focus":"p-a",
			         "drafts":[{"id":"d-1","label":" two\nlines ","params":{"draft":"d-1"}},null,{"id":""},{"id":"d-2","label":"B"}]},
			        {"id":"sp-b","name":"B","root":{"t":"pane","id":"p-b","tabs":[
			          {"id":"t-2","kind":"compose","params":{"draft":"d-2"}},
			          {"id":"t-4","kind":"compose","params":{"draft":"d-1"}}],"active":"t-2"},"focus":"p-b",
			         "drafts":[{"id":"d-2","label":"again"}]}],
			      "current_space":"sp-a","default_space":"sp-a"}`,
			// In the order the sanitizer meets them: tabs, then each list entry, then open drafts.
			repairs: []string{
				"dropped tab \"t-4\", a second tab of draft d-1",
				"draft d-1: label \" two\\nlines \" is now \"two lines\"",
				"draft d-1: dropped the draft id from its params",
				"space sp-a: dropped a draft without an id",
				"space sp-a: dropped a draft without an id",
				"space sp-b: dropped draft d-2, listed before",
				"draft d-1: params are now its tab's",
				"draft d-3: open in space sp-a but listed nowhere",
				"draft d-2: open in space sp-b, listed by sp-a, moved",
			},
			check: func(t *testing.T, st *State) {
				a, b := st.Space("sp-a"), st.Space("sp-b")
				ids := func(sp *Space) []string {
					var out []string
					for _, d := range sp.Drafts {
						out = append(out, d.ID)
					}
					return out
				}
				if !slices.Equal(ids(a), []string{"d-1", "d-3"}) || !slices.Equal(ids(b), []string{"d-2"}) {
					t.Errorf("drafts A %v, B %v", ids(a), ids(b))
				}
				if d := a.Drafts[0]; d.Label != "two lines" || d.Params["project"] != "pj" || len(d.Params) != 1 {
					t.Errorf("d-1 %+v", d)
				}
				if b.Drafts[0].Label != "B" {
					t.Errorf("d-2 kept label %q, want the first listing's", b.Drafts[0].Label)
				}
			},
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

func TestCheckDrafts(t *testing.T) {
	base := func() *State {
		st, _, err := Decode([]byte(`{"v":1,"spaces":[
		  {"id":"sp-a","name":"A","root":{"t":"pane","id":"p-a","tabs":[{"id":"t-1","kind":"compose","params":{"draft":"d-1"}}],"active":"t-1"},"focus":"p-a","drafts":[{"id":"d-1"}]},
		  {"id":"sp-b","name":"B","root":null}],"current_space":"sp-a","default_space":"sp-a"}`), &SeqIDs{})
		if err != nil {
			t.Fatal(err)
		}
		return st
	}
	tests := []struct {
		name    string
		breakIt func(st *State)
		want    string
	}{
		{"listed by another space", func(st *State) {
			st.Space("sp-b").Drafts, st.Space("sp-a").Drafts = st.Space("sp-a").Drafts, nil
		}, "does not list draft d-1"},
		{"listed twice", func(st *State) { st.Space("sp-b").Drafts = []*Draft{{ID: "d-1"}} }, "listed twice"},
		{"stale params", func(st *State) { st.Space("sp-a").Drafts[0].Params = map[string]string{"project": "x"} }, "its tab has"},
		{"label of two lines", func(st *State) { st.Space("sp-a").Drafts[0].Label = "a\nb" }, "one short line"},
		{"no id", func(st *State) { st.Space("sp-b").Drafts = []*Draft{{}} }, "without an id"},
		{"two tabs", func(st *State) {
			st.Space("sp-b").Root = &Node{T: NodePane, ID: "p-b", Active: "t-2", Tabs: []*Tab{{ID: "t-2", Kind: "compose", Key: "compose:draft:d-1", Params: map[string]string{"draft": "d-1"}}}}
			st.Space("sp-b").Focus = "p-b"
		}, "both draft d-1"},
	}
	if err := Check(base()); err != nil {
		t.Fatalf("base: %v", err)
	}
	for _, tt := range tests {
		st := base()
		tt.breakIt(st)
		if err := Check(st); err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%s: Check = %v, want %q", tt.name, err, tt.want)
		}
	}
}

func TestDraftLabel(t *testing.T) {
	long := strings.Repeat("ab ", 40)
	tests := []struct{ in, want string }{
		{"", ""},
		{"  Fix\n\tthe   build ", "Fix the build"},
		{long, strings.TrimSpace(long[:MaxDraftLabel])},
		{strings.Repeat("é", 100), strings.Repeat("é", MaxDraftLabel)},
	}
	for _, tt := range tests {
		got := draftLabel(tt.in)
		if got != tt.want || draftLabel(got) != got || utf8.RuneCountInString(got) > MaxDraftLabel {
			t.Errorf("draftLabel(%q) = %q, want %q (and stable)", tt.in, got, tt.want)
		}
	}
}

func TestSpaceDocDrafts(t *testing.T) {
	sp := &Space{ID: "sp-a", Name: "Main", Drafts: []*Draft{{ID: "d-1", Label: "Fix", Params: map[string]string{"project": "pj"}}, {ID: "d-2"}}}
	b, err := EncodeSpaceDoc(sp)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeSpaceDoc("sp-a", "Main", b)
	if err != nil || !reflect.DeepEqual(got, sp) {
		t.Errorf("space doc round trip: %+v, %v", got, err)
	}
	if c := sp.clone(); !reflect.DeepEqual(c, sp) || c.Drafts[0] == sp.Drafts[0] {
		t.Error("clone of a space with drafts is not a deep copy")
	}
	// A space document written before drafts reads with none.
	old, err := DecodeSpaceDoc("sp-a", "Main", []byte(`{"v":1,"root":null}`))
	if err != nil || old.Drafts != nil {
		t.Errorf("old space doc: %+v, %v", old, err)
	}
}

func TestDraftOpsJSON(t *testing.T) {
	ops := []Op{
		&NewThread{Space: "sp-a", Pane: "p-a", Params: map[string]string{"project": "pj"}, Focus: true},
		&StartDraft{Tab: "t-a", Draft: "d-1", Label: "Fix"},
		&LabelDraft{Draft: "d-1", Label: "Fix it"},
		&ClearDraft{Draft: "d-1"},
		&DiscardDraft{Draft: "d-1"},
		&OpenDraft{Draft: "d-1", Focus: true},
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
}
