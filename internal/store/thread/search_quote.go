package thread

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Quote verification for agent search (docs/notes/search-5-agent-daemon.md): the hidden
// run reports a message that answers the user's question with a quote from it, and the
// daemon accepts the hit only when the quote occurs in that message's searchable text,
// the text thread search indexes (itemSearchText: the same extractor, white space runs as
// one space), in a thread of the default search scope (the user's threads; their own
// items, not their subagents').

// MinQuoteRunes is the shortest quote VerifyQuote accepts, unless it is the message's
// whole text: a word or two would match almost any message.
const MinQuoteRunes = 12

// MaxQuoteRunes bounds a quote: a hit quotes the part that answers, not the message. The
// run's prompt and search.report's help say the same range.
const MaxQuoteRunes = 300

// QuotedItem is the message a verified quote is from.
type QuotedItem struct {
	Thread    Thread
	ItemID    string
	Ordinal   int64
	Kind      ItemKind
	Speaker   Speaker
	CreatedAt time.Time
	// Quote is the quoted part of the message as it reads: for Claude's reply its
	// rendered markdown (no markers, backticks or link targets; renderedQuote), what the
	// GUI's citation finds in the reply; the text itself for the rest. White space runs
	// are one space.
	Quote string
}

// VerifyQuote checks a reported hit: thread threadID is in the default search scope,
// item (its id, or its ordinal "#12"/"12") is one of the thread's own indexed messages,
// and quote occurs in its searchable text, either as it is, with markdown markers left
// out of both (quoteForm), or, for Claude's reply, in its rendered text, tried first
// (quoteSpan). The quote it returns is the matched part as it reads (renderedQuote), and
// that must read in the message as shown, at least MinQuoteRunes long unless it is the
// whole message: a quote of a link's hidden target matches the source but shows nothing.
// Every refusal is ErrInvalidArgument (ErrNotFound for an unknown thread or item) with
// words a model can act on.
func (m *Manager) VerifyQuote(ctx context.Context, threadID, item, quote string) (QuotedItem, error) {
	q := cleanQuote(quote)
	switch {
	case q == "":
		return QuotedItem{}, fmt.Errorf("%w: a quote is required: copy the words from the message that answer the question", ErrInvalidArgument)
	case utf8.RuneCountInString(q) > MaxQuoteRunes:
		return QuotedItem{}, fmt.Errorf("%w: the quote is %d characters; quote at most %d, the part that answers", ErrInvalidArgument, utf8.RuneCountInString(q), MaxQuoteRunes)
	}
	snap := m.Snapshot()
	t, ok := snap.Thread(threadID)
	if !ok {
		return QuotedItem{}, fmt.Errorf("%w: no thread %q: use a thread id thread search printed", ErrNotFound, threadID)
	}
	scope, err := m.searchScope(snap, SearchQuery{})
	if err != nil {
		return QuotedItem{}, err
	}
	if _, ok := scope[t.ID]; !ok {
		return QuotedItem{}, fmt.Errorf("%w: thread %s is not one of the threads search covers (a hidden child or a plugin's): report a hit from the user's own threads", ErrInvalidArgument, t.ID)
	}
	it, err := m.findItem(ctx, t.ID, item)
	if err != nil {
		return QuotedItem{}, err
	}
	if it.ParentToolUseID != "" {
		return QuotedItem{}, fmt.Errorf("%w: #%d is a subagent's message, which search does not cover: report the thread's own message", ErrInvalidArgument, it.Ordinal)
	}
	raw, sp, indexed := itemRawSearchText(it)
	text := strings.Join(strings.Fields(raw), " ")
	if !indexed || text == "" {
		return QuotedItem{}, fmt.Errorf("%w: #%d is a %s, not a message: quote a user message, Claude's reply or a question", ErrInvalidArgument, it.Ordinal, kindWords(it.Kind))
	}
	src, markdown := []rune(raw), it.Kind == KindAssistantText
	from, to, found := quoteSpan(src, q, markdown)
	if !found {
		return QuotedItem{}, fmt.Errorf("%w: the quote does not occur in #%d of thread %s; copy it exactly from that message (white space may differ). The message begins: %q",
			ErrInvalidArgument, it.Ordinal, t.ID, quoteHead(text))
	}
	if utf8.RuneCountInString(q) < MinQuoteRunes && quoteForm(q) != quoteForm(text) {
		return QuotedItem{}, fmt.Errorf("%w: the quote is too short to show what answers; quote at least %d characters (or the whole message)", ErrInvalidArgument, MinQuoteRunes)
	}
	// Stored as it reads: the matched part of the message, rendered for a reply. A quote
	// that matched only markup (a link's hidden target) reads as little or nothing, or
	// not as one run of the message's words: the model quotes again.
	stored := renderedQuote(src, from, to, markdown)
	reads := text
	if markdown {
		reads = squeeze(renderedText(src)).String()
	}
	switch {
	case stored == "" || !strings.Contains(reads, stored):
		return QuotedItem{}, fmt.Errorf("%w: the quote's words are not what #%d of thread %s shows (a link's target or markup is not shown); quote the words as they read rendered. The message reads: %q",
			ErrInvalidArgument, it.Ordinal, t.ID, quoteHead(reads))
	case utf8.RuneCountInString(stored) < MinQuoteRunes && stored != reads:
		return QuotedItem{}, fmt.Errorf("%w: as #%d of thread %s shows it, the quote reads only %q (a link's target or markup is not shown); quote at least %d characters of the words as they read rendered (or the whole message)",
			ErrInvalidArgument, it.Ordinal, t.ID, stored, MinQuoteRunes)
	}
	return QuotedItem{Thread: t, ItemID: it.ID, Ordinal: it.Ordinal, Kind: it.Kind, Speaker: sp, CreatedAt: it.CreatedAt, Quote: stored}, nil
}

// findItem reads thread id's item by its id, or by its ordinal ("#12" or "12").
func (m *Manager) findItem(ctx context.Context, id, ref string) (Item, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return Item{}, fmt.Errorf("%w: an item is required: the message's #N (or item id) as thread search or thread read printed it", ErrInvalidArgument)
	}
	const cols = `SELECT ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data FROM thread_items WHERE thread_id = ? AND `
	var items []Item
	var err error
	if n, perr := strconv.ParseInt(strings.TrimPrefix(ref, "#"), 10, 64); perr == nil {
		items, err = scanItems(ctx, m.opts.DB, id, cols+`ordinal = ?`, id, n)
	} else {
		items, err = scanItems(ctx, m.opts.DB, id, cols+`item_id = ?`, id, ref)
	}
	if err != nil {
		if errors.Is(err, errBadItem) {
			return Item{}, fmt.Errorf("%w: %s of thread %s cannot be read", ErrInvalidArgument, ref, id)
		}
		return Item{}, err
	}
	if len(items) == 0 {
		return Item{}, fmt.Errorf("%w: thread %s has no message %s: use the #N thread search or thread read printed", ErrNotFound, id, ref)
	}
	return items[0], nil
}

// kindWords names an item kind for a refusal.
func kindWords(k ItemKind) string {
	switch k {
	case KindUserMessage:
		return "wake (a note, not the user's words)"
	case KindAssistantText:
		return "API error"
	case "":
		return "item"
	}
	return strings.ReplaceAll(string(k), "_", " ")
}

// quoteTrim is what cleanQuote takes off a quote's ends: quote marks and ellipses a
// model writes around an excerpt.
const quoteTrim = "\"'“”‘’«»`"

// cleanQuote is a quote on one line (white space runs as one space), without the quote
// marks or ellipses around it.
func cleanQuote(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	for prev := ""; prev != s; {
		prev = s
		s = strings.TrimSpace(s)
		s = strings.TrimPrefix(strings.TrimSuffix(s, "..."), "...")
		s = strings.TrimPrefix(strings.TrimSuffix(s, "…"), "…")
		if len(s) >= 2 && strings.ContainsRune(quoteTrim, []rune(s)[0]) && strings.ContainsRune(quoteTrim, lastRune(s)) {
			r := []rune(s)
			s = string(r[1 : len(r)-1])
		}
	}
	return s
}

func lastRune(s string) rune {
	r, _ := utf8.DecodeLastRuneInString(s)
	return r
}

// quoteForm is s as a model may quote rendered markdown: links ([text](target), no ] in
// the text, no ) in the target) as their text, without the markers * _ ` # > and white
// space runs as one space (formMapped). Applied to both the quote and the text, so a quote
// with the markers matches too.
func quoteForm(s string) string { return formMapped(identity([]rune(s))).String() }

// quoteHead is the start of a message's text for a refusal, so the model sees what the
// message says.
func quoteHead(text string) string {
	const n = 200
	if r := []rune(text); len(r) > n {
		return string(r[:n]) + "…"
	}
	return text
}
