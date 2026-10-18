package pluginsdk

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"
)

// ManifestFile is the manifest's file name inside a plugin's package directory.
const ManifestFile = "plugin.json"

// ProtocolVersion is the protocol major this SDK speaks.
const ProtocolVersion = 1

// Manifest is plugin.json: what a plugin is and everything it contributes. The host
// reads it before it runs anything (consent, listing, commands that stay listed while
// the plugin is down); initialize may narrow it, never widen it.
type Manifest struct {
	// Name is the plugin's id and its directory's name: [a-z0-9][a-z0-9-]{0,63}. A
	// plugin with commands needs a name that is also a command segment (a letter first,
	// no double or trailing hyphen): its commands are plugin.<name>.<command>.
	Name string `json:"name"`
	// DisplayName is shown in lists and as the commands' palette group (default Name).
	DisplayName string `json:"displayName,omitempty"`
	// Version is a strict semantic version without a leading v ("0.3.0", "1.0.0-rc.1").
	Version     string `json:"version"`
	Description string `json:"description,omitempty"`
	// Protocol is the protocol major the plugin speaks (ProtocolVersion).
	Protocol int `json:"protocol"`
	// Exec is the argv the host starts. Exec[0] containing a slash is relative to the
	// package directory and must stay inside it; a bare name ("python3", "node") is
	// looked up on PATH.
	Exec        []string    `json:"exec"`
	Permissions Permissions `json:"permissions"`
	// Commands become plugin.<name>.<command> in the host's command registry: palette
	// entries and `code-foundry plugin <name> <command>` CLI verbs.
	Commands []CommandSpec `json:"commands,omitempty"`
	// Surfaces are the plugin's views (side-panel tabs, settings sections).
	Surfaces []SurfaceSpec `json:"surfaces,omitempty"`
}

// Permissions is what a plugin may do through the host, shown at consent and enforced
// on every call. The keys are fixed by the plugin registry's entry schema; a missing key
// reads as false or empty.
type Permissions struct {
	// Commands are host commands the plugin may invoke (host/invoke), as globs over
	// dotted names: "*" matches within one segment, "**" across segments
	// ("thread.send", "view.open.*", "action.**").
	Commands []string `json:"commands,omitempty"`
	// Events are the event sources the plugin may subscribe to (EventSources).
	Events []string `json:"events,omitempty"`
	// ThreadStatus lets the plugin raise attention or error flags on threads.
	ThreadStatus bool `json:"threadStatus,omitempty"`
	// SessionEnv lets the plugin add env, PATH entries and --add-dir to new Claude
	// sessions.
	SessionEnv bool `json:"sessionEnv,omitempty"`
	// Secrets gates secret/get, secret/set, secret/delete and secret/list: values in the
	// user's Keychain, namespaced to the plugin.
	Secrets bool `json:"secrets,omitempty"`
	// Threads lets the plugin create and drive its own Claude threads.
	Threads bool `json:"threads,omitempty"`
	// Terminals lets the plugin create its own terminals.
	Terminals bool `json:"terminals,omitempty"`
	// API hands the plugin the daemon's endpoint and token: full control of Code Foundry.
	API bool `json:"api,omitempty"`
}

// CommandSpec declares one plugin command.
type CommandSpec struct {
	// Name is one or more dotted kebab-case segments ("greet", "run.rerun-failed").
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	// When is an availability predicate over host facts, evaluated by the host: where it
	// does not hold the command is listed as unavailable (and says why when run).
	When string `json:"when,omitempty"`
	// Confirm makes the command destructive: the host asks the user with this text first
	// ({arg} placeholders allowed). A plugin can never confirm on the user's behalf.
	Confirm string `json:"confirm,omitempty"`
	// TimeoutSeconds bounds one invocation (default 30, at most 600).
	TimeoutSeconds int       `json:"timeoutSeconds,omitempty"`
	Args           []ArgSpec `json:"args,omitempty"`
}

// Arg types.
const (
	ArgString = "string"
	ArgBool   = "bool"
	ArgInt    = "int"
	ArgEnum   = "enum"
	ArgPath   = "path"
)

// Arg contexts: an arg with one defaults to the caller's active thread, project,
// worktree or terminal.
const (
	ArgContextThread   = "thread"
	ArgContextProject  = "project"
	ArgContextWorktree = "worktree"
	ArgContextTerminal = "terminal"
)

// ArgSpec declares one command argument. Values travel as strings.
type ArgSpec struct {
	// Name is kebab-case; it is also the CLI flag.
	Name        string   `json:"name"`
	Type        string   `json:"type,omitempty"` // ArgString (default), ArgBool, ArgInt, ArgEnum, ArgPath
	Description string   `json:"description,omitempty"`
	Required    bool     `json:"required,omitempty"`
	Enum        []string `json:"enum,omitempty"`
	Default     string   `json:"default,omitempty"`
	// Positional args also take bare words on the CLI, in declaration order.
	Positional bool `json:"positional,omitempty"`
	// Context is ArgContextThread, ArgContextProject, ArgContextWorktree or
	// ArgContextTerminal (string and path args only).
	Context string `json:"context,omitempty"`
}

// Surface scopes: what one instance of a surface is for.
const (
	ScopeGlobal   = "global"
	ScopeThread   = "thread"
	ScopeProject  = "project"
	ScopeWorktree = "worktree"
	ScopePR       = "pr"
)

// Surface placements.
const (
	PlacementPanel    = "panel"
	PlacementSettings = "settings"
)

// SurfaceSpec declares one surface (a view the host renders from the plugin's view model).
type SurfaceSpec struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Icon is a lucide icon name from the host's allowlist (unknown names fall back).
	Icon      string   `json:"icon,omitempty"`
	Scope     string   `json:"scope,omitempty"`     // default ScopeThread
	Placement []string `json:"placement,omitempty"` // default [PlacementPanel]
	When      string   `json:"when,omitempty"`
}

// EventSources are the sources Permissions.Events may name.
var EventSources = []string{"project", "workspace", "threads", "thread", "gh", "gitops", "settings", "update", "action", "plugin"}

// ReservedNames are plugin names the host's own plugin.* verbs use.
var ReservedNames = []string{
	"list", "show", "install", "uninstall", "enable", "disable", "restart", "logs", "dev",
	"reload", "surface", "act", "secrets", "update", "env", "threads", "terminals", "browse",
}

// ReservedArgNames are CLI flags every command has; args may not use them.
var ReservedArgNames = []string{
	"json", "help", "h", "yes",
	"context-terminal", "context-thread", "context-project", "context-worktree", "context-workspace",
}

var (
	namePattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	segmentPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`)
	cmdNamePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)*$`)
	globPattern    = regexp.MustCompile(`^[a-z0-9*-]+(\.[a-z0-9*-]+)*$`)
	iconPattern    = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	placeholderRE  = regexp.MustCompile(`\{([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}`)
	// semverPattern is semver.org's strict pattern, without a leading v.
	semverPattern = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)` +
		`(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?` +
		`(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`)
)

// Limits on manifest fields.
const (
	MaxDisplayName    = 60
	MaxDescription    = 300
	MaxTitle          = 80
	MaxCommands       = 100
	MaxSurfaces       = 20
	DefaultTimeout    = 30
	MaxTimeoutSeconds = 600
)

// ParseManifest decodes plugin.json. Unknown fields are not an error (forward
// compatibility); they come back as warnings ("commands[1].keybindings: unknown field").
// The manifest is not validated: call Validate.
func ParseManifest(data []byte) (Manifest, []string, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Manifest{}, nil, fmt.Errorf("%s: %w", ManifestFile, err)
	}
	var warnings []string
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err == nil {
		warnings = unknownFields("", raw, Manifest{})
		if p, ok := raw["permissions"]; ok {
			warnings = append(warnings, unknownIn("permissions", p, Permissions{})...)
		}
		warnings = append(warnings, unknownInList("commands", raw["commands"], CommandSpec{})...)
		warnings = append(warnings, unknownInList("surfaces", raw["surfaces"], SurfaceSpec{})...)
		var cmds []map[string]json.RawMessage
		if json.Unmarshal(raw["commands"], &cmds) == nil {
			for i, c := range cmds {
				warnings = append(warnings, unknownInList(fmt.Sprintf("commands[%d].args", i), c["args"], ArgSpec{})...)
			}
		}
	}
	return m, warnings, nil
}

func unknownIn(prefix string, data json.RawMessage, schema any) []string {
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil {
		return nil
	}
	return unknownFields(prefix+".", raw, schema)
}

func unknownInList(prefix string, data json.RawMessage, schema any) []string {
	var list []json.RawMessage
	if len(data) == 0 || json.Unmarshal(data, &list) != nil {
		return nil
	}
	var out []string
	for i, item := range list {
		out = append(out, unknownIn(fmt.Sprintf("%s[%d]", prefix, i), item, schema)...)
	}
	return out
}

// unknownFields lists the keys of raw that schema's JSON tags do not name.
func unknownFields(prefix string, raw map[string]json.RawMessage, schema any) []string {
	known := jsonFieldNames(schema)
	var out []string
	for k := range raw {
		if !slices.Contains(known, k) {
			out = append(out, prefix+k+": unknown field")
		}
	}
	sort.Strings(out)
	return out
}

// jsonFieldNames returns the JSON names of a manifest struct's fields. Kept by hand
// beside the types (manifest_test.go checks them against the struct tags).
func jsonFieldNames(schema any) []string {
	switch schema.(type) {
	case Manifest:
		return []string{"name", "displayName", "version", "description", "protocol", "exec", "permissions", "commands", "surfaces"}
	case Permissions:
		return []string{"commands", "events", "threadStatus", "sessionEnv", "secrets", "threads", "terminals", "api"}
	case CommandSpec:
		return []string{"name", "title", "description", "when", "confirm", "timeoutSeconds", "args"}
	case ArgSpec:
		return []string{"name", "type", "description", "required", "enum", "default", "positional", "context"}
	case SurfaceSpec:
		return []string{"id", "title", "icon", "scope", "placement", "when"}
	}
	return nil
}

// LoadManifest parses and validates plugin.json.
func LoadManifest(data []byte) (Manifest, []string, error) {
	m, warnings, err := ParseManifest(data)
	if err != nil {
		return Manifest{}, nil, err
	}
	if err := m.Validate(); err != nil {
		return m, warnings, err
	}
	return m, warnings, nil
}

// Validate checks the manifest's shape. The error joins one error per problem, each
// naming its field ("commands[0].args[1].type: …").
func (m Manifest) Validate() error {
	var errs []error
	bad := func(field, format string, a ...any) {
		errs = append(errs, fmt.Errorf("%s: %s", field, fmt.Sprintf(format, a...)))
	}
	switch {
	case !namePattern.MatchString(m.Name):
		bad("name", "%q must match %s", m.Name, namePattern)
	case slices.Contains(ReservedNames, m.Name):
		bad("name", "%q is reserved (a plugin.* verb)", m.Name)
	case len(m.Commands) > 0 && !segmentPattern.MatchString(m.Name):
		bad("name", "%q cannot carry commands: a command segment starts with a letter and has no double or trailing hyphen", m.Name)
	}
	if !semverPattern.MatchString(m.Version) {
		bad("version", "%q is not a semantic version (1.2.3, no leading v)", m.Version)
	}
	if utf8.RuneCountInString(m.DisplayName) > MaxDisplayName {
		bad("displayName", "longer than %d characters", MaxDisplayName)
	}
	if utf8.RuneCountInString(m.Description) > MaxDescription {
		bad("description", "longer than %d characters", MaxDescription)
	}
	if m.Protocol < 1 {
		bad("protocol", "must be a protocol major (%d)", ProtocolVersion)
	}
	if err := validateExec(m.Exec); err != nil {
		bad("exec", "%v", err)
	}
	for i, g := range m.Permissions.Commands {
		if !globPattern.MatchString(g) {
			bad(fmt.Sprintf("permissions.commands[%d]", i), "%q is not a command glob", g)
		}
	}
	for i, s := range m.Permissions.Events {
		if !slices.Contains(EventSources, s) {
			bad(fmt.Sprintf("permissions.events[%d]", i), "unknown event source %q (one of %s)", s, strings.Join(EventSources, ", "))
		}
	}
	if len(m.Commands) > MaxCommands {
		bad("commands", "more than %d", MaxCommands)
	}
	seen := map[string]bool{}
	for i, c := range m.Commands {
		f := fmt.Sprintf("commands[%d]", i)
		switch {
		case !cmdNamePattern.MatchString(c.Name):
			bad(f+".name", "%q must be dotted kebab-case segments", c.Name)
		case c.Name == "show" || strings.HasPrefix(c.Name, "show."):
			bad(f+".name", "%q is reserved for surfaces", c.Name)
		case seen[c.Name]:
			bad(f+".name", "%q declared twice", c.Name)
		}
		seen[c.Name] = true
		if c.Title == "" || utf8.RuneCountInString(c.Title) > MaxTitle {
			bad(f+".title", "required, at most %d characters", MaxTitle)
		}
		if c.TimeoutSeconds < 0 || c.TimeoutSeconds > MaxTimeoutSeconds {
			bad(f+".timeoutSeconds", "must be 0 (default %d) to %d", DefaultTimeout, MaxTimeoutSeconds)
		}
		args := map[string]bool{}
		for j, a := range c.Args {
			af := fmt.Sprintf("%s.args[%d]", f, j)
			if err := a.validate(); err != nil {
				bad(af, "%v", err)
			}
			if args[a.Name] {
				bad(af+".name", "%q declared twice", a.Name)
			}
			args[a.Name] = true
		}
		for _, ph := range placeholderRE.FindAllStringSubmatch(c.Confirm, -1) {
			if !args[ph[1]] {
				bad(f+".confirm", "names unknown arg %q", ph[1])
			}
		}
	}
	if len(m.Surfaces) > MaxSurfaces {
		bad("surfaces", "more than %d", MaxSurfaces)
	}
	ids := map[string]bool{}
	for i, s := range m.Surfaces {
		f := fmt.Sprintf("surfaces[%d]", i)
		if !segmentPattern.MatchString(s.ID) {
			bad(f+".id", "%q must be kebab-case", s.ID)
		} else if ids[s.ID] {
			bad(f+".id", "%q declared twice", s.ID)
		}
		ids[s.ID] = true
		if s.Title == "" || utf8.RuneCountInString(s.Title) > MaxTitle {
			bad(f+".title", "required, at most %d characters", MaxTitle)
		}
		if s.Icon != "" && !iconPattern.MatchString(s.Icon) {
			bad(f+".icon", "%q is not a lucide icon name", s.Icon)
		}
		if s.Scope != "" && !slices.Contains([]string{ScopeGlobal, ScopeThread, ScopeProject, ScopeWorktree, ScopePR}, s.Scope) {
			bad(f+".scope", "unknown scope %q", s.Scope)
		}
		for _, p := range s.Placement {
			if p != PlacementPanel && p != PlacementSettings {
				bad(f+".placement", "unknown placement %q", p)
			}
		}
	}
	return errors.Join(errs...)
}

func validateExec(argv []string) error {
	if len(argv) == 0 || strings.TrimSpace(argv[0]) == "" {
		return errors.New("required: the argv to start")
	}
	p := argv[0]
	if !strings.Contains(p, "/") {
		return nil
	}
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, "~") {
		return fmt.Errorf("%q must be relative to the package directory", p)
	}
	if c := path.Clean(p); c == ".." || strings.HasPrefix(c, "../") {
		return fmt.Errorf("%q leaves the package directory", p)
	}
	return nil
}

func (a ArgSpec) validate() error {
	t := a.Type
	if t == "" {
		t = ArgString
	}
	switch {
	case !segmentPattern.MatchString(a.Name):
		return fmt.Errorf("name %q must be kebab-case", a.Name)
	case slices.Contains(ReservedArgNames, a.Name):
		return fmt.Errorf("name %q is reserved for a CLI flag", a.Name)
	case !slices.Contains([]string{ArgString, ArgBool, ArgInt, ArgEnum, ArgPath}, t):
		return fmt.Errorf("unknown type %q", a.Type)
	case t == ArgEnum && len(a.Enum) == 0:
		return errors.New("an enum arg needs values")
	case t != ArgEnum && len(a.Enum) > 0:
		return errors.New("enum values on a non-enum arg")
	case a.Required && a.Default != "":
		return errors.New("a required arg cannot have a default")
	case a.Context != "" && !slices.Contains([]string{ArgContextThread, ArgContextProject, ArgContextWorktree, ArgContextTerminal}, a.Context):
		return fmt.Errorf("unknown context %q", a.Context)
	case a.Context != "" && t != ArgString && t != ArgPath:
		return errors.New("a context arg must be a string or a path")
	case t == ArgEnum && a.Default != "" && !slices.Contains(a.Enum, a.Default):
		return fmt.Errorf("default %q is not one of the values", a.Default)
	}
	return nil
}

// DisplayNameOr returns DisplayName, else Name.
func (m Manifest) DisplayNameOr() string {
	if m.DisplayName != "" {
		return m.DisplayName
	}
	return m.Name
}

// Timeout returns the command's invocation timeout in seconds (DefaultTimeout when 0).
func (c CommandSpec) Timeout() int {
	if c.TimeoutSeconds <= 0 {
		return DefaultTimeout
	}
	return min(c.TimeoutSeconds, MaxTimeoutSeconds)
}

// globRE compiles a command glob: "**" matches anything, "*" anything but a dot.
func globRE(g string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(g); i++ {
		switch {
		case strings.HasPrefix(g[i:], "**"):
			b.WriteString(".*")
			i++
		case g[i] == '*':
			b.WriteString("[^.]*")
		default:
			b.WriteString(regexp.QuoteMeta(g[i : i+1]))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

// MatchCommand reports whether the command glob g matches the dotted command name.
func MatchCommand(g, name string) bool {
	if !globPattern.MatchString(g) {
		return false
	}
	return globRE(g).MatchString(name)
}

// AllowsCommand reports whether one of p.Commands matches name.
func (p Permissions) AllowsCommand(name string) bool {
	return slices.ContainsFunc(p.Commands, func(g string) bool { return MatchCommand(g, name) })
}

// Within reports whether p asks for nothing granted does not cover: every command glob
// and event source of p is also in granted (globs compare as text), and no flag of p is
// set that granted lacks. An update whose permissions are not Within the granted ones
// needs consent again.
func (p Permissions) Within(granted Permissions) bool {
	for _, g := range p.Commands {
		if !slices.Contains(granted.Commands, g) {
			return false
		}
	}
	for _, e := range p.Events {
		if !slices.Contains(granted.Events, e) {
			return false
		}
	}
	flags := func(x Permissions) []bool {
		return []bool{x.ThreadStatus, x.SessionEnv, x.Secrets, x.Threads, x.Terminals, x.API}
	}
	pf, gf := flags(p), flags(granted)
	for i := range pf {
		if pf[i] && !gf[i] {
			return false
		}
	}
	return true
}

// Empty reports whether p asks for nothing.
func (p Permissions) Empty() bool {
	return p.Within(Permissions{})
}

// Normalize returns p with its lists sorted and deduplicated, for storing and comparing.
func (p Permissions) Normalize() Permissions {
	norm := func(s []string) []string {
		if len(s) == 0 {
			return nil
		}
		out := slices.Clone(s)
		slices.Sort(out)
		return slices.Compact(out)
	}
	p.Commands, p.Events = norm(p.Commands), norm(p.Events)
	return p
}

// Describe lists p in words, one line per permission, for consent ("run Code Foundry
// commands: thread.send"). Empty for no permissions.
func (p Permissions) Describe() []string {
	var out []string
	if len(p.Commands) > 0 {
		out = append(out, "run Code Foundry commands: "+strings.Join(p.Commands, ", "))
	}
	if len(p.Events) > 0 {
		out = append(out, "read events: "+strings.Join(p.Events, ", "))
	}
	if p.ThreadStatus {
		out = append(out, "raise threads to needs-attention or error")
	}
	if p.SessionEnv {
		out = append(out, "add environment variables, PATH entries and directories to new Claude sessions")
	}
	if p.Secrets {
		out = append(out, "keep secrets in your Keychain (its own, under code-foundry-plugin)")
	}
	if p.Threads {
		out = append(out, "start and drive its own Claude threads")
	}
	if p.Terminals {
		out = append(out, "open its own terminals")
	}
	if p.API {
		out = append(out, "full control of Code Foundry (it gets the daemon's endpoint and token)")
	}
	return out
}

// Equal reports whether two normalized permission sets are the same.
func (p Permissions) Equal(q Permissions) bool {
	a, _ := json.Marshal(p.Normalize())
	b, _ := json.Marshal(q.Normalize())
	return bytes.Equal(a, b)
}
