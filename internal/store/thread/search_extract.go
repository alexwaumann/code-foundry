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

// searchText is one kind's entry: whose text it is, and the text. name returns a thread's
// current name for a user message's thread tags ("" or false when unknown).
type searchText struct {
	speaker Speaker
	text    func(it Item, name func(id string) (string, bool)) string
}

// searchTexts is the registry. Add a kind here to index it.
var searchTexts = map[ItemKind]searchText{
	KindUserMessage:   {SpeakerUser, userSearchText},
	KindAssistantText: {SpeakerAssistant, assistantSearchText},
	KindQuestion:      {SpeakerQuestion, questionSearchText},
}

// itemSearchText returns the item's indexed text and speaker; ok is false for a kind
// that is never indexed. The text may be "" (nothing to index).
func itemSearchText(it Item, name func(id string) (string, bool)) (text string, sp Speaker, ok bool) {
	e, ok := searchTexts[it.Kind]
	if !ok {
		return "", "", false
	}
	return e.text(it, name), e.speaker, true
}

// userSearchText is a user message as the timeline shows it (steers included): the
// composer's text with its tags as their chips read (promptText), else the typed text.
// A wake is drawn as a lineage note, not a message: nothing.
func userSearchText(it Item, name func(string) (string, bool)) string {
	if it.Origin == OriginWake {
		return ""
	}
	display, _ := promptText(it.Text, it.ComposerText, name)
	return display
}

// assistantSearchText is a reply's text; Claude Code's API-error text is drawn as an
// error, not a reply: nothing.
func assistantSearchText(it Item, _ func(string) (string, bool)) string {
	if it.APIError {
		return ""
	}
	return strings.TrimSpace(it.Text)
}

// questionSearchText is each question's text followed by its answer once answered, one
// per line.
func questionSearchText(it Item, _ func(string) (string, bool)) string {
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
