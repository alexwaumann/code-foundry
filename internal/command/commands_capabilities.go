package command

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/presence"
	"github.com/alexwaumann/code-foundry/internal/store/memory"
	"github.com/alexwaumann/code-foundry/internal/store/skill"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// SettingsSchemaReader is SettingsService.GetSchema: daemon.capabilities counts the
// settings per group.
type SettingsSchemaReader interface {
	GetSchema(context.Context, *connect.Request[v1.GetSettingsSchemaRequest]) (*connect.Response[v1.GetSettingsSchemaResponse], error)
}

// PluginLister is PluginService.List: daemon.capabilities lists the installed plugins.
type PluginLister interface {
	List(context.Context, *connect.Request[v1.ListPluginsRequest]) (*connect.Response[v1.ListPluginsResponse], error)
}

// MemoryReader is the app memory's entries (*memory.Store).
type MemoryReader interface {
	Entries() ([]memory.Entry, error)
}

// SkillSnapshotter is the skill store's snapshot (*skill.Store): the skills and plugins
// installed from the marketplace.
type SkillSnapshotter interface {
	Snapshot() *skill.Snapshot
}

// ShippedSkill is one skill the daemon ships to every thread (internal/skills).
type ShippedSkill struct {
	Name    string `json:"name"`
	Purpose string `json:"purpose"`
	// Path is its SKILL.md.
	Path string `json:"path"`
}

// CapabilitiesDeps back daemon.capabilities: the registry it is registered in gives the
// commands, pages and panel surfaces; these give the rest. A nil field leaves its group
// empty.
type CapabilitiesDeps struct {
	Version  version.Info
	Settings SettingsSchemaReader
	Memory   MemoryReader
	Plugins  PluginLister
	Skills   SkillSnapshotter
	// Shipped lists the skills every thread gets (skills.Shipped).
	Shipped  func() []ShippedSkill
	Presence PresenceDeps
}

// capEnv is what a group reads.
type capEnv struct {
	r    *Registry
	d    CapabilitiesDeps
	uctx Context
}

// capGroup is one group of daemon.capabilities: its index line and its detail.
type capGroup struct {
	name, about string
	load        func(context.Context, capEnv) (capDetail, error)
}

// capDetail is a loaded group.
type capDetail struct {
	// Count is the index line's count; nil for a group without one.
	Count *int
	// Summary replaces the group's about in the index when set.
	Summary string
	// Text is --group's text; JSON its --json.
	Text string
	JSON any
}

func count(n int) *int { return &n }

// capGroups are daemon.capabilities' groups, in index order. A group is an entry here.
var capGroups = []capGroup{
	{"build", "this build's version, commit and source", capBuild},
	{"commands", "commands: every button, menu item and CLI verb is one", capCommands},
	{"pages", "main-pane pages and the verb that shows each", capPages},
	{"panel", "side panel surfaces and the verb that opens each in a thread", capPanel},
	{"rendering", "what the thread view renders: markdown, code, paths, images, PDFs, HTML", capRendering},
	{"skills", "skills every thread gets, and ones installed for Claude Code", capSkills},
	{"plugins", "installed plugins with their commands and surfaces", capPlugins},
	{"settings", "settings; values with code-foundry settings get --json", capSettings},
	{"memory", "remembered standing preferences (memory.* verbs)", capMemory},
	{"presence", "whether the user is looking at the app", capPresence},
}

// CapabilityGroups are daemon.capabilities' group names, in order.
func CapabilityGroups() []string {
	out := make([]string, len(capGroups))
	for i, g := range capGroups {
		out[i] = g.name
	}
	return out
}

// CapabilitiesIndex is daemon.capabilities' JSON without --group.
type CapabilitiesIndex struct {
	Version string          `json:"version"`
	Groups  []CapabilityRow `json:"groups"`
}

// CapabilityRow is one group's index line. Count is omitted for a group without one
// (build, presence); Error is why the group could not be read.
type CapabilityRow struct {
	Name        string `json:"name"`
	Count       *int   `json:"count,omitempty"`
	Description string `json:"description"`
	Error       string `json:"error,omitempty"`
}

// RegisterCapabilities registers daemon.capabilities: what this app can do, as an index
// of groups and one group in detail, read from r and the stores at the call so it is
// never stale (docs/notes/control-4-capabilities.md).
func RegisterCapabilities(r *Registry, d CapabilitiesDeps) error {
	return r.Register(Command{
		Name:  "daemon.capabilities",
		Title: "Show Capabilities",
		Description: "List what Code Foundry can do, one line per group (build, commands, pages, panel, rendering, " +
			"skills, plugins, settings, memory, presence); --group <name> shows one group in detail.",
		Category:     "Daemon",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "group", Type: Enum, Enum: CapabilityGroups(), Description: "Show this group in detail"},
		},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			env := capEnv{r: r, d: d, uctx: uctx}
			if name := a.String("group"); name != "" {
				g := capGroups[slices.IndexFunc(capGroups, func(g capGroup) bool { return g.name == name })]
				det, err := g.load(ctx, env)
				if err != nil {
					return Result{}, fmt.Errorf("capabilities %s: %w", name, err)
				}
				return Result{Message: det.Text, JSON: det.JSON}, nil
			}
			return capIndex(ctx, env), nil
		},
	})
}

// capIndex loads every group for its index line. A group that fails says why on its
// line instead of failing the index.
func capIndex(ctx context.Context, env capEnv) Result {
	v := env.d.Version
	idx := CapabilitiesIndex{Version: v.Version}
	var b strings.Builder
	head := "Code Foundry " + v.Version
	if c := v.ShortCommit(); c != "" {
		head += " (commit " + c + ")"
	}
	fmt.Fprintf(&b, "%s: what this app can do, by group.\n", head)
	for _, g := range capGroups {
		row := CapabilityRow{Name: g.name, Description: g.about}
		det, err := g.load(ctx, env)
		switch {
		case err != nil:
			row.Error = err.Error()
			row.Description += " (unavailable: " + row.Error + ")"
		default:
			row.Count = det.Count
			if det.Summary != "" {
				row.Description = det.Summary
			}
		}
		n := ""
		if row.Count != nil {
			n = fmt.Sprint(*row.Count)
		}
		fmt.Fprintf(&b, "%-10s %4s  %s\n", row.Name, n, row.Description)
		idx.Groups = append(idx.Groups, row)
	}
	b.WriteString("Details: code-foundry daemon.capabilities --group <name> (--json for either).")
	return Result{Message: b.String(), JSON: idx}
}

func capBuild(_ context.Context, env capEnv) (capDetail, error) {
	v := env.d.Version
	src := v.Source()
	js := DaemonVersion{Version: v.Version, Commit: v.Commit, GoVersion: v.GoVersion, SourceURL: src.URL, SourceRef: src.Ref}
	var b strings.Builder
	fmt.Fprintf(&b, "build: Code Foundry %s\n", v.Version)
	if v.Commit != "" {
		fmt.Fprintf(&b, "commit: %s\n", v.Commit)
	}
	if v.GoVersion != "" {
		fmt.Fprintf(&b, "go: %s\n", v.GoVersion)
	}
	fmt.Fprintf(&b, "source: %s\n", src.URL)
	_, caveat, _ := strings.Cut(v.Provenance(), src.URL)
	if caveat = strings.TrimSpace(caveat); caveat != "" {
		fmt.Fprintf(&b, "%s\n", caveat)
	}
	b.WriteString("Read the source at that ref for how something works inside (the code-foundry-help skill's \"Reading the source\").")
	sum := v.Version + ", source " + src.URL
	return capDetail{Summary: sum, Text: b.String(), JSON: js}, nil
}

// CapabilityCommands is --group commands' JSON.
type CapabilityCommands struct {
	Count      int                  `json:"count"`
	Categories []CapabilityCategory `json:"categories"`
}

// CapabilityCategory is one command category.
type CapabilityCategory struct {
	Name     string          `json:"name"`
	Count    int             `json:"count"`
	Commands []CapabilityCmd `json:"commands"`
}

// CapabilityCmd is one command by name and title.
type CapabilityCmd struct {
	Name  string `json:"name"`
	Title string `json:"title"`
}

func capCommands(_ context.Context, env capEnv) (capDetail, error) {
	all := env.r.List(Context{}, true)
	js := CapabilityCommands{Count: len(all)}
	for _, c := range all { // sorted by category
		if n := len(js.Categories); n == 0 || js.Categories[n-1].Name != c.Category {
			js.Categories = append(js.Categories, CapabilityCategory{Name: c.Category})
		}
		cat := &js.Categories[len(js.Categories)-1]
		cat.Count++
		cat.Commands = append(cat.Commands, CapabilityCmd{Name: c.Name, Title: c.Title})
	}
	how := "`code-foundry commands` lists them with whether each is available here; `code-foundry help <command>` prints one's flags."
	var b strings.Builder
	fmt.Fprintf(&b, "commands: %d in %d categories. %s\n", js.Count, len(js.Categories), how)
	// One wrapped paragraph per category, so 180 commands fit in about a screen.
	for _, cat := range js.Categories {
		items := make([]string, len(cat.Commands))
		for i, c := range cat.Commands {
			items[i] = c.Name + " (" + c.Title + ")"
		}
		writeWrapped(&b, fmt.Sprintf("%s (%d): ", cat.Name, cat.Count), items, capWidth)
	}
	sum := fmt.Sprintf("commands in %d categories; every button, menu item and CLI verb is one", len(js.Categories))
	return capDetail{Count: count(js.Count), Summary: sum, Text: strings.TrimSuffix(b.String(), "\n"), JSON: js}, nil
}

// capWidth is where --group commands wraps.
const capWidth = 110

// writeWrapped writes head and then items joined by ", ", wrapping at width with
// continuation lines indented two spaces, and a newline.
func writeWrapped(b *strings.Builder, head string, items []string, width int) {
	line, onLine := head, 0
	for i, it := range items {
		if i < len(items)-1 {
			it += ","
		}
		if onLine > 0 && len(line)+1+len(it) > width {
			b.WriteString(line + "\n")
			line, onLine = " ", 0
		}
		if onLine > 0 || line == " " {
			line += " "
		}
		line += it
		onLine++
	}
	b.WriteString(line + "\n")
}

// CapabilityView is a page or panel surface and the verb that shows it.
type CapabilityView struct {
	Name        string `json:"name"`
	Command     string `json:"command"`
	Description string `json:"description"`
}

// notPages are the view.<name> verbs that act on a window rather than show a page.
var notPages = []string{ViewBack, ViewForward}

// pageCommands are the main-pane pages: the view.<name> verbs (one segment after view.)
// but those in notPages.
func pageCommands(r *Registry) []CapabilityView {
	var out []CapabilityView
	for _, c := range r.List(Context{}, true) {
		name, ok := strings.CutPrefix(c.Name, "view.")
		if !ok || strings.Contains(name, ".") || slices.Contains(notPages, name) {
			continue
		}
		out = append(out, CapabilityView{Name: name, Command: c.Name, Description: c.Description})
	}
	return out
}

// CapabilityViews is --group pages' JSON.
type CapabilityViews struct {
	Pages []CapabilityView `json:"pages"`
}

func capPages(_ context.Context, env capEnv) (capDetail, error) {
	pages := pageCommands(env.r)
	var b strings.Builder
	fmt.Fprintf(&b, "pages: %d. Each verb shows its page in every app window, moving what the user sees: run one only when asked.\n", len(pages))
	for _, p := range pages {
		fmt.Fprintf(&b, "  %-20s %s\n", p.Command, p.Description)
	}
	b.WriteString("Back and forward through what a window showed: view.back, view.forward.")
	return capDetail{Count: count(len(pages)), Text: b.String(), JSON: CapabilityViews{Pages: pages}}, nil
}

// panelActions are the view.panel.* verbs that change the panel rather than open a
// surface in it.
var panelActions = []string{ViewPanelToggle, ViewPanelExpand, ViewPanelNewTab, ViewPanelSplit}

// presenceRule is what a thread checks before it opens something in its own side panel
// (the help skill's "Showing things in the app").
const presenceRule = "Before opening one from a thread, run `code-foundry ui.presence --json`: open it only when `viewed` " +
	"is true and no remembered preference says not to, otherwise say it in your reply; never pass --focus unasked."

// CapabilityPanel is --group panel's JSON.
type CapabilityPanel struct {
	Surfaces       []CapabilityView `json:"surfaces"`
	PluginSurfaces []CapabilityView `json:"plugin_surfaces"`
	Actions        []string         `json:"actions"`
	Rule           string           `json:"rule"`
}

func capPanel(ctx context.Context, env capEnv) (capDetail, error) {
	js := CapabilityPanel{Surfaces: []CapabilityView{}, PluginSurfaces: []CapabilityView{}, Rule: presenceRule}
	for _, c := range env.r.List(Context{}, true) {
		name, ok := strings.CutPrefix(c.Name, "view.panel.")
		switch {
		case !ok:
		case slices.Contains(panelActions, "panel."+name):
			js.Actions = append(js.Actions, c.Name)
		default:
			// "Open the X surface in the selected thread's side panel: what it shows."
			_, what, found := strings.Cut(c.Description, ": ")
			if !found {
				what = c.Description
			}
			js.Surfaces = append(js.Surfaces, CapabilityView{Name: name, Command: c.Name, Description: what})
		}
	}
	plugins, err := listPlugins(ctx, env.d.Plugins)
	if err != nil {
		return capDetail{}, err
	}
	for _, p := range plugins {
		for _, s := range p.GetSurfaces() {
			js.PluginSurfaces = append(js.PluginSurfaces, CapabilityView{Name: s.GetKind(), Command: s.GetShowCommand(),
				Description: s.GetTitle() + " (" + s.GetScope() + " scope, from the plugin " + p.GetName() + ")"})
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "panel: %d surfaces. Each verb opens its surface in a thread's side panel: --thread (default: "+
		"the thread you run in) changes only that thread's panel, never what the user sees unless --focus.\n", len(js.Surfaces))
	for _, s := range js.Surfaces {
		fmt.Fprintf(&b, "  %-24s %s\n", s.Command, s.Description)
	}
	if len(js.PluginSurfaces) > 0 {
		b.WriteString("Plugin surfaces (their show verb acts on each window's selection, not a thread):\n")
		for _, s := range js.PluginSurfaces {
			fmt.Fprintf(&b, "  %-24s %s\n", s.Command, s.Description)
		}
	}
	if len(js.Actions) > 0 {
		fmt.Fprintf(&b, "Panel actions (they flip state you cannot see): %s.\n", strings.Join(js.Actions, ", "))
	}
	b.WriteString(presenceRule)
	n := len(js.Surfaces) + len(js.PluginSurfaces)
	sum := ""
	if len(js.PluginSurfaces) > 0 {
		sum = fmt.Sprintf("side panel surfaces (%d from plugins) and the verb that opens each in a thread", len(js.PluginSurfaces))
	}
	return capDetail{Count: count(n), Summary: sum, Text: b.String(), JSON: js}, nil
}

// CapabilityRendering is --group rendering's JSON.
type CapabilityRendering struct {
	Renderings []Rendering `json:"renderings"`
}

func capRendering(context.Context, capEnv) (capDetail, error) {
	var b strings.Builder
	b.WriteString("rendering: what the user sees of your replies and files in the app.\n")
	for _, r := range Renderings {
		fmt.Fprintf(&b, "  %-13s %s\n", r.Name, r.What)
	}
	return capDetail{Count: count(len(Renderings)), Text: strings.TrimSuffix(b.String(), "\n"), JSON: CapabilityRendering{Renderings: Renderings}}, nil
}

// CapabilitySkills is --group skills' JSON.
type CapabilitySkills struct {
	Shipped   []ShippedSkill        `json:"shipped"`
	Installed []CapabilityInstalled `json:"installed"`
	// InstalledError is why the installed ones could not be listed.
	InstalledError string `json:"installed_error,omitempty"`
}

// CapabilityInstalled is a skill or Claude Code plugin from the marketplace (or a local
// skill in ~/.claude/skills).
type CapabilityInstalled struct {
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Registry string `json:"registry,omitempty"`
	Enabled  bool   `json:"enabled"`
	Local    bool   `json:"local,omitempty"`
	Purpose  string `json:"purpose,omitempty"`
}

func capSkills(_ context.Context, env capEnv) (capDetail, error) {
	js := CapabilitySkills{Shipped: []ShippedSkill{}, Installed: []CapabilityInstalled{}}
	if env.d.Shipped != nil {
		js.Shipped = append(js.Shipped, env.d.Shipped()...)
	}
	if env.d.Skills != nil {
		if snap := env.d.Skills.Snapshot(); snap != nil {
			for _, in := range snap.Installed {
				if in.Missing {
					continue
				}
				js.Installed = append(js.Installed, CapabilityInstalled{Kind: string(in.Kind), Name: in.Name, Registry: in.Registry,
					Enabled: in.Enabled, Local: in.Local, Purpose: firstClause(in.Description)})
			}
			js.InstalledError = snap.PluginsErr
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "skills: %d every thread gets from Code Foundry (read the SKILL.md, or load it with the Skill tool):\n", len(js.Shipped))
	for _, s := range js.Shipped {
		fmt.Fprintf(&b, "  %-26s %s\n  %-26s %s\n", s.Name, s.Purpose, "", s.Path)
	}
	switch {
	case len(js.Installed) > 0:
		b.WriteString("Installed for Claude Code, from the marketplace or local in ~/.claude/skills (code-foundry skill.* verbs; Settings, Skills):\n")
		for _, in := range js.Installed {
			state := "enabled"
			if !in.Enabled {
				state = "disabled"
			}
			from := in.Registry
			if in.Local {
				from = "local"
			}
			fmt.Fprintf(&b, "  %s %s (%s, %s): %s\n", in.Kind, in.Name, from, state, in.Purpose)
		}
	default:
		b.WriteString("Installed for Claude Code: none (code-foundry skill browse lists them; Settings, Skills).\n")
	}
	if js.InstalledError != "" {
		fmt.Fprintf(&b, "Installed plugins could not be listed: %s\n", js.InstalledError)
	}
	sum := fmt.Sprintf("skills every thread gets, %d more installed for Claude Code", len(js.Installed))
	return capDetail{Count: count(len(js.Shipped)), Summary: sum, Text: strings.TrimSuffix(b.String(), "\n"), JSON: js}, nil
}

// firstClause is s up to its first ": " or ". ", for a one-line purpose.
func firstClause(s string) string {
	s = strings.TrimSpace(s)
	for _, sep := range []string{": ", ". "} {
		if i := strings.Index(s, sep); i >= 0 {
			s = s[:i]
		}
	}
	return strings.TrimSuffix(s, ".")
}

func listPlugins(ctx context.Context, l PluginLister) ([]*v1.Plugin, error) {
	if l == nil {
		return nil, nil
	}
	res, err := l.List(ctx, connect.NewRequest(&v1.ListPluginsRequest{}))
	if connect.CodeOf(err) == connect.CodeUnimplemented {
		return nil, nil // a daemon (or test) without the plugin store
	}
	if err != nil {
		return nil, fmt.Errorf("list plugins: %w", err)
	}
	return res.Msg.GetPlugins(), nil
}

// CapabilityPlugins is --group plugins' JSON.
type CapabilityPlugins struct {
	Plugins []CapabilityPlugin `json:"plugins"`
}

// CapabilityPlugin is one installed plugin.
type CapabilityPlugin struct {
	Name        string           `json:"name"`
	Version     string           `json:"version"`
	Enabled     bool             `json:"enabled"`
	State       string           `json:"state"`
	Description string           `json:"description,omitempty"`
	Commands    []CapabilityCmd  `json:"commands"`
	Surfaces    []CapabilityView `json:"surfaces"`
}

func capPlugins(ctx context.Context, env capEnv) (capDetail, error) {
	plugins, err := listPlugins(ctx, env.d.Plugins)
	if err != nil {
		return capDetail{}, err
	}
	js := CapabilityPlugins{Plugins: []CapabilityPlugin{}}
	var b strings.Builder
	fmt.Fprintf(&b, "plugins: %d installed. `code-foundry plugin list` shows their state, `plugin browse` the registries' plugins; "+
		"building one is the code-foundry-plugin skill.\n", len(plugins))
	for _, p := range plugins {
		cp := CapabilityPlugin{Name: p.GetName(), Version: p.GetVersion(), Enabled: p.GetEnabled(),
			State: pluginStateWord(p.GetState()), Description: p.GetDescription(), Commands: []CapabilityCmd{}, Surfaces: []CapabilityView{}}
		for _, c := range p.GetCommands() {
			cp.Commands = append(cp.Commands, CapabilityCmd{Name: c.GetName(), Title: c.GetTitle()})
		}
		for _, s := range p.GetSurfaces() {
			cp.Surfaces = append(cp.Surfaces, CapabilityView{Name: s.GetKind(), Command: s.GetShowCommand(), Description: s.GetTitle()})
		}
		js.Plugins = append(js.Plugins, cp)
		fmt.Fprintf(&b, "%s %s (%s): %s\n", cp.Name, cp.Version, cp.State, firstClause(cp.Description))
		var cmds, surfs []string
		for _, c := range cp.Commands {
			cmds = append(cmds, c.Name+" ("+c.Title+")")
		}
		for _, s := range cp.Surfaces {
			surfs = append(surfs, s.Description+" ("+s.Command+")")
		}
		if len(cmds) > 0 {
			fmt.Fprintf(&b, "  commands: %s\n", strings.Join(cmds, ", "))
		}
		if len(surfs) > 0 {
			fmt.Fprintf(&b, "  surfaces: %s\n", strings.Join(surfs, ", "))
		}
	}
	return capDetail{Count: count(len(plugins)), Text: strings.TrimSuffix(b.String(), "\n"), JSON: js}, nil
}

// pluginStateWord is a plugin's state in a word ("running"), "disabled" when it is off.
func pluginStateWord(s v1.PluginState) string {
	w := strings.ToLower(strings.TrimPrefix(s.String(), "PLUGIN_STATE_"))
	if w == "unspecified" {
		return "unknown"
	}
	return strings.ReplaceAll(w, "_", " ")
}

// CapabilitySettings is --group settings' JSON.
type CapabilitySettings struct {
	Count  int                    `json:"count"`
	Groups []CapabilitySettingSet `json:"groups"`
}

// CapabilitySettingSet is one settings group (a table of the file).
type CapabilitySettingSet struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Count       int    `json:"count"`
}

func capSettings(ctx context.Context, env capEnv) (capDetail, error) {
	if env.d.Settings == nil {
		return capDetail{}, errors.New("no settings")
	}
	res, err := env.d.Settings.GetSchema(ctx, connect.NewRequest(&v1.GetSettingsSchemaRequest{}))
	if err != nil {
		return capDetail{}, fmt.Errorf("settings schema: %w", err)
	}
	fields := res.Msg.GetFields()
	js := CapabilitySettings{Count: len(fields), Groups: []CapabilitySettingSet{}}
	for _, g := range res.Msg.GetGroups() {
		n := 0
		for _, f := range fields {
			if f.GetGroup() == g.GetId() {
				n++
			}
		}
		js.Groups = append(js.Groups, CapabilitySettingSet{ID: g.GetId(), Title: g.GetTitle(), Description: g.GetDescription(), Count: n})
	}
	var b strings.Builder
	fmt.Fprintf(&b, "settings: %d in %d groups. `code-foundry settings get --json` gives each one's value, title, description, "+
		"type and default; `settings set <key> <value>` changes one (the code-foundry-help skill's reference/settings.md "+
		"describes them all).\n", js.Count, len(js.Groups))
	for _, g := range js.Groups {
		fmt.Fprintf(&b, "  %-14s %3d  %s\n", g.ID, g.Count, cmp.Or(g.Description, g.Title))
	}
	sum := fmt.Sprintf("settings in %d groups; values with code-foundry settings get --json", len(js.Groups))
	return capDetail{Count: count(js.Count), Summary: sum, Text: strings.TrimSuffix(b.String(), "\n"), JSON: js}, nil
}

// CapabilityMemory is --group memory's JSON.
type CapabilityMemory struct {
	Count    int             `json:"count"`
	Commands []CapabilityCmd `json:"commands"`
}

func capMemory(_ context.Context, env capEnv) (capDetail, error) {
	js := CapabilityMemory{Commands: []CapabilityCmd{}}
	if env.d.Memory != nil {
		entries, err := env.d.Memory.Entries()
		if err != nil {
			return capDetail{}, fmt.Errorf("read the memory: %w", err)
		}
		js.Count = len(entries)
	}
	for _, c := range env.r.List(Context{}, true) {
		if strings.HasPrefix(c.Name, "memory.") {
			js.Commands = append(js.Commands, CapabilityCmd{Name: c.Name, Title: c.Title})
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "memory: %d standing preferences remembered. New threads get them in their system prompt, threads "+
		"already open with their next message after a restart; when to save one is the code-foundry-help skill's \"Remembering preferences\".\n", js.Count)
	for _, c := range js.Commands {
		fmt.Fprintf(&b, "  %-14s %s\n", c.Name, c.Title)
	}
	return capDetail{Count: count(js.Count), Text: strings.TrimSuffix(b.String(), "\n"), JSON: js}, nil
}

func capPresence(_ context.Context, env capEnv) (capDetail, error) {
	p := env.d.Presence
	var st presence.State
	if p.Presence != nil {
		st = p.Presence()
	}
	res := PresenceResult{State: st.String(), Attended: st.Attended, Thread: env.uctx.ActiveThreadID}
	if p.Windows != nil {
		res.Windows = p.Windows()
	}
	if res.Thread != "" && p.Viewed != nil {
		res.Viewed = p.Viewed(res.Thread)
	}
	text := formatPresence(st, res)
	sum, _, _ := strings.Cut(strings.TrimPrefix(text, "presence: "), "\n")
	return capDetail{Summary: sum, Text: text + "\nThe same as `code-foundry ui.presence`.", JSON: res}, nil
}
