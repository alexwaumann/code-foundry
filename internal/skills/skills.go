// Package skills renders and installs the Claude Code skills the daemon ships to every
// thread: code-foundry-orchestrate (delegating work to other threads),
// code-foundry-help (how-to questions about the app) and code-foundry-plugin (building
// plugins). Their SKILL.md files and the worked examples are static (files/, embedded);
// their command and settings references are rendered from the daemon's own registry and
// settings schema at every start (internal/guide), so they never drift from the build
// that serves them. Nothing in a skill runs a shell command when it loads (managed
// settings may forbid it): whatever is dynamic is rendered here, including the
// {{cf.<name>}} placeholders of static files (plugin.go). See
// docs/notes/agent-skills.md and docs/notes/plugins-4-skill.md.
package skills

import (
	"bytes"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"strings"

	"github.com/alexwaumann/code-foundry/docs"
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/guide"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// The skills' names (their directories under .claude/skills).
const (
	Orchestrate = "code-foundry-orchestrate"
	Help        = "code-foundry-help"
	// Ember is the resident agent's own skill: only Ember's skills directory gets it
	// (EmberFiles), never every thread's (Render leaves it out).
	Ember = "code-foundry-ember"
)

//go:embed files
var static embed.FS

// staticRoot is static's directory holding one directory per skill.
const staticRoot = "files"

// Sources is what the rendered references are made from.
type Sources struct {
	// Version is the daemon's version (version.Info.Version), named with Commit in every
	// file's provenance line.
	Version string
	// Commands are the registry's commands as CommandService.List answers them with
	// unavailable ones included.
	Commands []*v1.Command
	// SettingGroups and Settings are SettingsService.GetSchema's groups and fields.
	SettingGroups []*v1.SettingGroup
	Settings      []*v1.SettingField
	// Commit is the commit the daemon was built from (version.Info.Commit, maybe with
	// "-dirty"): the plugin SDK version the plugin skill pins, and with Version where
	// every file says its source is.
	Commit string
	// SDKTag is the pluginsdk/vX.Y.Z tag on Commit (version.Info.PluginSDKTag, "" for
	// none): when set the skill pins that version instead of the commit.
	SDKTag string
	// SkillsDir is where Install puts the skills (<dir>/.claude/skills), for paths the
	// skills name; empty when unknown.
	SkillsDir string
	// Facts are the host facts plugins' when clauses read (plugin.HostFactNames).
	Facts []string
}

// Provenance is the line every skill file carries under its title: the build that
// rendered it and the URL of its source at that build (version.Info.Provenance), so a
// thread can read the real source at the right revision. Static files place it with
// {{cf.provenance}}; rendered references get it from header.
func (s Sources) Provenance() string {
	return version.Info{Version: s.Version, Commit: s.Commit}.Provenance()
}

// Files maps a path relative to the skills directory ("code-foundry-help/SKILL.md",
// slash-separated) to its content.
type Files map[string][]byte

// reference is one rendered file of a skill.
type reference struct {
	path   string
	render func(w io.Writer, src Sources)
}

// references are the rendered files, beside the static ones. A new reference is a new
// entry here.
var references = []reference{
	{Orchestrate + "/reference/commands.md", commandsReference(
		"Commands for orchestrating threads",
		[]guide.Category{{Name: "Thread", Detailed: true}, {Name: "Action"}, {Name: "Workspace"}, {Name: "Project"}})},
	{Help + "/reference/commands.md", commandsReference(
		"Commands for projects, settings, threads, pull requests and actions",
		[]guide.Category{{Name: "Project"}, {Name: "Settings", Detailed: true}, {Name: "Thread"}, {Name: "Pull Request"}, {Name: "Action"}})},
	{Help + "/reference/settings.md", settingsReference},
	{Help + "/reference/getting-started.md", func(w io.Writer, src Sources) {
		_, _ = w.Write(underTitle(docs.GettingStarted, src.Provenance()))
	}},
	{Plugin + "/reference/cli.md", pluginCLIReference},
	{Plugin + "/reference/host-commands.md", hostCommandsReference},
}

func init() { references = append(references, exampleReferences()...) }

// Render returns every file of every skill: the static ones, with their placeholders
// filled from src, and the references rendered from src.
func Render(src Sources) (Files, error) {
	out := Files{}
	values := placeholders(src)
	err := fs.WalkDir(static, staticRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := static.ReadFile(p)
		if err != nil {
			return fmt.Errorf("read embedded %s: %w", p, err)
		}
		rel := p[len(staticRoot)+1:]
		if strings.HasPrefix(rel, Ember+"/") {
			return nil // Ember's own (EmberFiles)
		}
		if out[rel], err = fill(rel, b, values); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("skills: %w", err)
	}
	for _, r := range references {
		if _, dup := out[r.path]; dup {
			return nil, fmt.Errorf("skills: %s is both static and rendered", r.path)
		}
		var buf bytes.Buffer
		r.render(&buf, src)
		out[r.path] = buf.Bytes()
	}
	return out, nil
}

// EmberFiles returns the files of Ember's own skill (static, placeholders filled from
// src), for its skills directory (internal/store/ember; Install writes them).
func EmberFiles(src Sources) (Files, error) {
	out := Files{}
	values := placeholders(src)
	err := fs.WalkDir(static, staticRoot+"/"+Ember, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := static.ReadFile(p)
		if err != nil {
			return fmt.Errorf("read embedded %s: %w", p, err)
		}
		rel := p[len(staticRoot)+1:]
		out[rel], err = fill(rel, b, values)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("skills: %w", err)
	}
	return out, nil
}

// header starts a rendered reference: its title, the provenance line and what it was
// made from.
func header(w io.Writer, title, from string, src Sources) {
	fmt.Fprintf(w, "# %s\n\n%s\n\n", title, src.Provenance())
	fmt.Fprintf(w, "Generated by the code-foundry daemon at its start from its %s, so it matches the running app.\n", from)
}

// underTitle puts line under b's leading "# " title (at the top when b has none), for a
// reference copied from a repo file.
func underTitle(b []byte, line string) []byte {
	title, rest, ok := bytes.Cut(b, []byte("\n"))
	if !ok || !bytes.HasPrefix(title, []byte("# ")) {
		return append([]byte(line+"\n\n"), b...)
	}
	out := append(append([]byte{}, title...), "\n\n"+line+"\n"...)
	if !bytes.HasPrefix(rest, []byte("\n")) {
		out = append(out, '\n')
	}
	return append(out, rest...)
}

// commandsReference renders cats of src.Commands in the CLI guide's format.
func commandsReference(title string, cats []guide.Category) func(io.Writer, Sources) {
	return func(w io.Writer, src Sources) {
		header(w, title, "commands", src)
		fmt.Fprint(w, `
How to read it:

- Run a command by its dotted name or with spaces: `+"`code-foundry thread.new ...` = `code-foundry thread new ...`"+`.
  `+"`<arg>`"+` is positional; every other arg is a `+"`--flag`"+`.
- `+"`[--id]`"+`: the thread the command acts on, by default your own (`+"`$CODE_FOUNDRY_THREAD`"+`). Ids take a unique
  suffix of 4+ characters.
- `+"`--yes`"+`: the command may ask for confirmation, and without it then exits 2 and does nothing.
- Every command takes `+"`--json`"+`. `+"`code-foundry help <command>`"+` prints every flag of one command.
`)
		guide.WriteCategories(w, src.Commands, cats)
	}
}

// settingsReference renders every setting of src.
func settingsReference(w io.Writer, src Sources) {
	header(w, "Settings", "settings schema", src)
	fmt.Fprint(w, `
Read a value with `+"`code-foundry settings get <key>`"+`, change it with `+"`code-foundry settings set <key> <value>`"+`
(validated against the type below), return it to the default with `+"`code-foundry settings reset <key>`"+`.
Never edit the settings file by hand. The Settings page (⌘,) shows the same settings.
`)
	guide.WriteSettings(w, src.SettingGroups, src.Settings)
}
