package main

import (
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The demo's pickers (ui.PickerField): the Form tab's reviewers (people with avatars, in
// the settings form) and the Layout toolbar's branch filter. Each lists its picked values
// under Selected and a few recent ones before the user types; a search act answers with the
// entries whose name holds the query, echoing it (WithResults).

// person is one of the reviewers picker's people.
type person struct{ id, name, initials, team string }

var demoPeople = []person{
	{"ada", "Ada Lovelace", "A", "you"},
	{"alan", "Alan Turing", "A", "platform"},
	{"alejandra", "Alejandra Ruiz", "A", "platform"},
	{"alessio", "Alessio Conti", "A", "design"},
	{"grace", "Grace Hopper", "G", "infra"},
	{"kim", "Kim Park", "K", "design"},
	{"margaret", "Margaret Hamilton", "M", "infra"},
}

// recentPeople are listed before the user types; the release bot (an icon, not
// pickable) shows what a disabled option looks like.
var recentPeople = []string{"ada", "kim"}

var demoBranches = []string{"main", "cf/fix", "cf/retry", "cf/sidebar", "cf/plugin-picker", "release/0.30"}

var recentBranches = []string{"main", "cf/fix"}

func personOpt(prefix string, p person) ui.Option {
	return ui.Opt(prefix+p.id, p.id, p.name).WithAvatar(p.initials).WithDetail(p.team)
}

func personByID(id string) (person, bool) {
	i := slices.IndexFunc(demoPeople, func(p person) bool { return p.id == id })
	if i < 0 {
		return person{}, false
	}
	return demoPeople[i], true
}

// holds reports whether name holds query, ignoring case.
func holds(name, query string) bool {
	return strings.Contains(strings.ToLower(name), strings.ToLower(strings.TrimSpace(query)))
}

// reviewersField is the Form tab's people picker: picked, the people picked; query, the
// last search (its matches are the results).
func reviewersField(picked []string, query string) ui.Field {
	var opts []ui.Option
	for _, id := range picked {
		if p, ok := personByID(id); ok {
			opts = append(opts, personOpt("f-rev-sel-", p).InGroup("Selected"))
		}
	}
	for _, id := range recentPeople {
		if p, ok := personByID(id); ok && !slices.Contains(picked, id) {
			opts = append(opts, personOpt("f-rev-rec-", p).InGroup("Recent"))
		}
	}
	opts = append(opts, ui.Opt("f-rev-rec-bot", "bot", "Release bot").WithIcon("bot").WithDetail("cannot review").InGroup("Recent").AsDisabled())
	var results []ui.Option
	if query != "" {
		for _, p := range demoPeople {
			if holds(p.name, query) {
				results = append(results, personOpt("f-rev-match-", p).InGroup("Matches"))
			}
		}
	}
	f := ui.PickerField("f-reviewers", "reviewers", "Reviewers", "search-people", opts...).AsMultiple().WithValues(picked...).
		WithPlaceholder("No one yet").WithSearchPlaceholder("Search people").WithResults(query, results...)
	f.Description = ui.Plain("A picker: type 2+ characters and the plugin searches.")
	return f
}

// branchField is the Layout toolbar's branch filter: a compact multiple picker whose change
// filters the runs.
func branchField(picked []string, query string) ui.Field {
	opt := func(prefix, b string) ui.Option {
		return ui.Opt(prefix+strings.ReplaceAll(b, "/", "-"), b, b).WithIcon("git-branch")
	}
	var opts []ui.Option
	for _, b := range picked {
		opts = append(opts, opt("layout-br-sel-", b).InGroup("Selected"))
	}
	for _, b := range recentBranches {
		if !slices.Contains(picked, b) {
			opts = append(opts, opt("layout-br-rec-", b).InGroup("Recent"))
		}
	}
	var results []ui.Option
	if query != "" {
		for _, b := range demoBranches {
			if holds(b, query) {
				results = append(results, opt("layout-br-match-", b))
			}
		}
	}
	return ui.PickerField("layout-branch", "branch", "Branch", "search-branches", opts...).AsMultiple().WithValues(picked...).
		WithSearchPlaceholder("Search branches").WithChange("layout-branch").WithResults(query, results...)
}

// stringsOf reads a multiple select's value from an act's values ([]any from JSON).
func stringsOf(v any) []string {
	var out []string
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			if s, ok := e.(string); ok && s != "" {
				out = append(out, s)
			}
		}
	case []string:
		out = append(out, x...)
	}
	return out
}
