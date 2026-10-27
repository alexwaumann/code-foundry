package gh

import (
	"slices"
	"testing"
)

func TestReviewerSearchTokens(t *testing.T) {
	tests := []struct {
		query string
		want  []string
	}{
		{"", []string{}},
		{"   ", []string{}},
		{"jane", []string{"jane"}},
		{"jane doe", []string{"jane", "doe"}},
		{"doe, jane", []string{"doe", "jane"}},
		{"Doe,Jane", []string{"Doe", "Jane"}},
		{" ,, jane\tdoe ,", []string{"jane", "doe"}},
		{"a b c d e f", []string{"a", "b", "c", "d"}},
		{"jane-doe", []string{"jane-doe"}},
	}
	for _, tt := range tests {
		got := reviewerSearchTokens(tt.query)
		if !slices.Equal(got, tt.want) {
			t.Errorf("%q: got %q, want %q", tt.query, got, tt.want)
		}
	}
}

func TestReviewerSearchRank(t *testing.T) {
	tests := []struct {
		name, login, user, query string
		want                     int
		ok                       bool
	}{
		{name: "first last against a stored last, first", login: "jdoe", user: "Doe, Jane", query: "jane doe", want: rankNamePrefix, ok: true},
		{name: "last, first", login: "jdoe", user: "Doe, Jane", query: "doe, jane", want: rankNamePrefix, ok: true},
		{name: "case and punctuation do not matter", login: "jdoe", user: "DOE, JANE", query: "Jane, Doe.", want: rankNamePrefix, ok: true},
		{name: "a login prefix ranks first", login: "jane-doe", user: "", query: "jane doe", want: rankLoginPrefix, ok: true},
		{name: "a login-only hit", login: "kim-lee", user: "", query: "kim lee", want: rankLoginPrefix, ok: true},
		{name: "words split between login and name", login: "jdoe", user: "Jane", query: "jane jdoe", want: rankLoginPrefix, ok: true},
		{name: "inside words only", login: "xjanex", user: "Mary Doeville", query: "jane doe", want: rankContains, ok: true},
		{name: "a missing word drops the user", login: "janet", user: "Janet Smith", query: "jane doe", ok: false},
		{name: "a missing word in either field", login: "doe-j", user: "John Doe", query: "jane doe", ok: false},
		{name: "apostrophes fold", login: "mob", user: "Mary O'Brien", query: "obrien mary", want: rankNamePrefix, ok: true},
		{name: "punctuation-only words are ignored", login: "jdoe", user: "Doe, Jane", query: "jane - doe", want: rankNamePrefix, ok: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := reviewerSearchRank(tt.login, tt.user, foldTokens(reviewerSearchTokens(tt.query)))
			if ok != tt.ok || ok && got != tt.want {
				t.Errorf("rank = %d, %v; want %d, %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestFilterReviewerSearch(t *testing.T) {
	cands := []ReviewerCandidate{
		{Login: "Zdoe", Name: "Doerr, Janelle"},
		{Login: "xjanex", Name: "Mary Doeville"},
		{Login: "jdoe", Name: "Doe, Jane"},
		{Login: "janet", Name: "Janet Smith"},
		{Login: "janedoe", Name: ""},
		{Login: "adoe", Name: "Jane Adoe"},
	}
	var got []string
	for _, c := range filterReviewerSearch(cands, reviewerSearchTokens("jane doe")) {
		got = append(got, c.Login)
	}
	// Login prefix, then name-word prefixes by login (case-insensitive), then the rest.
	if want := []string{"janedoe", "jdoe", "Zdoe", "adoe", "xjanex"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestReviewerCandidatesVars(t *testing.T) {
	tests := []struct {
		query  string
		search bool
		words  []string // q0..q3; "" where unset
	}{
		{query: "", search: false, words: []string{"", "", "", ""}},
		{query: "jane", search: true, words: []string{"", "", "", ""}},
		{query: "jane doe", search: true, words: []string{"jane", "doe", "", ""}},
		{query: "doe, jane", search: true, words: []string{"doe", "jane", "", ""}},
		{query: "a b c d e", search: true, words: []string{"a", "b", "c", "d"}},
	}
	for _, tt := range tests {
		v := reviewerCandidatesVars("o", "r", 1, tt.query)
		if v["query"] != tt.query || v["search"] != tt.search {
			t.Errorf("%q: query %v search %v", tt.query, v["query"], v["search"])
		}
		for i, w := range tt.words {
			q, s := v["q"+string(rune('0'+i))], v["s"+string(rune('0'+i))]
			if q != w || s != (w != "") {
				t.Errorf("%q: q%d = %v, s%d = %v; want %q", tt.query, i, q, i, s, w)
			}
		}
	}
}
