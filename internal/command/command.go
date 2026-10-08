// Package command is the daemon's command registry. Every user action is a Command:
// the GUI palette, keybindings, and CLI verbs are three front doors to one Registry.
//
// Commands are registered explicitly, never from init(). Each domain exposes a
// Register<Domain> function (RegisterDaemon, RegisterUI, RegisterTerminal, RegisterRepo)
// that takes the registry plus the narrow dependencies it needs. The daemon calls them
// once at startup through internal/command/all. Explicit registration keeps the full set
// of commands visible at one call site, lets tests build a registry with fakes, and
// avoids import-order side effects.
package command

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
)

// Command is one user-facing action.
type Command struct {
	// Name is the dotted, stable identifier, e.g. "terminal.new". It must match NamePattern.
	Name string
	// Title is the palette title, e.g. "New Terminal".
	Title string
	// Description is one or two sentences for help output and the palette.
	Description string
	// Category is the palette group, e.g. "Terminal".
	Category string
	// Args describes the string-encoded arguments the command accepts.
	Args []ArgSpec
	// Keybindings are default GUI chords, e.g. "cmd+t".
	Keybindings []string
	// When reports whether the command is available in a context; nil means always.
	// On Invoke it sees the caller's context with explicitly passed context-bound args
	// overlaid (see ArgSpec.Context), so it must be a pure function of Context.
	When func(Context) bool
	// Run executes the command with validated args.
	Run func(ctx context.Context, uctx Context, args Args) (Result, error)
}

// Available reports whether c is available in uctx.
func (c *Command) Available(uctx Context) bool {
	return c.When == nil || c.When(uctx)
}

// Context is what the caller is looking at. It mirrors codefoundry.v1.UiContext. The
// GUI sends its real context; the CLI sends whatever --context-* flags were given.
type Context struct {
	ActiveTerminalID   string
	ActiveSessionID    string
	ActiveRepoID       string
	ActiveWorktreePath string
	// ActiveView is a logical view name ("terminal", "repo", ...). Empty from the CLI.
	ActiveView string
}

// ContextField names a Context field an argument can default from.
type ContextField int

const (
	// NoContext means the argument has no context default.
	NoContext ContextField = iota
	// ContextTerminal is Context.ActiveTerminalID.
	ContextTerminal
	// ContextSession is Context.ActiveSessionID.
	ContextSession
	// ContextRepo is Context.ActiveRepoID.
	ContextRepo
	// ContextWorktree is Context.ActiveWorktreePath.
	ContextWorktree
)

// Get returns field f of c.
func (c Context) Get(f ContextField) string {
	switch f {
	case ContextTerminal:
		return c.ActiveTerminalID
	case ContextSession:
		return c.ActiveSessionID
	case ContextRepo:
		return c.ActiveRepoID
	case ContextWorktree:
		return c.ActiveWorktreePath
	default:
		return ""
	}
}

// With returns a copy of c with field f set to v.
func (c Context) With(f ContextField, v string) Context {
	switch f {
	case ContextTerminal:
		c.ActiveTerminalID = v
	case ContextSession:
		c.ActiveSessionID = v
	case ContextRepo:
		c.ActiveRepoID = v
	case ContextWorktree:
		c.ActiveWorktreePath = v
	}
	return c
}

// Describe returns a phrase for help text, e.g. "the active terminal".
func (f ContextField) Describe() string {
	switch f {
	case ContextTerminal:
		return "the active terminal"
	case ContextSession:
		return "the active session"
	case ContextRepo:
		return "the active repository"
	case ContextWorktree:
		return "the active worktree"
	default:
		return ""
	}
}

// Result is what a command returns to its caller.
type Result struct {
	// Message is shown in the palette toast or printed by the CLI. May be empty.
	Message string
	// JSON is an optional structured result, printed by the CLI with --json. It is
	// encoded with protojson when it is a proto.Message and encoding/json otherwise.
	JSON any
}

// NamePattern is the required shape of command names: lowercase dotted segments, at
// least two, e.g. "terminal.new", "repo.worktree.new".
var NamePattern = regexp.MustCompile(`^[a-z]+(\.[a-z][a-z0-9]*)+$`)

// argNamePattern is the required shape of argument names. Kebab-case, so names map
// one-to-one onto CLI flags (--delete-branch).
var argNamePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`)

// ReservedArgNames are CLI flags every generated verb has; commands may not use them.
var ReservedArgNames = []string{
	"json", "help", "h",
	"context-terminal", "context-session", "context-repo", "context-worktree",
}

// Sentinel errors. Use errors.Is; internal/api maps them to Connect codes.
var (
	// ErrInvalidCommand is returned by Register for a malformed Command.
	ErrInvalidCommand = errors.New("invalid command")
	// ErrDuplicate is returned by Register when the name is taken.
	ErrDuplicate = errors.New("duplicate command")
	// ErrUnknownCommand is returned by Invoke for an unregistered name.
	ErrUnknownCommand = errors.New("unknown command")
	// ErrUnavailable is returned by Invoke when the command's When is false.
	ErrUnavailable = errors.New("not available in this context")
	// ErrInvalidArgs is wrapped by every *ArgError.
	ErrInvalidArgs = errors.New("invalid arguments")
)

// validate checks c's static shape.
func (c *Command) validate() error {
	invalid := func(format string, a ...any) error {
		return fmt.Errorf("%w %q: %s", ErrInvalidCommand, c.Name, fmt.Sprintf(format, a...))
	}
	if !NamePattern.MatchString(c.Name) {
		return invalid("name must match %s", NamePattern)
	}
	if c.Title == "" {
		return invalid("title is required")
	}
	if c.Category == "" {
		return invalid("category is required")
	}
	if c.Run == nil {
		return invalid("Run is required")
	}
	seen := make(map[string]bool, len(c.Args))
	for _, a := range c.Args {
		if err := a.validate(); err != nil {
			return invalid("arg %q: %v", a.Name, err)
		}
		if seen[a.Name] {
			return invalid("arg %q declared twice", a.Name)
		}
		seen[a.Name] = true
	}
	if slices.Contains(c.Keybindings, "") {
		return invalid("empty keybinding")
	}
	return nil
}
