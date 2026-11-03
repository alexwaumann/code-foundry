package thread

import (
	"strings"
)

// What thread search indexes (docs/notes/search-3-index.md): the text of an item that
// stays visible when a turn folds. A registry by item kind: a kind without an entry is
// never indexed (tool calls, commands and their output, thinking, permission requests,
// notes, errors, turn ends, compactions, command output, html and theme cards), and an
// entry may still say "" for an item of its kind (a wake, an API error).

// Speaker is who an indexed item's text belongs to.
type Speaker string

// Speakers.
const (
	SpeakerUser      Speaker = "user"
	SpeakerAssistant Speaker = "assistant"
	// SpeakerQuestion: Claude's AskUserQuestion and the user's answers.
	SpeakerQuestion Speaker = "question"
)

// searchText is one kind's entry: whose text it is, and the text.
type searchText struct {
	speaker Speaker
	text    func(it Item) string
}

// searchTexts is the registry. Add a kind here to index it.
var searchTexts = map[ItemKind]searchText{
	KindUserMessage:   {SpeakerUser, userSearchText},
	KindAssistantText: {SpeakerAssistant, assistantSearchText},
	KindQuestion:      {SpeakerQuestion, questionSearchText},
}

// itemSearchText returns the item's indexed text and speaker; ok is false for a kind
// that is never indexed. The text may be "" (nothing to index). It is what the index holds
// and what a query checks, so it must not depend on anything but the item: white space runs
// are one space (searchLine; a phrase across a line break matches), and a thread tag reads
// as its stored label, not the thread's current name (storedLabel).
func itemSearchText(it Item) (text string, sp Speaker, ok bool) {
	raw, sp, ok := itemRawSearchText(it)
	return strings.Join(strings.Fields(raw), " "), sp, ok
}

// itemRawSearchText is itemSearchText before white space runs become one space: line
// breaks kept, so markdown's line markup still reads (renderedQuote).
func itemRawSearchText(it Item) (text string, sp Speaker, ok bool) {
	e, ok := searchTexts[it.Kind]
	if !ok {
		return "", "", false
	}
	return e.text(it), e.speaker, true
}

// storedLabel is promptText's thread name lookup for search: none, so a thread tag reads
// as the label it was sent with (the thread's name then). A rename never changes an
// item's indexed text, so the index and the text check agree.
func storedLabel(string) (string, bool) { return "", false }

// userSearchText is a user message as the timeline shows it (steers included): the
// composer's text with its tags as their chips read (promptText), else the typed text,
// thread tags as their stored label (storedLabel). A wake is drawn as a lineage note, not
// a message: nothing.
func userSearchText(it Item) string {
	if it.Origin == OriginWake {
		return ""
	}
	display, _ := promptText(it.Text, it.ComposerText, storedLabel)
	return display
}

// assistantSearchText is a reply's text; Claude Code's API-error text is drawn as an
// error, not a reply: nothing.
func assistantSearchText(it Item) string {
	if it.APIError {
		return ""
	}
	return strings.TrimSpace(it.Text)
}

// questionSearchText is each question's text followed by its answer once answered, one
// per line.
func questionSearchText(it Item) string {
	if it.Request == nil {
		return ""
	}
	var lines []string
	for _, q := range questionsOf(it.Request.InputJSON) {
		if s := strings.TrimSpace(q.Question); s != "" {
			lines = append(lines, s)
		}
		if a := strings.TrimSpace(it.Request.Answers[q.Question]); a != "" {
			lines = append(lines, a)
		}
	}
	return strings.Join(lines, "\n")
}
