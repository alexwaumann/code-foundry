package thread

import (
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The registry: what each kind indexes, and what is never indexed.
func TestItemSearchText(t *testing.T) {
	names := func(id string) (string, bool) {
		if id == "s-1" {
			return "Fix race", true
		}
		return "", false
	}
	questions := `{"questions":[{"question":"Which database?","header":"DB","options":[{"label":"SQLite"},{"label":"Postgres"}]},` +
		`{"question":"Run migrations?","options":[{"label":"Yes"}]}]}`
	tests := []struct {
		name   string
		it     Item
		want   string
		wantSp Speaker
		wantOK bool
	}{
		{"a user message as typed", Item{Kind: KindUserMessage, Text: "  fix the login redirect \n"}, "fix the login redirect", SpeakerUser, true},
		{"a user message's tags as their chips read", Item{Kind: KindUserMessage, Text: "x",
			ComposerText: "see [a.ts](cf-file://r-1/src/a.ts) and [old](cf-thread://s-1) ![p.png](cf-attachment://0)"},
			"see src/a.ts and Fix race", SpeakerUser, true},
		{"a steer is a user message", Item{Kind: KindUserMessage, Text: "also the tests", Queued: true}, "also the tests", SpeakerUser, true},
		{"a message another thread sent", Item{Kind: KindUserMessage, Text: "do the docs", SentBy: "s-lead"}, "do the docs", SpeakerUser, true},
		{"a wake is a note, not a message", Item{Kind: KindUserMessage, Text: "[wake] ...", Origin: OriginWake, WakeTitle: "Woken"}, "", SpeakerUser, true},
		{"assistant text", Item{Kind: KindAssistantText, Text: "Done: `auth.go` now redirects."}, "Done: `auth.go` now redirects.", SpeakerAssistant, true},
		{"an API error is not a reply", Item{Kind: KindAssistantText, Text: "Invalid API key", APIError: true}, "", SpeakerAssistant, true},
		{"a question and its answers", Item{Kind: KindQuestion, Request: &Request{InputJSON: questions, State: RequestAllowed,
			Answers: map[string]string{"Which database?": "SQLite", "Run migrations?": "Yes"}}},
			"Which database?\nSQLite\nRun migrations?\nYes", SpeakerQuestion, true},
		{"an unanswered question", Item{Kind: KindQuestion, Request: &Request{InputJSON: questions, State: RequestPending}},
			"Which database?\nRun migrations?", SpeakerQuestion, true},
		{"a question without a request", Item{Kind: KindQuestion}, "", SpeakerQuestion, true},
		{"tool calls are not indexed", Item{Kind: KindToolCall, Tool: &ToolCall{Name: "Bash", InputJSON: `{"command":"grep login"}`, Output: "login"}}, "", "", false},
		{"thinking is not indexed", Item{Kind: KindThinking, Text: "login"}, "", "", false},
		{"permission requests are not indexed", Item{Kind: KindPermission, Request: &Request{ToolName: "Bash", Description: "login"}}, "", "", false},
		{"notes are not indexed", Item{Kind: KindNote, Text: "Forked from login"}, "", "", false},
		{"command output is not indexed", Item{Kind: KindCommandOutput, Text: "login"}, "", "", false},
		{"errors are not indexed", Item{Kind: KindError, Text: "login"}, "", "", false},
		{"compactions are not indexed", Item{Kind: KindCompaction, Text: "login"}, "", "", false},
		{"turn ends are not indexed", Item{Kind: KindTurnEnd, Turn: &TurnEnd{}}, "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, sp, ok := itemSearchText(tt.it, names)
			if got != tt.want || sp != tt.wantSp || ok != tt.wantOK {
				t.Errorf("itemSearchText = %q, %q, %v; want %q, %q, %v", got, sp, ok, tt.want, tt.wantSp, tt.wantOK)
			}
		})
	}
}

func TestParseSearch(t *testing.T) {
	tests := []struct {
		q         string
		terms     []string
		cs, short bool
		fts       string
	}{
		{"login", []string{"login"}, false, false, `"login"`},
		{"  login   redirect ", []string{"login", "redirect"}, false, false, `"login" AND "redirect"`},
		{`"login redirect" auth.go`, []string{"login redirect", "auth.go"}, false, false, `"login redirect" AND "auth.go"`},
		{`"unclosed  phrase`, []string{"unclosed phrase"}, false, false, `"unclosed phrase"`},
		{"Login", []string{"Login"}, true, false, `"Login"`},
		{"login login", []string{"login"}, false, false, `"login"`},
		{"ui fix", []string{"ui", "fix"}, false, true, `"fix"`},
		{"ui go", []string{"ui", "go"}, false, true, ""},
		{"école", []string{"école"}, false, false, `"école"`},
		{`say"hi"`, []string{"say", "hi"}, false, true, `"say"`},
		{"   ", nil, false, false, ""},
	}
	for _, tt := range tests {
		got := parseSearch(tt.q)
		if !slices.Equal(got.terms, tt.terms) || got.caseSensitive != tt.cs || got.short != tt.short || got.fts != tt.fts {
			t.Errorf("parseSearch(%q) = terms %q cs %v short %v fts %q; want %q %v %v %q", tt.q, got.terms, got.caseSensitive,
				got.short, got.fts, tt.terms, tt.cs, tt.short, tt.fts)
		}
	}
}

func TestSearchMatchText(t *testing.T) {
	tests := []struct {
		name, q, text string
		want          []MatchRange
	}{
		{"case-insensitive without a capital", "login", "Fix the Login and login", []MatchRange{{8, 13}, {18, 23}}},
		{"exact with a capital", "Login", "Fix the Login and login", []MatchRange{{8, 13}}},
		{"a capital that is not there", "LOGIN", "Fix the Login", nil},
		{"every term must occur", "login zebra", "the login page", nil},
		{"terms in any order, ranges sorted", "page login", "the login page", []MatchRange{{4, 9}, {10, 14}}},
		{"overlapping matches merge", "abc bcd", "xabcdx", []MatchRange{{1, 5}}},
		{"short terms match too, inside words as well", "ui", "the UI build", []MatchRange{{4, 6}, {8, 10}}},
		{"ranges count code points", "café", "un café noir", []MatchRange{{3, 7}}},
		{"unicode case folds", "école", "ÉCOLE normale", []MatchRange{{0, 5}}},
		{"white space runs are one space", `"login page"`, "the login\n\n  page", []MatchRange{{4, 14}}},
		{"no terms match nothing", "", "anything", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseSearch(tt.q).matchText(tt.text); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("matchText = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSnippetOf(t *testing.T) {
	long := strings.Repeat("alpha beta gamma ", 20) // 340 characters
	tests := []struct {
		name, q, text, want string
		ranges              []MatchRange
	}{
		{"a short text whole, on one line", "beta", "alpha\nbeta  gamma", "alpha beta gamma", []MatchRange{{6, 10}}},
		{"no match", "zeta", "alpha beta", "", nil},
		{"a match at the start: cut at the end, at a word", "needle", "needle " + long,
			"needle " + strings.Repeat("alpha beta gamma ", 8) + "alpha beta gamma…", []MatchRange{{0, 6}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ranges := snippetOf(parseSearch(tt.q), tt.text)
			if got != tt.want || !reflect.DeepEqual(ranges, tt.ranges) {
				t.Errorf("snippetOf = %q %v, want %q %v", got, ranges, tt.want, tt.ranges)
			}
		})
	}

	// A match deep in a long text: both ends cut at words, the match inside, ranges on
	// the snippet's code points (the leading ellipsis counts one).
	text := long + "the needle is here " + long
	got, ranges := snippetOf(parseSearch("needle"), text)
	r := []rune(got)
	if !strings.HasPrefix(got, "…") || !strings.HasSuffix(got, "…") || len(r) > snippetLen+2 {
		t.Fatalf("snippet %q (%d code points): want both ends cut, at most %d", got, len(r), snippetLen+2)
	}
	if len(ranges) != 1 || string(r[ranges[0].Start:ranges[0].End]) != "needle" {
		t.Fatalf("ranges %v in %q: want the needle", ranges, got)
	}
	if ranges[0].Start > snippetBefore+2 {
		t.Errorf("the match starts at %d; want at most %d characters before it", ranges[0].Start, snippetBefore)
	}
	if strings.HasPrefix(got, "…lpha") || strings.HasPrefix(got, "…eta") || strings.HasPrefix(got, "…amma") {
		t.Errorf("snippet %q starts mid-word", got)
	}
}

func TestSearchTier(t *testing.T) {
	tests := []struct {
		q, text string
		want    int
	}{
		{"login", "the login page", tierWord},
		{"login", "login.go", tierWord},
		{"login", "logins", tierPrefix},
		{"login", "relogin", tierInside},
		{"login", "relogin, then login", tierWord},
		{"login", "logins and relogin", tierPrefix},
		{"login page", "the login pages", tierPrefix},
		{"login page", "the login homepage", tierInside},
		{"Login", "login Logins", tierPrefix},
		{"items_db", "see items_db.go", tierWord},
		{".go", "items_db.go", tierWord},
		{"user_", "user_message", tierPrefix},
	}
	for _, tt := range tests {
		q := parseSearch(tt.q)
		if got := q.tier(searchLine(tt.text)); got != tt.want {
			t.Errorf("tier(%q in %q) = %d, want %d", tt.q, tt.text, got, tt.want)
		}
	}
}
