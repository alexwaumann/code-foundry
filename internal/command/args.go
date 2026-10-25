package command

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// ArgType is the type of an argument. Values travel as strings; the type drives
// validation, CLI flag shape, and the palette's input widget.
type ArgType int

const (
	// String is free text.
	String ArgType = iota + 1
	// Bool is "true"/"false" (also 1/0, t/f). On the CLI it is a valueless flag.
	Bool
	// Int is a base-10 integer.
	Int
	// Enum is one of ArgSpec.Enum.
	Enum
	// Path is a filesystem path. A leading ~ is expanded; the result must be absolute
	// (the daemon's cwd is /, so relative paths are meaningless there; the CLI makes
	// them absolute against its own cwd before sending).
	Path
)

// String returns the lowercase type name used in help output.
func (t ArgType) String() string {
	switch t {
	case String:
		return "string"
	case Bool:
		return "bool"
	case Int:
		return "int"
	case Enum:
		return "enum"
	case Path:
		return "path"
	default:
		return "ArgType(" + strconv.Itoa(int(t)) + ")"
	}
}

// ArgSpec describes one argument.
type ArgSpec struct {
	// Name is kebab-case and doubles as the CLI flag name.
	Name        string
	Type        ArgType
	Required    bool
	Description string
	// Enum lists the allowed values for Type == Enum.
	Enum []string
	// EnumFunc, when set, lists them instead, again at every List, Get and Invoke
	// (Registry.effective): values that change while the daemon runs (the theme ids,
	// the user's own themes among them). Enum is left empty.
	EnumFunc func() []string
	// EnumMiss, when set, explains a value that is not one of the enum's instead of
	// listing them all ("GitHub Light is a light theme…", "nord is curated: theme
	// duplicate nord first"); nil from it falls back to the list.
	EnumMiss func(v string) error
	// Default is used when the arg is absent. Must parse as Type. Not allowed with Required.
	Default string
	// Context, when set, makes the arg default to that field of the caller's Context.
	// It also works the other way: an explicit value stands in for that field when
	// evaluating When, so `terminal.kill --id t1` is available without an active terminal.
	Context ContextField
	// Positional args also take bare words on the CLI, in declaration order:
	// `code-foundry settings set <key> <value>`.
	Positional bool
	// DefaultToCwd makes the CLI send its working directory when the flag is not
	// given (Path args only). A Claude session runs the CLI from its worktree, so
	// `code-foundry thread checkouts` finds the thread from its checkout.
	DefaultToCwd bool
	// DefaultToThreadEnv makes the CLI send $CODE_FOUNDRY_THREAD (the thread its Claude
	// runs in) when the flag is not given; --flag= opts out (String args only). Unlike
	// Context it never reads the caller's active thread: the GUI's active thread is
	// the one the user is viewing.
	DefaultToThreadEnv bool
	// FileOrStdin makes the CLI read the value from a file when it is @<path>, or from
	// stdin when it is - (String args only).
	FileOrStdin bool
	// ID makes the arg an id of that kind: Invoke replaces a unique suffix of one with
	// the full id before Run (resolve.go). String args only.
	ID IDKind
	// IDList makes an ID arg a comma-separated list of ids: Invoke resolves each entry
	// and hands Run the full ids joined by commas (blanks dropped). Not context-bound.
	IDList bool
	// Repeatable lets the CLI take the flag more than once; it sends the values joined
	// by newlines (thread.subscribe's --arg k=v). String args only, not positional.
	Repeatable bool
	// Rest makes the last positional arg take every bare word left on the CLI, joined
	// by spaces: `memory add always open PRs as drafts` needs no quotes. String
	// positional args only.
	Rest bool
}

// positional is s taking a bare word on the CLI too: `thread archive 8f3a`.
func positional(s ArgSpec) ArgSpec {
	s.Positional = true
	return s
}

// validate checks the spec's static shape at Register time.
func (s ArgSpec) validate() error {
	switch {
	case !argNamePattern.MatchString(s.Name):
		return fmt.Errorf("name must match %s", argNamePattern)
	case slices.Contains(ReservedArgNames, s.Name):
		return errors.New("name is reserved for a CLI flag")
	case s.Type < String || s.Type > Path:
		return fmt.Errorf("unknown type %d", s.Type)
	case s.Type == Enum && len(s.Enum) == 0 && s.EnumFunc == nil:
		return errors.New("enum arg needs values")
	case s.Type == Enum && len(s.Enum) > 0 && s.EnumFunc != nil:
		return errors.New("enum arg with both values and a function")
	case s.Type != Enum && (len(s.Enum) > 0 || s.EnumFunc != nil):
		return errors.New("enum values on a non-enum arg")
	case s.EnumFunc != nil && s.Default != "":
		return errors.New("an enum arg listed by a function cannot have a default")
	case s.Required && s.Default != "":
		return errors.New("required arg cannot have a default")
	case s.Context < NoContext || s.Context > ContextWorktree:
		return fmt.Errorf("unknown context field %d", s.Context)
	case s.Context != NoContext && s.Type != String && s.Type != Path:
		return errors.New("context-bound arg must be a string or path")
	case s.DefaultToCwd && s.Type != Path:
		return errors.New("only a path arg can default to the working directory")
	case s.DefaultToThreadEnv && (s.Type != String || s.Context != NoContext || s.Default != ""):
		return errors.New("only a string arg without a context or default can default to $CODE_FOUNDRY_THREAD")
	case s.FileOrStdin && s.Type != String:
		return errors.New("only a string arg can be read from a file or stdin")
	case s.ID != NoID && (s.Type != String || !knownIDKind(s.ID)):
		return errors.New("only a string arg can be an id, of a known kind")
	case s.IDList && (s.ID == NoID || s.Context != NoContext):
		return errors.New("an id list needs an id kind and no context")
	case s.Repeatable && (s.Type != String || s.Positional || s.Context != NoContext):
		return errors.New("only a string flag without a context can be repeated")
	case s.Rest && (s.Type != String || !s.Positional):
		return errors.New("only a string positional arg can take the rest of the words")
	}
	if s.Default != "" {
		if _, err := s.parse(s.Default); err != nil {
			return fmt.Errorf("default: %w", err)
		}
	}
	return nil
}

// knownIDKind: kind is one idKinds lists.
func knownIDKind(kind IDKind) bool {
	_, ok := idKinds[kind]
	return ok
}

// ArgError is an argument validation failure. It wraps ErrInvalidArgs.
type ArgError struct {
	Arg string
	Msg string
}

func (e *ArgError) Error() string { return e.Msg }

// Unwrap makes errors.Is(err, ErrInvalidArgs) true.
func (e *ArgError) Unwrap() error { return ErrInvalidArgs }

// InvalidArg returns an *ArgError. Run funcs use it to report argument problems they
// detect themselves (e.g. an unparsable argv) so callers see InvalidArgument.
func InvalidArg(arg, format string, a ...any) error {
	return &ArgError{Arg: arg, Msg: fmt.Sprintf(format, a...)}
}

// Args is the validated, typed view of a command's arguments. Values are already
// parsed and defaulted; accessors return the zero value for absent or mistyped names.
type Args struct {
	vals map[string]any
	// given are the names the caller passed a value for (not a context or Default);
	// nil from NewArgs, where every value counts as given.
	given map[string]bool
}

// Given reports whether the caller passed name explicitly, rather than its value coming
// from the context or its Default (a settings default among them).
func (a Args) Given(name string) bool {
	if a.given == nil {
		return a.Has(name)
	}
	return a.given[name]
}

// Has reports whether name has a value (explicit, context default, or Default).
func (a Args) Has(name string) bool {
	_, ok := a.vals[name]
	return ok
}

// String returns a String, Enum, or Path arg.
func (a Args) String(name string) string {
	s, _ := a.vals[name].(string)
	return s
}

// Path returns a Path arg (tilde-expanded, absolute, cleaned).
func (a Args) Path(name string) string { return a.String(name) }

// Bool returns a Bool arg.
func (a Args) Bool(name string) bool {
	b, _ := a.vals[name].(bool)
	return b
}

// Int returns an Int arg.
func (a Args) Int(name string) int {
	n, _ := a.vals[name].(int)
	return n
}

// Words splits a String arg into shell-style words (see SplitWords). Errors are
// *ArgError.
func (a Args) Words(name string) ([]string, error) {
	w, err := SplitWords(a.String(name))
	if err != nil {
		return nil, InvalidArg(name, "argument %q: %v", name, err)
	}
	return w, nil
}

// NewArgs builds Args directly from typed values, for tests of Run funcs.
func NewArgs(vals map[string]any) Args { return Args{vals: maps.Clone(vals)} }

// parseArgs validates raw against specs and applies defaults. It returns the typed args
// and uctx with explicitly passed context-bound args overlaid. Empty strings count as
// absent, so a palette can send blank fields. Required args are checked separately
// (checkRequired) so that availability is reported before missing arguments.
func parseArgs(specs []ArgSpec, raw map[string]string, uctx Context) (Args, Context, error) {
	for _, name := range slices.Sorted(maps.Keys(raw)) {
		if !slices.ContainsFunc(specs, func(s ArgSpec) bool { return s.Name == name }) {
			return Args{}, uctx, InvalidArg(name, "unknown argument %q", name)
		}
	}
	vals := make(map[string]any, len(specs))
	given := map[string]bool{}
	eff := uctx
	for _, s := range specs {
		if v := raw[s.Name]; v != "" {
			parsed, err := s.parse(v)
			if err != nil {
				return Args{}, uctx, &ArgError{Arg: s.Name, Msg: fmt.Sprintf("argument %q: %v", s.Name, err)}
			}
			vals[s.Name] = parsed
			given[s.Name] = true
			if s.Context != NoContext {
				eff = eff.With(s.Context, parsed.(string))
			}
		}
	}
	for _, s := range specs {
		if _, ok := vals[s.Name]; ok {
			continue
		}
		if v := uctx.Get(s.Context); v != "" {
			vals[s.Name] = v
		} else if s.Default != "" {
			vals[s.Name], _ = s.parse(s.Default) // validated at Register
		}
	}
	return Args{vals: vals, given: given}, eff, nil
}

// checkRequired returns an *ArgError for the first required spec without a value.
func checkRequired(specs []ArgSpec, a Args) error {
	for _, s := range specs {
		if s.Required && !a.Has(s.Name) {
			return &ArgError{Arg: s.Name, Msg: fmt.Sprintf("missing required argument %q", s.Name)}
		}
	}
	return nil
}

// missingContextArg returns an *ArgError for the first required context-bound spec
// without a value: "missing --id (default: the active thread; there is none)".
func missingContextArg(specs []ArgSpec, a Args) error {
	for _, s := range specs {
		if s.Required && s.Context != NoContext && !a.Has(s.Name) {
			return &ArgError{Arg: s.Name, Msg: fmt.Sprintf("missing --%s (default: %s; there is none)", s.Name, s.Context.Describe())}
		}
	}
	return nil
}

// maxEnumListed is how many values an enum's error lists before it counts the rest (an
// enum of the user's themes can hold hundreds).
const maxEnumListed = 30

// parse converts one non-empty raw value to its typed form.
func (s ArgSpec) parse(v string) (any, error) {
	switch s.Type {
	case Bool:
		b, err := strconv.ParseBool(v)
		if err != nil {
			return nil, fmt.Errorf("want true or false, got %q", v)
		}
		return b, nil
	case Int:
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("want an integer, got %q", v)
		}
		return n, nil
	case Enum:
		if !slices.Contains(s.Enum, v) {
			if s.EnumMiss != nil {
				if err := s.EnumMiss(v); err != nil {
					return nil, err
				}
			}
			list := strings.Join(s.Enum[:min(len(s.Enum), maxEnumListed)], ", ")
			if n := len(s.Enum) - maxEnumListed; n > 0 {
				list += fmt.Sprintf(" and %d more", n)
			}
			return nil, fmt.Errorf("want one of %s, got %q", list, v)
		}
		return v, nil
	case Path:
		return ExpandPath(v)
	default:
		return v, nil
	}
}

// ExpandPath expands a leading "~" or "~/" to the user's home directory, cleans the
// path, and requires it to be absolute. "~user" is not supported.
func ExpandPath(p string) (string, error) {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("expand ~: %w", err)
		}
		p = home + p[1:]
	} else if strings.HasPrefix(p, "~") {
		return "", fmt.Errorf("~user paths are not supported: %q", p)
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("want an absolute path, got %q", p)
	}
	return filepath.Clean(p), nil
}

// SplitWords splits s into words like a POSIX shell would, without expansion: words are
// separated by unquoted whitespace; single quotes are literal; double quotes allow \" \\
// \$ \` escapes; a backslash outside quotes escapes the next character.
func SplitWords(s string) ([]string, error) {
	var (
		words []string
		cur   strings.Builder
		in    bool // inside a word (possibly an empty quoted one)
	)
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case r == ' ' || r == '\t' || r == '\n':
			if in {
				words = append(words, cur.String())
				cur.Reset()
				in = false
			}
		case r == '\\':
			if i+1 >= len(rs) {
				return nil, errors.New("trailing backslash")
			}
			i++
			cur.WriteRune(rs[i])
			in = true
		case r == '\'':
			end := slices.Index(rs[i+1:], '\'')
			if end < 0 {
				return nil, errors.New("unterminated single quote")
			}
			cur.WriteString(string(rs[i+1 : i+1+end]))
			i += end + 1
			in = true
		case r == '"':
			i++
			for ; i < len(rs) && rs[i] != '"'; i++ {
				if rs[i] == '\\' && i+1 < len(rs) && strings.ContainsRune(`"\$`+"`", rs[i+1]) {
					i++
				}
				cur.WriteRune(rs[i])
			}
			if i >= len(rs) {
				return nil, errors.New("unterminated double quote")
			}
			in = true
		default:
			cur.WriteRune(r)
			in = true
		}
	}
	if in {
		words = append(words, cur.String())
	}
	return words, nil
}
