package ui

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// pickerSeed has a multiple picker in a toolbar form (picked values, grouped options with
// avatars, icons, details, a disabled one, and results answering a query) and a single
// picker in a body form: FuzzView's seed for the picker's fields.
const pickerSeed = `{"toolbar":[{"key":"tb","form":{"fields":[
  {"key":"who","name":"who","label":"Assignee","change":{"event":"who"},"select":{"multiple":true,"value":["me","kim"],"placeholder":"Anyone",
    "options":[{"key":"o-me","value":"me","label":"Me","avatar":"AW","detail":"you","group":"Selected"},
      {"key":"o-kim","value":"kim","label":"Kim Park","avatar":"K","group":"Selected"},
      {"key":"o-bot","value":"bot","label":"Release bot","icon":"bot","group":"Recent","disabled":true}],
    "search":{"key":"who-search","event":"search-people","placeholder":"Search people","query":"ale",
      "results":[{"key":"m-ale","value":"ale","label":"Alejandra Ruiz","avatar":"AR","detail":"platform","group":"Matches"}]}}}]}}],
 "nodes":[{"key":"f","form":{"fields":[{"key":"lbl","name":"label","label":"Label","select":{"value":["bug"],
   "options":[{"key":"l-bug","value":"bug","label":"bug","icon":"bug"}],"search":{"key":"lbl-s","event":"search-labels"}}}],
   "submit":{"key":"f-go","label":"Save","action":{"event":"save"}}}}]}`

func TestPickerValidate(t *testing.T) {
	opt := func(i int) Option { return Opt(fmt.Sprintf("o%d", i), fmt.Sprint(i), fmt.Sprint("Option ", i)) }
	opts := func(n int, f func(i int, o Option) Option) []Option {
		out := make([]Option, n)
		for i := range out {
			out[i] = f(i, opt(i))
		}
		return out
	}
	picker := func(options ...Option) Field { return PickerField("p", "p", "People", "search", options...) }
	view := func(f Field) View { return View{Nodes: []Node{NewForm("f", nil, f)}} }
	tests := []struct {
		name  string
		field Field
		want  string // "" valid
	}{
		{"a picker", picker(opt(1).InGroup("Recent").WithAvatar("AW").WithDetail("you"), opt(2).WithIcon("bot").AsDisabled()), ""},
		{"results answer a query", picker(opt(1)).WithResults("al", Opt("r1", "1", "Ada")), ""},
		{"multiple with values", picker(opt(1)).AsMultiple().WithValues("1", "2"), ""},
		{"no event", PickerField("p", "p", "P", ""), "select.search.event: required"},
		{"the change's event", picker().WithChange("search"), `"search" is also the field's change event`},
		{"results without a query", picker().WithResults(" ", Opt("r1", "1", "Ada")), "results answer a query"},
		{"a list style", Field{Key: "p", Name: "p", Select: &Select{Style: SelectList, Search: &Search{Key: "p-s", Event: "s"}}}, "a picker is a dropdown"},
		{"an options source", Field{Key: "p", Name: "p", Select: &Select{OptionsSource: OptionsProjects, Search: &Search{Key: "p-s", Event: "s"}}}, "not a source's"},
		{"a search key taken", Field{Key: "p", Name: "p", Select: &Select{Search: &Search{Key: "p", Event: "s"}}}, `"p" is already used`},
		{"a result key taken", picker(opt(1)).WithResults("al", opt(1)), `"o1" is already used`},
		{"too many picked", picker().AsMultiple().WithValues(strings.Split(strings.Repeat("v,", MaxPicked+1), ",")[:MaxPicked+1]...), "select.value: 21 values, at most 20"},
		{"too many groups", picker(opts(MaxOptionGroups+1, func(i int, o Option) Option { return o.InGroup(fmt.Sprint("g", i)) })...), "9 groups, at most 8"},
		{"too many results", picker().WithResults("al", opts(MaxOptions+1, func(_ int, o Option) Option { return o })...), "201 options, at most 200"},
		{"a long group", picker(opt(1).InGroup(strings.Repeat("g", MaxSectionTitle+1))), "group: 61 characters"},
		{"a long detail", picker(opt(1).WithDetail(strings.Repeat("d", MaxOptionDetail+1))), "detail: 41 characters"},
		{"a long avatar", picker(opt(1).WithAvatar("ABC")), "one or two initials"},
		{"a blank avatar", picker(opt(1).WithAvatar(" ")), "one or two initials"},
		{"avatar and icon", picker(opt(1).WithAvatar("A").WithIcon("bot")), "an avatar or an icon, not both"},
		{"a bad icon", picker(opt(1).WithIcon("Bot")), "not a lucide icon name"},
		{"a description", picker(Option{Key: "o", Value: "v", Label: "L", Description: Plain("d")}), "a detail, not a description"},
		{"a long query", picker().WithResults(strings.Repeat("q", MaxSearchQuery+1)), "query: 201 characters"},
		{"rich options without search", SelectField("s", "s", "S", opt(1).WithDetail("x")), "are a picker's"},
		{"a result without a label", picker().WithResults("al", Opt("r", "v", "")), "results[0].label: required"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := view(tt.field).Validate()
			if tt.want == "" {
				if err != nil {
					t.Fatalf("Validate: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Validate = %v, want %q", err, tt.want)
			}
		})
	}
}

// A picker in a toolbar form is allowed (a dropdown); a list-style select there still is
// not, and a picker counts its options and results toward MaxElements.
func TestPickerInStrip(t *testing.T) {
	var v View
	if err := json.Unmarshal([]byte(pickerSeed), &v); err != nil {
		t.Fatal(err)
	}
	if err := v.Validate(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	big := PickerField("p", "p", "P", "s")
	big.Select.Options = make([]Option, MaxOptions)
	results := make([]Option, MaxOptions)
	for i := range MaxOptions {
		big.Select.Options[i] = Opt(fmt.Sprint("o", i), "v", "L")
		results[i] = Opt(fmt.Sprint("r", i), "v", "L")
	}
	big = big.WithResults("al", results...)
	if err := (View{Toolbar: []Node{NewForm("f", nil, big)}}).Validate(); err == nil || !strings.Contains(err.Error(), "elements, at most 400") {
		t.Fatalf("400 options and results: %v", err)
	}
}

func TestPickerBuilders(t *testing.T) {
	f := PickerField("who", "who", "Assignee", "search-people", Opt("o-me", "me", "Me").WithAvatar("AW").InGroup("Recent")).
		AsMultiple().WithValues("me").WithChange("who").WithSearchPlaceholder("Search people").WithPlaceholder("Anyone").
		WithResults("ale", Opt("m-ale", "ale", "Alejandra").WithDetail("platform"))
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"key":"who","name":"who","label":"Assignee","change":{"event":"who"},"select":{"options":[{"key":"o-me","value":"me","label":"Me","group":"Recent","avatar":"AW"}],` +
		`"value":["me"],"multiple":true,"placeholder":"Anyone","search":{"key":"who-search","event":"search-people","placeholder":"Search people","query":"ale",` +
		`"results":[{"key":"m-ale","value":"ale","label":"Alejandra","detail":"platform"}]}}}`
	if string(b) != want {
		t.Errorf("encoded\n%s\nwant\n%s", b, want)
	}
	// The With… helpers copy: the field they started from is unchanged.
	base := PickerField("p", "p", "P", "s")
	_ = base.WithResults("al", Opt("r", "v", "L")).AsMultiple().WithValues("v").WithSearchPlaceholder("x")
	if base.Select.Search.Query != "" || base.Select.Multiple || base.Select.Value != nil || base.Select.Search.Placeholder != "" {
		t.Errorf("a helper changed its receiver: %+v %+v", base.Select, base.Select.Search)
	}
	// Helpers that are a picker's leave other fields as they are.
	if txt := TextField("t", "t", "T").WithResults("q").WithSearchPlaceholder("x").AsMultiple().WithValues("v"); txt.Select != nil {
		t.Errorf("a text field got a select: %+v", txt)
	}
}
