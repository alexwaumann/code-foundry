package skills

import (
	"cmp"
	"fmt"
	"io"
	"io/fs"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"google.golang.org/protobuf/reflect/protoreflect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/guide"
	"github.com/alexwaumann/code-foundry/plugins"
	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// Plugin is the skill for building Code Foundry plugins (docs/notes/plugins-4-skill.md).
// Its SKILL.md and most references are static; the CLI and host command references are
// rendered from the registry, the example is plugins/examples/minimal, and a few
// values (the SDK commit to pin, the example's path, the host facts) are filled into the
// static files as placeholders.
const Plugin = "code-foundry-plugin"

// SDKModule is the plugin SDK's module path.
const SDKModule = "github.com/alexwaumann/code-foundry/pluginsdk"

// placeholder is a value filled into static skill files: {{cf.<name>}}.
var placeholder = regexp.MustCompile(`\{\{cf\.([A-Za-z]+)\}\}`)

// placeholders are the values Render fills in, by name.
func placeholders(src Sources) map[string]string {
	return map[string]string{
		"version":       src.Version,
		"sdkPin":        SDKPin(src.Commit, src.SDKTag),
		"example":       exampleDir(src.SkillsDir),
		"facts":         codeList(src.Facts),
		"reservedNames": codeList(pluginsdk.ReservedNames),
		"reservedArgs":  codeList(pluginsdk.ReservedArgNames),
		"eventSources":  codeList(pluginsdk.EventSources),
		"limits":        viewLimits(),
		"eventVariants": eventVariants(),
		"icons":         codeList(ui.Icons),
	}
}

// eventFields are the codefoundry.v1.Event fields of the manifest's event sources
// (pluginsdk.EventSources), where the name differs.
var eventFields = map[string]string{"threads": "thread_list"}

// eventStreamOnly are the changes of a source the event stream carries, where the
// message has more (the thread source's items and deltas are WatchThread's only).
var eventStreamOnly = map[string][]string{"thread": {"pending_snapshot", "pending"}}

// eventsCLISources are `code-foundry events --source` names, where they differ.
var eventsCLISources = map[string]string{"threads": "thread-list"}

// eventVariants is a table of each event source's JSON key and the changes it carries
// (its message's oneof), read from the generated protobuf descriptors.
func eventVariants() string {
	fields := (&v1.Event{}).ProtoReflect().Descriptor().Fields()
	var b strings.Builder
	b.WriteString("| Source (manifest) | `--source` | JSON key | Changes (the key inside) |\n|---|---|---|---|")
	for _, src := range pluginsdk.EventSources {
		name := cmp.Or(eventFields[src], src)
		f := fields.ByName(protoreflect.Name(name))
		if f == nil || f.Message() == nil {
			continue
		}
		var kinds []string
		oneof := f.Message().Oneofs()
		if oneof.Len() > 0 {
			of := oneof.Get(0).Fields()
			for i := range of.Len() {
				if only := eventStreamOnly[src]; only == nil || slices.Contains(only, string(of.Get(i).Name())) {
					kinds = append(kinds, "`"+of.Get(i).JSONName()+"`")
				}
			}
		}
		fmt.Fprintf(&b, "\n| `%s` | `%s` | `%s` | %s |", src, cmp.Or(eventsCLISources[src], src), f.JSONName(), strings.Join(kinds, ", "))
	}
	return b.String()
}

// codeList is "`a`, `b`, `c`".
func codeList(items []string) string {
	out := make([]string, len(items))
	for i, s := range items {
		out[i] = "`" + s + "`"
	}
	return strings.Join(out, ", ")
}

// viewLimits is a table of pluginsdk/ui's limits, which the host enforces.
func viewLimits() string {
	n := func(v ...int) string {
		out := make([]string, len(v))
		for i, x := range v {
			out[i] = fmt.Sprint(x)
		}
		return strings.Join(out, " / ")
	}
	rows := [][2]string{
		{"Elements in a view (nodes, rows, chips, pairs, fields, options, buttons, tabs)", n(ui.MaxElements)},
		{"Containers (section, columns, pane, grid, container) a node sits inside", n(ui.MaxDepth)},
		{"Columns in a columns node: least / most", n(ui.MinColumns, ui.MaxColumns)},
		{"Grid: items / least and most minWidth (px) / columns / an item's span", n(ui.MaxGridItems, ui.MinGridMinWidth, ui.MaxGridMinWidth, ui.MaxGridColumns, ui.MaxGridSpan)},
		{"Items in a group", n(ui.MaxGroupItems)},
		{"Spacer size: least / most (px)", n(ui.MinSpacer, ui.MaxSpacer)},
		{"A container's widest: narrow / wide (px)", n(ui.ContainerNarrowWidth, ui.ContainerWideWidth)},
		{"Nodes in the toolbar / in the footer", n(ui.MaxStripNodes, ui.MaxStripNodes)},
		{"Encoded view without log text (bytes)", n(ui.MaxViewBytes)},
		{"Log nodes per view", n(ui.MaxLogNodes)},
		{"Log text per render or per append (bytes)", n(ui.MaxLogText)},
		{"Tabs", n(ui.MaxTabs)},
		{"Header title / tab title / section title (characters)", n(ui.MaxHeaderTitle, ui.MaxTabTitle, ui.MaxSectionTitle)},
		{"Labels, row titles, one-line inline text (characters)", n(ui.MaxLabel)},
		{"Pair label / chip label (characters)", n(ui.MaxPairLabel, ui.MaxChipLabel)},
		{"Text content / markdown (bytes)", n(ui.MaxTextContent, ui.MaxMarkdown)},
		{"Notice detail / event data / copy text (bytes)", n(ui.MaxNoticeDetail, ui.MaxEventData, ui.MaxCopy)},
		{"Select options", n(ui.MaxOptions)},
		{"Buttons in a header / row / notice / section / empty state / actions bar", n(ui.MaxHeaderButtons, ui.MaxRowButtons, ui.MaxNoticeButtons, ui.MaxSectionButton, ui.MaxEmptyButtons, ui.MaxBarButtons)},
		{"A command action's args: count / names and values together (bytes) / one value (bytes)", n(ui.MaxCommandArgs, ui.MaxCommandArgsBytes, ui.MaxCommandArgValue)},
		{"An action's form values as the host gets them (bytes, encoded)", n(ui.MaxActValues)},
	}
	var b strings.Builder
	b.WriteString("| Limit | Value |\n|---|---|")
	for _, r := range rows {
		fmt.Fprintf(&b, "\n| %s | %s |", r[0], r[1])
	}
	return b.String()
}

// fill replaces the {{cf.<name>}} placeholders in b; an unknown name is an error.
func fill(p string, b []byte, values map[string]string) ([]byte, error) {
	var err error
	out := placeholder.ReplaceAllFunc(b, func(m []byte) []byte {
		v, ok := values[string(placeholder.FindSubmatch(m)[1])]
		if !ok {
			err = fmt.Errorf("skills: %s: unknown placeholder %s", p, m)
		}
		return []byte(v)
	})
	return out, err
}

var (
	commitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
	sdkTagPattern = regexp.MustCompile(`^pluginsdk/(v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))$`)
)

// SDKPin is what a plugin pins the SDK at with `go get <SDKModule>@<pin>`: the version
// of the pluginsdk/vX.Y.Z tag on the commit this build was made from (tag), else that
// commit (its SDK speaks this daemon's protocol exactly), or "main" for a build without
// a clean commit (a modified checkout, a test). A modified checkout ignores the tag too.
func SDKPin(commit, tag string) string {
	if !commitPattern.MatchString(commit) {
		return "main"
	}
	if m := sdkTagPattern.FindStringSubmatch(tag); m != nil {
		return m[1]
	}
	return commit
}

// exampleDir is where the installed example is, for the skill to copy from.
func exampleDir(skillsDir string) string {
	if skillsDir == "" {
		return "<this skill's directory>/example"
	}
	return filepath.Join(skillsDir, Plugin, "example")
}

// exampleReferences are the minimal example's files, as the skill's example/.
func exampleReferences() []reference {
	var out []reference
	_ = fs.WalkDir(plugins.Minimal, plugins.MinimalRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := plugins.Minimal.ReadFile(p)
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(p, plugins.MinimalRoot+"/")
		out = append(out, reference{path.Join(Plugin, "example", rel), func(w io.Writer, _ Sources) { _, _ = w.Write(b) }})
		return nil
	})
	return out
}

// pluginVerbOrder is the order of the plugin.* verbs in cli.md: the development loop
// first. Verbs not named here follow by name.
var pluginVerbOrder = []string{
	"plugin.dev", "plugin.list", "plugin.logs", "plugin.surface", "plugin.act", "plugin.restart",
	"plugin.reload", "plugin.enable", "plugin.disable", "plugin.env", "plugin.secrets.list", "plugin.secrets.delete",
}

// pluginHelpers are commands outside plugin.* a plugin author uses while debugging.
var pluginHelpers = []string{"thread.flags", "thread.flag.clear", "pr.checks"}

// isPluginVerb reports whether name is one of the host's plugin.* management verbs (not
// an installed plugin's plugin.<name>.<command>, whose name can never be a verb's).
func isPluginVerb(name string) bool {
	rest, ok := strings.CutPrefix(name, "plugin.")
	first, _, _ := strings.Cut(rest, ".")
	return ok && slices.Contains(pluginsdk.ReservedNames, first)
}

// pluginCLIReference renders the plugin verbs' and helpers' help texts.
func pluginCLIReference(w io.Writer, src Sources) {
	header(w, "The code-foundry CLI for plugin development", "commands", src.Version)
	fmt.Fprint(w, `
Every command below is the text `+"`code-foundry help <command>`"+` prints. Run one by its dotted name or
with spaces (`+"`code-foundry plugin.dev ...` = `code-foundry plugin dev ...`"+`); `+"`<arg>`"+` is positional and
every arg is also a `+"`--flag`"+`. A plugin's own commands are `+"`code-foundry plugin <name> <command>`"+`
(`+"`plugin.<name>.<command>`"+`; a dotted command name takes spaces too), and each surface adds
`+"`plugin <name> show <surface>`"+`, which opens it in the GUI (without a GUI it does nothing; use
`+"`plugin surface`"+`).

Every command also takes these flags:

`+"```"+`
`)
	guide.WriteCommonFlags(w)
	fmt.Fprint(w, "```\n")
	fmt.Fprint(w, `
Not in the registry, built into the CLI:

- `+"`code-foundry events --json --source <source>`"+` prints the daemon's events as JSON lines, the same JSON a
  plugin's OnEvent gets in `+"`Event.Event`"+`. The CLI's source names: `+"`thread-list`"+` (manifest `+"`threads`"+`),
  `+"`thread`, `project`, `workspace`, `gh`, `gitops`, `settings`, `update`, `action`, `plugin`"+`. It streams
  until killed: `+"`code-foundry events --json --source thread-list > /tmp/events.json & pid=$!; sleep 5; kill $pid`"+`.
- `+"`code-foundry commands --context-thread <id>`"+` lists every command with whether it is available there: your
  plugin's commands and `+"`show`"+` commands follow their `+"`when`"+` clauses.

Reading the output: an error your plugin returned prints as `+"`code-foundry: plugin.<name>.<command>: <message> (unknown)`"+`
(exit 1; "unknown" is the transport's code for a plugin's own error). `+"`plugin act`"+` prints only the view version
it acted on: run `+"`plugin surface`"+` again to see the result. `+"`plugin act`"+` sends events only; a command
button is run by the host, so exercise it with `+"`code-foundry plugin <name> <command>`"+`. `+"`plugin surface`"+` returns at
the first view (a surface that loads shows "Loading"): run it again a moment later. `+"`plugin surface --json`"+` carries the view as a JSON
string in `+"`view.viewJson`"+` (decode it twice, or use the text output).
`)
	var verbs, helpers []*v1.Command
	for _, c := range src.Commands {
		switch {
		case isPluginVerb(c.GetName()):
			verbs = append(verbs, c)
		case slices.Contains(pluginHelpers, c.GetName()):
			helpers = append(helpers, c)
		}
	}
	rank := func(c *v1.Command) int {
		if i := slices.Index(pluginVerbOrder, c.GetName()); i >= 0 {
			return i
		}
		return len(pluginVerbOrder)
	}
	slices.SortStableFunc(verbs, func(a, b *v1.Command) int {
		return cmp.Or(cmp.Compare(rank(a), rank(b)), cmp.Compare(a.GetName(), b.GetName()))
	})
	slices.SortFunc(helpers, func(a, b *v1.Command) int {
		return cmp.Compare(slices.Index(pluginHelpers, a.GetName()), slices.Index(pluginHelpers, b.GetName()))
	})
	for _, group := range []struct {
		title string
		cmds  []*v1.Command
	}{{"Plugins", verbs}, {"Flags and checks", helpers}} {
		fmt.Fprintf(w, "\n## %s\n", group.title)
		for _, c := range group.cmds {
			fmt.Fprintf(w, "\n### %s\n\n```\n", c.GetName())
			guide.WriteHelp(w, c, false)
			fmt.Fprint(w, "```\n")
		}
	}
}

// hostCommandsReference renders every command a plugin may ask the host to run.
func hostCommandsReference(w io.Writer, src Sources) {
	header(w, "Commands a plugin may run (host/invoke, command buttons)", "commands", src.Version)
	fmt.Fprint(w, `
A plugin runs these with `+"`Host.Invoke`"+` (or a view's command button) when its manifest's
`+"`permissions.commands`"+` globs match the name: `+"`*`"+` matches within one dotted segment, `+"`**`"+` across
segments (`+"`thread.send`, `view.open.*`, `action.**`"+`). The host's own `+"`plugin.*`"+` verbs are always refused.
Args travel as strings by name: the flag names `+"`code-foundry help <command>`"+` prints (booleans "true" or
"false"). Commands shown with `+"`--yes`"+` ask the user first: Invoke fails with -32003 and InvokeAsk hands
the question to the GUI. A plugin's own commands (`+"`plugin.<name>.<command>`"+`) need no permission in its
own views.
`)
	var cmds []*v1.Command
	cats := map[string]bool{}
	for _, c := range src.Commands {
		if !strings.HasPrefix(c.GetName(), "plugin.") {
			cmds = append(cmds, c)
			cats[c.GetCategory()] = true
		}
	}
	var list []guide.Category
	for _, c := range slices.Sorted(func(yield func(string) bool) {
		for c := range cats {
			if !yield(c) {
				return
			}
		}
	}) {
		list = append(list, guide.Category{Name: c})
	}
	guide.WriteCategories(w, cmds, list)
}
