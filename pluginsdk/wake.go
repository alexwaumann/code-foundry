package pluginsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Wake sources (docs/notes/plugins-wake-sources.md). A plugin declares the events an
// agent may wait for in its manifest (Manifest.Wakes); an agent subscribes its thread
// with `code-foundry thread subscribe --plugin <plugin>/<source> [--arg k=v …]`; the host
// tells the plugin (wake/subscribed, again for every live subscription after each
// start with rearm set, then wake/armed, so a restarted plugin re-arms and drops what
// ended while it was down) and the plugin fires the source
// (Host.FireWake) when the event happens. The host delivers a wake message into every
// subscribed thread whose args the fire's match covers. No permission is needed: a
// wake goes only to threads that asked for it.

// Wake scopes: what one subscription of a source is about. Descriptive (plugin wakes
// lists it); the args say which thread, pull request or project.
const (
	WakeScopeGlobal  = "global"
	WakeScopeThread  = "thread"
	WakeScopePR      = "pr"
	WakeScopeProject = "project"
)

// Wake arg contexts: an arg with one defaults to the subscribing thread's id, its pull
// request ("owner/name#123": its branch's, else the first it linked) or its project's
// id when the subscriber does not give it.
const (
	WakeContextThread  = "thread"
	WakeContextPR      = "pr"
	WakeContextProject = "project"
)

// ArgDuration is a wake arg type: a Go duration ("10s", "1m30s"), more than zero.
const ArgDuration = "duration"

// Wake limits.
const (
	MaxWakes      = 50
	MaxWakeArgs   = 16
	MaxWakeArgLen = 512 // bytes of one subscription arg value
	// MaxWakePayload bounds a fire's payload (its JSON), MaxWakeTitle its title (runes).
	MaxWakePayload = 8 << 10
	MaxWakeTitle   = 200
)

// WakeSpec declares one wake source.
type WakeSpec struct {
	// Name is [a-z0-9-]{1,64}: the subscription's target is "<plugin>/<name>".
	Name  string `json:"name"`
	Title string `json:"title"`
	// Description says when it fires and what the payload carries.
	Description string        `json:"description,omitempty"`
	Args        []WakeArgSpec `json:"args,omitempty"`
	// Scope is WakeScopeGlobal (default), WakeScopeThread, WakeScopePR or
	// WakeScopeProject.
	Scope string `json:"scope,omitempty"`
}

// WakeArgSpec declares one argument of a wake source. A subscription keeps its args (as
// strings); a fire matches the subscriptions whose args it all repeats.
type WakeArgSpec struct {
	// Name is kebab-case.
	Name string `json:"name"`
	// Type is ArgString (default), ArgInt, ArgBool, ArgEnum or ArgDuration.
	Type        string   `json:"type,omitempty"`
	Description string   `json:"description,omitempty"`
	Required    bool     `json:"required,omitempty"`
	Enum        []string `json:"enum,omitempty"`
	// Default is kept when the subscriber gives no value (and the context has none).
	Default string `json:"default,omitempty"`
	// Context is WakeContextThread, WakeContextPR or WakeContextProject (string args
	// only): the value defaults to the subscribing thread's.
	Context string `json:"context,omitempty"`
}

var wakeNamePattern = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// validateWakes checks Manifest.Wakes; bad reports each problem.
func validateWakes(wakes []WakeSpec, bad func(field, format string, a ...any)) {
	if len(wakes) > MaxWakes {
		bad("wakes", "more than %d", MaxWakes)
	}
	names := map[string]bool{}
	for i, w := range wakes {
		f := fmt.Sprintf("wakes[%d]", i)
		switch {
		case !wakeNamePattern.MatchString(w.Name):
			bad(f+".name", "%q must match %s", w.Name, wakeNamePattern)
		case names[w.Name]:
			bad(f+".name", "%q declared twice", w.Name)
		}
		names[w.Name] = true
		if w.Title == "" || utf8.RuneCountInString(w.Title) > MaxTitle {
			bad(f+".title", "required, at most %d characters", MaxTitle)
		}
		if utf8.RuneCountInString(w.Description) > MaxDescription {
			bad(f+".description", "longer than %d characters", MaxDescription)
		}
		if w.Scope != "" && !slices.Contains([]string{WakeScopeGlobal, WakeScopeThread, WakeScopePR, WakeScopeProject}, w.Scope) {
			bad(f+".scope", "unknown scope %q (global, thread, pr or project)", w.Scope)
		}
		if len(w.Args) > MaxWakeArgs {
			bad(f+".args", "more than %d", MaxWakeArgs)
		}
		args := map[string]bool{}
		for j, a := range w.Args {
			af := fmt.Sprintf("%s.args[%d]", f, j)
			if err := a.validate(); err != nil {
				bad(af, "%v", err)
			}
			if args[a.Name] {
				bad(af+".name", "%q declared twice", a.Name)
			}
			args[a.Name] = true
		}
	}
}

func (a WakeArgSpec) validate() error {
	t := a.TypeOr()
	switch {
	case !segmentPattern.MatchString(a.Name):
		return fmt.Errorf("name %q must be kebab-case", a.Name)
	case !slices.Contains([]string{ArgString, ArgInt, ArgBool, ArgEnum, ArgDuration}, t):
		return fmt.Errorf("unknown type %q (string, int, bool, enum or duration)", a.Type)
	case t == ArgEnum && len(a.Enum) == 0:
		return errors.New("an enum arg needs values")
	case t != ArgEnum && len(a.Enum) > 0:
		return errors.New("enum values on a non-enum arg")
	case a.Required && a.Default != "":
		return errors.New("a required arg cannot have a default")
	case a.Context != "" && !slices.Contains([]string{WakeContextThread, WakeContextPR, WakeContextProject}, a.Context):
		return fmt.Errorf("unknown context %q (thread, pr or project)", a.Context)
	case a.Context != "" && t != ArgString:
		return errors.New("a context arg must be a string")
	case utf8.RuneCountInString(a.Description) > MaxDescription:
		return fmt.Errorf("description longer than %d characters", MaxDescription)
	case a.Default != "":
		if err := a.Check(a.Default); err != nil {
			return fmt.Errorf("default: %w", err)
		}
	}
	return nil
}

// TypeOr returns the arg's type, ArgString when unset.
func (a WakeArgSpec) TypeOr() string {
	if a.Type == "" {
		return ArgString
	}
	return a.Type
}

// Check reports whether v is a value of the arg: an int a whole number, a bool true or
// false, an enum one of its values, a duration a Go duration over zero; never empty,
// at most MaxWakeArgLen bytes, one line.
func (a WakeArgSpec) Check(v string) error {
	switch {
	case v == "":
		return errors.New("empty value")
	case len(v) > MaxWakeArgLen:
		return fmt.Errorf("longer than %d bytes", MaxWakeArgLen)
	case strings.ContainsAny(v, "\n\r"):
		return errors.New("more than one line")
	}
	if a.TypeOr() == ArgDuration {
		if d, err := time.ParseDuration(v); err != nil || d <= 0 {
			return fmt.Errorf("want a duration over zero (10s, 1m30s), got %q", v)
		}
		return nil
	}
	return parseArgValue(a.TypeOr(), a.Enum, v)
}

// Wake returns the manifest's wake source name.
func (m Manifest) Wake(name string) (WakeSpec, bool) {
	i := slices.IndexFunc(m.Wakes, func(w WakeSpec) bool { return w.Name == name })
	if i < 0 {
		return WakeSpec{}, false
	}
	return m.Wakes[i], true
}

// Arg returns the source's arg name.
func (w WakeSpec) Arg(name string) (WakeArgSpec, bool) {
	i := slices.IndexFunc(w.Args, func(a WakeArgSpec) bool { return a.Name == name })
	if i < 0 {
		return WakeArgSpec{}, false
	}
	return w.Args[i], true
}

// ScopeOr returns the source's scope, WakeScopeGlobal when unset.
func (w WakeSpec) ScopeOr() string {
	if w.Scope == "" {
		return WakeScopeGlobal
	}
	return w.Scope
}

// Wake methods.
const (
	// MethodWakeSubscribed (host → plugin notification): WakeSubscription, a thread
	// subscribed to one of the plugin's wake sources. Sent when it subscribes and again,
	// for every live subscription, right after each initialized (so a restarted plugin
	// re-arms), those with Rearm set: treat a repeat as the same subscription.
	MethodWakeSubscribed = "wake/subscribed"
	// MethodWakeUnsubscribed (host → plugin notification): WakeUnsubscribed, the
	// subscription is gone (unsubscribed, a one-shot that fired, its thread archived or
	// removed). Stop watching for it.
	MethodWakeUnsubscribed = "wake/unsubscribed"
	// MethodWakeArmed (host → plugin notification): WakeArmed, sent once after each
	// initialized's replay of the live subscriptions (also when there were none). A
	// subscription the plugin remembers that was not replayed ended while it was down.
	MethodWakeArmed = "wake/armed"
	// MethodWakeFire (plugin → host request): WakeFire → WakeFireResult. Delivers a wake
	// to every subscription of the source whose args the match repeats.
	MethodWakeFire = "wake/fire"
)

// WakeSubscription is wake/subscribed's params.
type WakeSubscription struct {
	// Subscription is the host's id ("sub-…").
	Subscription string `json:"subscription"`
	// Source is the wake source's name.
	Source string `json:"source"`
	// Args are the subscription's args: given, defaulted, or taken from the
	// subscriber's context. An optional arg without a value is absent.
	Args map[string]string `json:"args,omitempty"`
	// Context is the subscribing thread's: its id, project and worktree.
	Context UiContext `json:"context"`
	// Repeat: the subscription stays after a fire; otherwise the host removes it (and
	// sends wake/unsubscribed) after the first fire that reaches it.
	Repeat bool `json:"repeat,omitempty"`
	// Rearm: the host is replaying a live subscription after the plugin started (it may
	// be one the plugin remembers from before); false for a thread subscribing now.
	Rearm bool `json:"rearm,omitempty"`
}

// WakeArmed is wake/armed's params: how many live subscriptions the host replayed.
type WakeArmed struct {
	Count int `json:"count"`
}

// WakeUnsubscribed is wake/unsubscribed's params.
type WakeUnsubscribed struct {
	Subscription string `json:"subscription"`
	Source       string `json:"source,omitempty"`
}

// WakeFire is wake/fire's params.
type WakeFire struct {
	Source string `json:"source"`
	// Match selects the subscriptions: one is woken when each of its args equals the
	// match's value of that name (a subscription with fewer args matches more fires).
	// Names must be the source's args.
	Match map[string]string `json:"match,omitempty"`
	// Title is one line (at most MaxWakeTitle characters): the wake's header reads
	// "<plugin>: <source> — <title>".
	Title string `json:"title"`
	// Payload is any JSON (at most MaxWakePayload bytes), handed to the agent as is.
	Payload json.RawMessage `json:"payload,omitempty"`
}

// WakeFireResult is wake/fire's answer: how many threads were woken (a thread over its
// wake limit is not).
type WakeFireResult struct {
	Delivered int `json:"delivered"`
}

// FireWake fires one of the plugin's wake sources: every thread subscribed to it whose
// subscription's args all equal match's gets a wake message with title and payload
// (encoded as JSON; nil is null). It returns how many threads were woken.
func (h *Host) FireWake(ctx context.Context, source string, match map[string]string, title string, payload any) (int, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return 0, fmt.Errorf("pluginsdk: encode wake payload: %w", err)
	}
	if len(raw) > MaxWakePayload {
		return 0, fmt.Errorf("pluginsdk: wake payload of %d bytes (at most %d)", len(raw), MaxWakePayload)
	}
	var res WakeFireResult
	err = h.conn.Call(ctx, MethodWakeFire, WakeFire{Source: source, Match: match, Title: title, Payload: raw}, &res)
	return res.Delivered, err
}

// WakeHint is the plugin's WakeHint for its own name.
func (h *Host) WakeHint(source string, args map[string]string) string {
	return WakeHint(h.Name(), source, args)
}

// WakeHint returns the command line that subscribes the thread it runs in to a wake
// source: "code-foundry thread subscribe --plugin gh-actions/checks-done --arg
// pr=owner/name#12". End every message, notice or timeline text about an event with
// it, so an agent that reads it waits for the next one instead of polling; never a flag
// reason (one line of at most 80 characters: the line does not fit). Args are sorted by
// name; a value the shell would split or expand is single-quoted.
func WakeHint(plugin, source string, args map[string]string) string {
	var b strings.Builder
	b.WriteString("code-foundry thread subscribe --plugin ")
	b.WriteString(shellWord(plugin + "/" + source))
	keys := make([]string, 0, len(args))
	for k := range args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		b.WriteString(" --arg ")
		b.WriteString(shellWord(k + "=" + args[k]))
	}
	return b.String()
}

var plainWord = regexp.MustCompile(`^[A-Za-z0-9._/#:=@%+,-]+$`)

// shellWord quotes s for a POSIX shell when it needs it.
func shellWord(s string) string {
	if plainWord.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// WakeTarget is a subscription's target: "<plugin>/<source>".
func WakeTarget(plugin, source string) string { return plugin + "/" + source }

// ParseWakeTarget splits "<plugin>/<source>", checking both names' shapes.
func ParseWakeTarget(target string) (plugin, source string, err error) {
	plugin, source, ok := strings.Cut(target, "/")
	switch {
	case !ok || plugin == "" || source == "":
		return "", "", fmt.Errorf("%q is not <plugin>/<source>", target)
	case !namePattern.MatchString(plugin):
		return "", "", fmt.Errorf("%q is not a plugin name", plugin)
	case !wakeNamePattern.MatchString(source):
		return "", "", fmt.Errorf("%q is not a wake source name", source)
	}
	return plugin, source, nil
}

// MatchWake reports whether a fire's match wakes a subscription with args: each of the
// subscription's args has the same value in match.
func MatchWake(args, match map[string]string) bool {
	for k, v := range args {
		if mv, ok := match[k]; !ok || mv != v {
			return false
		}
	}
	return true
}

// FormatWakeArgs is a subscription's args as "k=v k2=v2", sorted by name ("" for none).
func FormatWakeArgs(args map[string]string) string {
	keys := make([]string, 0, len(args))
	for k := range args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + args[k]
	}
	return strings.Join(parts, " ")
}
