package thread

import (
	"errors"
	"strconv"
	"strings"
	"testing"
)

// VerifyQuote: the quote must occur in the message's searchable text (white space and
// markdown markers aside), the message must be the thread's own indexed one, and the
// thread in the default search scope.
func TestVerifyQuote(t *testing.T) {
	e := newEnv(t)
	top := e.connected(CreateOptions{Name: "Top"})
	child := e.connected(CreateOptions{Name: "Child", CreatedBy: top.ID})
	owned := e.connected(CreateOptions{Name: "Owned", Owner: "plugin:demo"})
	e.putItems(top.ID,
		Item{ID: "md", Kind: KindAssistantText, Text: "We decided:\n\n**Do not refetch** on CI reruns; see [the note](https://x/y).\n\n`poll.go` keeps the `etag`."},
		Item{ID: "ident", Kind: KindAssistantText, Text: "## Storage\n\n- The `thread_items` table keeps *each* item; see [search_quote.go](https://x/a_b.go).\n- snake_case_names stay as they are."},
		Item{ID: "raw-user", Kind: KindUserMessage, Text: "please keep **bold** and `ticks` as typed"},
		Item{ID: "user", Kind: KindUserMessage, Text: "should the   poller\nrefetch on reruns?"},
		Item{ID: "short", Kind: KindUserMessage, Text: "yes"},
		Item{ID: "tool", Kind: KindToolCall, Tool: &ToolCall{Name: "Bash", InputJSON: `{"command":"echo Do not refetch"}`, Status: ToolDone, Output: "Do not refetch"}},
		Item{ID: "sub", Kind: KindAssistantText, Text: "a subagent says do not refetch", ParentToolUseID: "toolu_1"},
		Item{ID: "wake", Kind: KindUserMessage, Text: "a wake about refetching", Origin: OriginWake},
		Item{ID: "pr", Kind: KindAssistantText, Text: "Merged in [PR](https://github.com/alexwaumann/code-foundry/pull/503) yesterday, after review."},
		Item{ID: "chip", Kind: KindAssistantText, Text: "The loop lives in [run.go](internal/store/search/run.go) for now; the key is <kbd>check_count</kbd> &amp; the SHA."},
		Item{ID: "ok", Kind: KindAssistantText, Text: "**OK.**"},
	)
	e.putItems(child.ID, Item{ID: "child-u", Kind: KindUserMessage, Text: "the child says do not refetch"})
	e.putItems(owned.ID, Item{ID: "owned-u", Kind: KindUserMessage, Text: "the plugin says do not refetch"})
	var userOrdinal int64
	if err := e.m.opts.DB.QueryRowContext(e.ctx(), `SELECT ordinal FROM thread_items WHERE thread_id = ? AND item_id = 'user'`, top.ID).Scan(&userOrdinal); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, thread, item, quote string
		want                      error
		words                     string
		quoted                    string
	}{
		// Stored as the reply reads rendered, whichever form the quote came in.
		{name: "exact raw markdown", thread: top.ID, item: "md", quote: "**Do not refetch** on CI reruns", quoted: "Do not refetch on CI reruns"},
		{name: "raw link", thread: top.ID, item: "md", quote: "reruns; see [the note](https://x/y).", quoted: "reruns; see the note."},
		{name: "half a bold", thread: top.ID, item: "md", quote: "refetch** on CI reruns", quoted: "refetch on CI reruns"},
		{name: "identifier in code, rendered", thread: top.ID, item: "ident", quote: "The thread_items table keeps each item", quoted: "The thread_items table keeps each item"},
		{name: "identifier in code, raw", thread: top.ID, item: "ident", quote: "The `thread_items` table keeps *each* item", quoted: "The thread_items table keeps each item"},
		{name: "identifier without its underscore", thread: top.ID, item: "ident", quote: "The threaditems table keeps each item", quoted: "The thread_items table keeps each item"},
		{name: "link text with underscores", thread: top.ID, item: "ident", quote: "each item; see search_quote.go.", quoted: "each item; see search_quote.go."},
		{name: "across list items and a heading", thread: top.ID, item: "ident", quote: "Storage The thread_items table", quoted: "Storage The thread_items table"},
		{name: "snake case in prose", thread: top.ID, item: "ident", quote: "snake_case_names stay as they are", quoted: "snake_case_names stay as they are"},
		{name: "a user's text as typed", thread: top.ID, item: "raw-user", quote: "keep bold and ticks as typed", quoted: "keep **bold** and `ticks` as typed"},
		{name: "rendered markdown", thread: top.ID, item: "md", quote: "Do not refetch on CI reruns; see the note.", quoted: "Do not refetch on CI reruns; see the note."},
		{name: "inline code without backticks", thread: top.ID, item: "md", quote: "poll.go keeps the etag", quoted: "poll.go keeps the etag"},
		{name: "white space and line breaks", thread: top.ID, item: "user", quote: "should the poller refetch\n on reruns", quoted: "should the poller refetch on reruns"},
		{name: "by ordinal", thread: top.ID, item: "#" + strconv.FormatInt(userOrdinal, 10), quote: "poller refetch on reruns"},
		{name: "bare ordinal", thread: top.ID, item: strconv.FormatInt(userOrdinal, 10), quote: "poller refetch on reruns"},
		{name: "quote marks and ellipses", thread: top.ID, item: "user", quote: `"…the poller refetch on reruns..."`, quoted: "the poller refetch on reruns"},
		{name: "whole short message", thread: top.ID, item: "short", quote: "yes", quoted: "yes"},
		{name: "too short", thread: top.ID, item: "user", quote: "poller", want: ErrInvalidArgument, words: "too short"},
		{name: "wrong words", thread: top.ID, item: "md", quote: "We decided to refetch always", want: ErrInvalidArgument, words: "does not occur in #"},
		{name: "case differs", thread: top.ID, item: "md", quote: "do not refetch on ci reruns", want: ErrInvalidArgument, words: "does not occur"},
		{name: "wrong item", thread: top.ID, item: "user", quote: "Do not refetch on CI reruns", want: ErrInvalidArgument, words: "The message begins: \"should the poller refetch on reruns?\""},
		{name: "unknown item", thread: top.ID, item: "nope", quote: "Do not refetch on CI reruns", want: ErrNotFound, words: "has no message nope"},
		{name: "tool call", thread: top.ID, item: "tool", quote: "Do not refetch", want: ErrInvalidArgument, words: "is a tool call, not a message"},
		{name: "subagent's", thread: top.ID, item: "sub", quote: "a subagent says do not refetch", want: ErrInvalidArgument, words: "subagent"},
		{name: "wake", thread: top.ID, item: "wake", quote: "a wake about refetching", want: ErrInvalidArgument, words: "not a message"},
		{name: "hidden child", thread: child.ID, item: "child-u", quote: "the child says do not refetch", want: ErrInvalidArgument, words: "not one of the threads search covers"},
		{name: "plugin's thread", thread: owned.ID, item: "owned-u", quote: "the plugin says do not refetch", want: ErrInvalidArgument, words: "not one of the threads"},
		{name: "unknown thread", thread: "s-nope", item: "md", quote: "Do not refetch on CI reruns", want: ErrNotFound, words: "no thread"},
		{name: "no quote", thread: top.ID, item: "md", quote: " \"\" ", want: ErrInvalidArgument, words: "a quote is required"},
		{name: "no item", thread: top.ID, item: "", quote: "Do not refetch on CI reruns", want: ErrInvalidArgument, words: "an item is required"},
		// Only the shown words: a quote of a link's hidden target matches the source but
		// reads as nothing, or as too little, in the reply as shown.
		{name: "a link's target alone", thread: top.ID, item: "pr", quote: "github.com/alexwaumann/code-foundry/pull/503", want: ErrInvalidArgument,
			words: `not what #`},
		{name: "a link's text and part of its target", thread: top.ID, item: "pr", quote: "[PR](https://github.com/alexwaumann", want: ErrInvalidArgument,
			words: `reads only "PR"`},
		{name: "a whole raw link and more", thread: top.ID, item: "pr", quote: "in [PR](https://github.com/alexwaumann/code-foundry/pull/503) yesterday, after", quoted: "in PR yesterday, after"},
		{name: "the reply as shown", thread: top.ID, item: "pr", quote: "Merged in PR yesterday", quoted: "Merged in PR yesterday"},
		{name: "a path chip as shown", thread: top.ID, item: "chip", quote: "The loop lives in internal/store/search/run.go for now", quoted: "The loop lives in internal/store/search/run.go for now"},
		{name: "a path chip by its link text", thread: top.ID, item: "chip", quote: "loop lives in run.go for now", quoted: "loop lives in internal/store/search/run.go for now"},
		{name: "ending at a path chip's link text", thread: top.ID, item: "chip", quote: "The loop lives in run.go", quoted: "The loop lives in internal/store/search/run.go"},
		{name: "a path chip's part", thread: top.ID, item: "chip", quote: "lives in internal/store", quoted: "lives in internal/store/search/run.go"},
		{name: "html and entities as shown", thread: top.ID, item: "chip", quote: "the key is check_count & the SHA", quoted: "the key is check_count & the SHA"},
		// A refusal shows the reply as it reads, the words to copy.
		{name: "a refused reply shows its rendered text", thread: top.ID, item: "chip", quote: "lives in run.go and the key is check_count & the SHA", want: ErrInvalidArgument,
			words: `The message begins: "The loop lives in internal/store/search/run.go for now; the key is check_count & the SHA."`},
		{name: "a whole short reply", thread: top.ID, item: "ok", quote: "OK.", quoted: "OK."},
		{name: "too long", thread: top.ID, item: "md", quote: strings.Repeat("x", MaxQuoteRunes+1), want: ErrInvalidArgument, words: "at most"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			q, err := e.m.VerifyQuote(e.ctx(), tt.thread, tt.item, tt.quote)
			if tt.want != nil {
				if !errors.Is(err, tt.want) || !strings.Contains(err.Error(), tt.words) {
					t.Fatalf("err = %v, want %v with %q", err, tt.want, tt.words)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if q.Thread.ID != tt.thread || q.ItemID == "" || q.Ordinal == 0 || q.Speaker == "" {
				t.Errorf("quoted = %+v", q)
			}
			if tt.quoted != "" && q.Quote != tt.quoted {
				t.Errorf("quote = %q, want %q", q.Quote, tt.quoted)
			}
		})
	}
}

// A promoted search: Create with ResumeSession continues that session under a new id,
// as a fresh conversation for the app memory; it refuses a project and a missing
// transcript.
func TestCreateResumeSession(t *testing.T) {
	e := newEnv(t)
	const sid = "0a1b2c3d-0000-4000-8000-000000000001"
	if _, err := e.m.Create(e.ctx(), CreateOptions{NoProject: true, ResumeSession: sid}); !errors.Is(err, ErrTranscriptMissing) {
		t.Errorf("missing transcript = %v", err)
	}
	if _, err := e.m.Create(e.ctx(), CreateOptions{ResumeSession: sid}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("with a project = %v", err)
	}
	if _, err := e.m.Create(e.ctx(), CreateOptions{NoProject: true, ResumeSession: "--help"}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("a bad id = %v", err)
	}
	// The search ran elsewhere: Claude finds a session by id in any project dir.
	e.writeTranscriptIn(t.TempDir(), sid, userLine("where is it?"))
	s := e.connected(CreateOptions{NoProject: true, ResumeSession: sid, InitialPrompt: "where is it?\n\nresults"})
	argv := e.spec(s.ID).Argv
	if argOf(argv, "--resume") != sid || !strings.Contains(strings.Join(argv, " "), "--fork-session") {
		t.Errorf("argv = %q", argv)
	}
	if cid := argOf(argv, "--session-id"); cid == "" || cid == sid {
		t.Errorf("session id = %q", cid)
	}
	if s.ProjectID != "" || s.WorkspaceID != "" || s.Owner != "" || s.CreatedBy != "" {
		t.Errorf("thread = %+v", s)
	}
}

func TestMemorySpawnedFreshPrompt(t *testing.T) {
	mem := []string{"likes tabs"}
	if sm := memorySpawned(launch{resume: "x", fork: true, freshPrompt: true}, "", mem, true); !sm.fresh || sm.note != "" {
		t.Errorf("fresh prompt resume = %+v", sm)
	}
	if sm := memorySpawned(launch{resume: "x"}, "", mem, true); sm.fresh || sm.note == "" {
		t.Errorf("plain resume = %+v", sm)
	}
}
