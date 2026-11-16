package notification

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Caps, in characters (runes).
const (
	MaxSource     = 64
	MaxKey        = 200
	MaxTitle      = 120
	MaxBody       = 1000
	MaxActions    = 3
	MaxLabel      = 32
	MaxText       = 10000 // a send's text and a start's prompt
	MaxURL        = 2048
	MaxCommand    = 100
	MaxArgs       = 16
	MaxArgName    = 64
	MaxArgValue   = 1000
	MaxProjectRef = 200
)

// MaxActivePerSource bounds a source's active notifications (shown, snoozed and
// scheduled): a post of a new key past it is refused with ErrFull.
const MaxActivePerSource = 100

// derivedKeyPrefix starts every key the store derives, so it never meets a source's own.
const derivedKeyPrefix = "auto:"

// sourcePattern is a plugin's name or SourceCommand.
var sourcePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// commandPattern is a plugin's manifest command name: dotted lowercase segments.
var commandPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$`)

// argNamePattern is a command arg's name.
var argNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// invalid wraps ErrInvalidArgument.
func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidArgument, fmt.Sprintf(format, a...))
}

// oneLine trims s and refuses it when it is longer than max characters or holds a line
// break or another control character. name names it in the error.
func oneLine(name, s string, max int) (string, error) {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) {
		return "", invalid("%s is not valid UTF-8", name)
	}
	if n := utf8.RuneCountInString(s); n > max {
		return "", invalid("%s is %d characters; at most %d", name, n, max)
	}
	if strings.ContainsFunc(s, isControl) {
		return "", invalid("%s must be one line", name)
	}
	return s, nil
}

// text trims s and refuses it when it is longer than max characters or holds a control
// character other than a line break or a tab.
func text(name, s string, max int) (string, error) {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
	if !utf8.ValidString(s) {
		return "", invalid("%s is not valid UTF-8", name)
	}
	if n := utf8.RuneCountInString(s); n > max {
		return "", invalid("%s is %d characters; at most %d", name, n, max)
	}
	if strings.ContainsFunc(s, func(r rune) bool { return r != '\n' && r != '\t' && isControl(r) }) {
		return "", invalid("%s holds a control character", name)
	}
	return s, nil
}

func isControl(r rune) bool { return r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) }

// normalize checks p and returns the notification fields it asks for (no id, state or
// times), its key derived when it has none. threadExists, when set, must know p's thread
// and every send action's.
func normalize(p Post, threadExists func(string) bool) (Notification, error) {
	var n Notification
	var err error
	if n.Source, err = oneLine("source", p.Source, MaxSource); err != nil {
		return n, err
	}
	if n.Source == "" || !sourcePattern.MatchString(n.Source) {
		return n, invalid("source %q must be a plugin's name or %q", p.Source, SourceCommand)
	}
	switch p.Level {
	case "":
		n.Level = LevelInfo
	case LevelInfo, LevelWarning, LevelError:
		n.Level = p.Level
	default:
		return n, invalid("level %q is not one of info, warning, error", p.Level)
	}
	n.TimeSensitive = p.TimeSensitive
	if n.Title, err = oneLine("title", p.Title, MaxTitle); err != nil {
		return n, err
	}
	if n.Title == "" {
		return n, invalid("a notification needs a title")
	}
	if n.Body, err = text("body", p.Body, MaxBody); err != nil {
		return n, err
	}
	n.ThreadID = strings.TrimSpace(p.ThreadID)
	if n.ThreadID != "" && threadExists != nil && !threadExists(n.ThreadID) {
		return n, fmt.Errorf("%w: thread %s", ErrNotFound, n.ThreadID)
	}
	if len(p.Actions) > MaxActions {
		return n, invalid("%d actions; at most %d", len(p.Actions), MaxActions)
	}
	for i, spec := range p.Actions {
		a, err := normalizeAction(n.Source, spec, threadExists)
		if err != nil {
			return n, fmt.Errorf("action %d: %w", i+1, err)
		}
		n.Actions = append(n.Actions, a)
	}
	if !p.ShowAt.IsZero() {
		n.ShowAt = p.ShowAt.Round(0).Truncate(time.Millisecond)
	}
	if n.Key, err = oneLine("key", p.Key, MaxKey); err != nil {
		return n, err
	}
	switch {
	case n.Key == "":
		n.Key = DerivedKey(n.Title, n.Body, n.ThreadID)
	case strings.HasPrefix(n.Key, derivedKeyPrefix):
		return n, invalid("key %q: keys starting with %q are the host's", n.Key, derivedKeyPrefix)
	}
	return n, nil
}

// normalizeAction checks one action of source's and fills its Resolves default.
func normalizeAction(source string, spec ActionSpec, threadExists func(string) bool) (Action, error) {
	a := Action{Kind: spec.Kind}
	var err error
	if a.Label, err = oneLine("label", spec.Label, MaxLabel); err != nil {
		return a, err
	}
	if a.Label == "" {
		return a, invalid("an action needs a label")
	}
	switch a.Kind {
	case KindCommand:
		if source == SourceCommand {
			return a, invalid("a command action runs one of a plugin's commands; only a plugin can post one")
		}
		a.Command = strings.TrimSpace(spec.Command)
		if a.Command == "" || len(a.Command) > MaxCommand || !commandPattern.MatchString(a.Command) {
			return a, invalid("command %q is not one of a plugin's command names", spec.Command)
		}
		if len(spec.Args) > MaxArgs {
			return a, invalid("%d args; at most %d", len(spec.Args), MaxArgs)
		}
		for _, k := range slices.Sorted(maps.Keys(spec.Args)) {
			v := spec.Args[k]
			if len(k) > MaxArgName || !argNamePattern.MatchString(k) {
				return a, invalid("arg name %q", k)
			}
			if v, err = text("arg "+k, v, MaxArgValue); err != nil {
				return a, err
			}
			if a.Args == nil {
				a.Args = map[string]string{}
			}
			a.Args[k] = v
		}
	case KindSend:
		a.ThreadID = strings.TrimSpace(spec.ThreadID)
		if a.ThreadID == "" {
			return a, invalid("a send action needs a thread")
		}
		if threadExists != nil && !threadExists(a.ThreadID) {
			return a, fmt.Errorf("%w: thread %s", ErrNotFound, a.ThreadID)
		}
		if a.Text, err = text("text", spec.Text, MaxText); err != nil {
			return a, err
		}
		if a.Text == "" {
			return a, invalid("a send action needs text")
		}
	case KindStart:
		if a.Prompt, err = text("prompt", spec.Prompt, MaxText); err != nil {
			return a, err
		}
		if a.Prompt == "" {
			return a, invalid("a start action needs a prompt")
		}
		if a.ProjectID, err = oneLine("project", spec.ProjectID, MaxProjectRef); err != nil {
			return a, err
		}
	case KindOpen:
		a.URL = strings.TrimSpace(spec.URL)
		u, err := url.Parse(a.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || len(a.URL) > MaxURL {
			return a, invalid("url %q must be an http or https URL of at most %d bytes", spec.URL, MaxURL)
		}
	default:
		return a, invalid("action kind %q is not one of command, send, start, open", spec.Kind)
	}
	a.Resolves = a.Kind != KindOpen
	if spec.Resolves != nil {
		a.Resolves = *spec.Resolves
	}
	return a, nil
}

// DerivedKey is the key of a notification posted without one: its title, body and
// thread, so a re-post saying the same thing is the same notification, and one with
// another level or other actions updates it.
func DerivedKey(title, body, threadID string) string {
	h := sha256.Sum256([]byte(title + "\x00" + body + "\x00" + threadID))
	return derivedKeyPrefix + hex.EncodeToString(h[:8])
}

// content is what a re-post of a key is compared on: everything the source says.
type content struct {
	Level         Level     `json:"level"`
	TimeSensitive bool      `json:"time_sensitive"`
	Title         string    `json:"title"`
	Body          string    `json:"body"`
	ThreadID      string    `json:"thread_id"`
	Actions       []Action  `json:"actions"`
	ShowAt        time.Time `json:"show_at"`
}

// sameContent reports whether a and b say the same thing (level, time-sensitive, title,
// body, thread, actions and show_at).
func sameContent(a, b Notification) bool {
	return fingerprint(a) == fingerprint(b)
}

func fingerprint(n Notification) string {
	c := content{Level: n.Level, TimeSensitive: n.TimeSensitive, Title: n.Title, Body: n.Body, ThreadID: n.ThreadID,
		Actions: n.Actions, ShowAt: n.ShowAt.UTC()}
	if c.Actions == nil {
		c.Actions = []Action{}
	}
	b, _ := json.Marshal(c) // map keys marshal sorted
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
