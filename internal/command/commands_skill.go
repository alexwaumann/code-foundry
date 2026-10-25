package command

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/skill"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// skill.* (docs/notes/skills-2-lifecycle.md): the Skills marketplace. Browse searches
// the marketplaces Claude Code has; install, enable, disable, update and uninstall act
// on a marketplace plugin (through `claude plugin`) or a standalone skill (a directory
// in ~/.claude/skills); remove deletes a local skill; setup runs a skill's setup script
// in a bottom-panel terminal. The plugin.* commands (Code Foundry's own plugins) are
// another thing.

// SkillBackend is the skill store (*skill.Store) as the skill.* commands use it.
type SkillBackend interface {
	Snapshot() *skill.Snapshot
	Search(q marketplace.Query) marketplace.Result
	Refresh(ctx context.Context) error
	Install(ctx context.Context, name string, kind marketplace.Kind) (skill.Change, error)
	Enable(ctx context.Context, name string, kind marketplace.Kind) (skill.Change, error)
	Disable(ctx context.Context, name string, kind marketplace.Kind) (skill.Change, error)
	Update(ctx context.Context, name string, kind marketplace.Kind) ([]skill.Change, error)
	Updates(kind marketplace.Kind) []skill.Installed
	Uninstall(ctx context.Context, name string, kind marketplace.Kind) (skill.Change, error)
	Remove(ctx context.Context, name string) (skill.Change, error)
	Setup(ctx context.Context, name string) (skill.SetupPlan, error)
}

var _ SkillBackend = (*skill.Store)(nil)

// SkillDeps are the skill.* commands' dependencies. skill.setup starts its terminal
// through Terminal (as terminal.new does), owned by the context's thread (Thread) or
// worktree (Project).
type SkillDeps struct {
	Skills   SkillBackend
	Terminal TerminalBackend
	Project  ProjectBackend
	Thread   ThreadBackend
}

// RestartWarning is what disabling or uninstalling a plugin or skill means for threads.
const RestartWarning = "Threads that are running keep it until they restart. New threads pick this up at once."

// NoSkillOwner is how skill.setup refuses a context with no thread or project.
const NoSkillOwner = "select a thread or project first"

// RegisterSkill registers skill.browse, skill.install, skill.enable, skill.disable,
// skill.update, skill.uninstall, skill.remove, skill.setup and skill.refresh.
func RegisterSkill(r *Registry, d SkillDeps) error {
	if d.Skills == nil {
		d.Skills = noSkills{}
	}
	nameArg := ArgSpec{Name: "name", Type: String, Required: true, Positional: true,
		Description: "The plugin or skill's name (code-foundry skill browse); <name>@<marketplace> names a plugin"}
	kindArg := ArgSpec{Name: "kind", Type: Enum, Enum: []string{string(marketplace.KindPlugin), string(marketplace.KindSkill)},
		Description: "plugin or skill, when a plugin and a skill share the name"}
	kindOf := func(a Args) marketplace.Kind { return marketplace.Kind(a.String("kind")) }
	return r.RegisterAll(
		Command{
			Name:     "skill.browse",
			ReadOnly: true,
			Title:    "Browse Skills",
			Description: "Search the plugins and skills of the marketplaces Claude Code has (claude plugin marketplace list): " +
				"name, description, keywords and author, name matches first; no query lists them by name. " +
				"Shows what is installed and each marketplace's state.",
			Category:     "Skill",
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "query", Type: String, Positional: true, Description: "Words that must all match (case-insensitive)"},
				{Name: "tier", Type: Enum, Enum: []string{string(marketplace.TierEnterprise), string(marketplace.TierCommunity)}, Description: "Only this tier"},
				{Name: "kind", Type: Enum, Enum: []string{string(marketplace.KindPlugin), string(marketplace.KindSkill)}, Description: "Only plugins or only skills"},
				{Name: "limit", Type: Int, Default: "50", Description: "At most this many (up to 500)"},
				{Name: "refresh", Type: Bool, Description: "Update the marketplaces first (claude plugin marketplace update; network)"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				var refreshErr error
				if a.Bool("refresh") {
					refreshErr = d.Skills.Refresh(ctx)
				}
				res := d.Skills.Search(marketplace.Query{
					Text: a.String("query"), Tier: marketplace.Tier(a.String("tier")), Kind: kindOf(a), Limit: a.Int("limit"),
				})
				out := browseView(d.Skills.Snapshot(), res)
				if refreshErr != nil {
					out.RefreshError = refreshErr.Error()
				}
				return Result{Message: formatSkillBrowse(out), JSON: out}, nil
			},
		},
		Command{
			Name:  "skill.install",
			Title: "Install Skill",
			Description: "Install a marketplace plugin (claude plugin install <name>@<marketplace>) or copy a skill into " +
				"~/.claude/skills/<name>. A skill whose name is taken by a directory Code Foundry did not install is refused. " +
				"New threads pick it up at once.",
			Category: "Skill",
			Args:     []ArgSpec{nameArg, kindArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				ch, err := d.Skills.Install(ctx, a.String("name"), kindOf(a))
				if err != nil {
					return Result{}, skillErr(err)
				}
				return Result{Message: changeLine(ch), JSON: ch}, nil
			},
		},
		Command{
			Name:        "skill.enable",
			Title:       "Enable Skill",
			Description: "Enable an installed marketplace plugin (claude plugin enable), or move a disabled skill back into ~/.claude/skills.",
			Category:    "Skill",
			Args:        []ArgSpec{nameArg, kindArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				ch, err := d.Skills.Enable(ctx, a.String("name"), kindOf(a))
				if err != nil {
					return Result{}, skillErr(err)
				}
				return Result{Message: changeLine(ch), JSON: ch}, nil
			},
		},
		Command{
			Name:  "skill.disable",
			Title: "Disable Skill",
			Description: "Disable an installed marketplace plugin (claude plugin disable), or move a skill out of ~/.claude/skills " +
				"into Code Foundry's disabled skills (skill enable brings it back). " + RestartWarning,
			Category: "Skill",
			Args:     []ArgSpec{nameArg, kindArg},
			Confirm:  "Disable {name}? " + RestartWarning,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				ch, err := d.Skills.Disable(ctx, a.String("name"), kindOf(a))
				if err != nil {
					return Result{}, skillErr(err)
				}
				return Result{Message: changeLine(ch), JSON: ch}, nil
			},
		},
		Command{
			Name:  "skill.update",
			Title: "Update Skills",
			Description: "Update a plugin (claude plugin update) or a skill (copied again from its marketplace when that has a newer " +
				"commit; a disabled skill updates where it is), or every plugin and skill with an update; --check only lists them. " +
				"A skill's setup counts as done only while its setup script is unchanged.",
			Category: "Skill",
			Args: []ArgSpec{
				{Name: "name", Type: String, Positional: true, Description: "The plugin or skill (default: every one with an update)"},
				kindArg,
				{Name: "check", Type: Bool, Description: "Only list the updates"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if a.Bool("check") {
					ups := d.Skills.Updates(kindOf(a))
					if name := a.String("name"); name != "" {
						ups = filterInstalled(ups, name)
					}
					views := installedViews(ups)
					return Result{Message: formatSkillUpdates(views), JSON: views}, nil
				}
				chs, err := d.Skills.Update(ctx, a.String("name"), kindOf(a))
				if err != nil {
					return Result{}, skillErr(err)
				}
				if len(chs) == 0 {
					return Result{Message: "every plugin and skill is up to date", JSON: chs}, nil
				}
				lines := make([]string, len(chs))
				for i, ch := range chs {
					lines[i] = changeLine(ch)
				}
				return Result{Message: strings.Join(lines, "\n"), JSON: chs}, nil
			},
		},
		Command{
			Name:  "skill.uninstall",
			Title: "Uninstall Skill",
			Description: "Uninstall a marketplace plugin (claude plugin uninstall) or delete a skill Code Foundry installed (from " +
				"~/.claude/skills or the disabled skills) and its record. A local skill is deleted with skill remove. " + RestartWarning,
			Category: "Skill",
			Args:     []ArgSpec{nameArg, kindArg},
			Confirm:  "Uninstall {name}? " + RestartWarning,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				ch, err := d.Skills.Uninstall(ctx, a.String("name"), kindOf(a))
				if err != nil {
					return Result{}, skillErr(err)
				}
				return Result{Message: changeLine(ch), JSON: ch}, nil
			},
		},
		Command{
			Name:  "skill.remove",
			Title: "Remove Local Skill",
			Description: "Delete a local skill: a directory in ~/.claude/skills Code Foundry did not install (a symlink is removed, " +
				"not what it points at). " + RestartWarning,
			Category: "Skill",
			Args:     []ArgSpec{{Name: "name", Type: String, Required: true, Positional: true, Description: "The local skill's directory name"}},
			Confirm:  "Remove the local skill {name}? This deletes its directory. " + RestartWarning,
			DynamicConfirm: func(_ context.Context, _ Context, a Args) string {
				for _, in := range d.Skills.Snapshot().Installed {
					if in.Kind == marketplace.KindSkill && in.Local && in.Name == a.String("name") {
						return "Remove the local skill " + in.Name + "? This deletes " + in.Dir + ". " + RestartWarning
					}
				}
				return ""
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				ch, err := d.Skills.Remove(ctx, a.String("name"))
				if err != nil {
					return Result{}, skillErr(err)
				}
				return Result{Message: changeLine(ch), JSON: ch}, nil
			},
		},
		Command{
			Name:  "skill.setup",
			Title: "Run Skill Setup",
			Description: "Run a skill's setup script (/bin/sh <script> in the skill's directory) in a terminal in the bottom panel " +
				"of the active thread or worktree; when it exits 0 the skill no longer needs setup.",
			Category: "Skill",
			Args:     []ArgSpec{{Name: "name", Type: String, Required: true, Positional: true, Description: "The skill's name"}},
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				o, err := setupOwner(ctx, d, c)
				if err != nil {
					return Result{}, err
				}
				plan, err := d.Skills.Setup(ctx, a.String("name"))
				if err != nil {
					return Result{}, skillErr(err)
				}
				res, err := d.Terminal.Create(ctx, connect.NewRequest(&v1.CreateTerminalRequest{
					Argv: plan.Argv, Cwd: plan.Dir, Labels: termlabel.SetupTerminal(o.thread, o.project, o.worktree, plan.Name),
				}))
				if err != nil {
					return Result{}, err
				}
				t := res.Msg.GetTerminal()
				return Result{Message: fmt.Sprintf("running %s's setup (%s) in terminal %s", plan.Name, plan.Script, t.GetId()), JSON: t}, nil
			},
		},
		Command{
			Name:  "skill.refresh",
			Title: "Refresh Skill Marketplaces",
			Description: "Update every marketplace Claude Code has (claude plugin marketplace update) and read them again. " +
				"It also runs every hour.",
			Category: "Skill",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				err := d.Skills.Refresh(ctx)
				view := browseView(d.Skills.Snapshot(), marketplace.Result{})
				if err != nil && len(view.Registries) == 0 {
					return Result{}, Failed(err)
				}
				msg := formatRegistries(view)
				if err != nil {
					msg += "\nerror: " + err.Error()
				}
				return Result{Message: msg, JSON: view.Registries}, nil
			},
		},
	)
}

// setupOwner is who owns a setup terminal: the context's thread, else its worktree,
// else its project's main worktree. None is ErrInvalidArgs (NoSkillOwner).
func setupOwner(ctx context.Context, d SkillDeps, c Context) (owner, error) {
	switch {
	case c.ActiveThreadID != "" || c.ActiveWorktreePath != "":
		return shellOwner(ctx, d.Project, d.Thread, c, "", "", NoSkillOwner)
	case c.ActiveProjectID != "":
		res, err := d.Project.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{}))
		if err != nil {
			return owner{}, err
		}
		for _, p := range res.Msg.GetProjects() {
			if p.GetId() == c.ActiveProjectID {
				return owner{project: p.GetId(), worktree: p.GetPath(), cwd: p.GetPath()}, nil
			}
		}
		return owner{}, InvalidArg("context-project", "no project %s", c.ActiveProjectID)
	}
	return owner{}, InvalidArg("context-thread", "%s", NoSkillOwner)
}

// skillErr maps the store's refusals (not found, ambiguous, a name taken, a local skill,
// no setup script) to ErrInvalidArgs, and everything else (claude failing, the disk) to
// the command's own failure.
func skillErr(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	for _, refusal := range []error{skill.ErrNotFound, skill.ErrAmbiguous, skill.ErrCollision, skill.ErrLocal, skill.ErrNoSetup, skill.ErrInvalidName} {
		if errors.Is(err, refusal) {
			return InvalidArg("name", "%s", err)
		}
	}
	return Failed(err)
}

// changeLine is one Change for the CLI.
func changeLine(ch skill.Change) string {
	what := string(ch.Kind) + " " + ch.Name
	if ch.Kind == marketplace.KindPlugin && ch.Registry != "" {
		what = string(ch.Kind) + " " + skill.PluginID(ch.Name, ch.Registry)
	}
	version := ""
	if ch.Version != "" {
		version = " " + ch.Version
	}
	var line string
	switch {
	case ch.Error != "":
		return fmt.Sprintf("%s: update failed: %s", what, ch.Error)
	case ch.Unchanged && ch.Op == skill.OpInstall:
		line = what + version + " is installed already"
	case ch.Unchanged && ch.Op == skill.OpUpdate:
		line = what + version + " is up to date"
	case ch.Unchanged:
		line = what + " is " + pastOp(ch.Op) + " already"
	case ch.Op == skill.OpUpdate:
		line = fmt.Sprintf("updated %s %s → %s", what, cmp.Or(ch.PreviousVersion, "?"), cmp.Or(ch.Version, "?"))
	case ch.Op == skill.OpInstall:
		line = "installed " + what + version
		if ch.Registry != "" {
			line += " from " + ch.Registry
		}
	case ch.Op == skill.OpRemove:
		line = "removed local skill " + ch.Name
	default:
		line = pastOp(ch.Op) + " " + what
	}
	if ch.Kind == marketplace.KindSkill && ch.Dir != "" && !ch.Unchanged && ch.Op != skill.OpUninstall {
		line += " (" + ch.Dir + ")"
	}
	if ch.NeedsSetup {
		line += "\nit has a setup script (" + ch.SetupScript + "); run it in a terminal with: code-foundry skill setup " + ch.Name
	}
	return line
}

// pastOp is "enabled", "disabled", "uninstalled".
func pastOp(op skill.Op) string {
	if strings.HasSuffix(string(op), "e") {
		return string(op) + "d"
	}
	return string(op) + "ed"
}

// SkillBrowseView is skill.browse's JSON: one page of hits, the marketplaces, errors.
type SkillBrowseView struct {
	Total      int                 `json:"total"`
	Entries    []SkillEntryView    `json:"entries"`
	Registries []SkillRegistryView `json:"registries"`
	// Error is why the marketplaces could not be listed; RefreshError why --refresh failed.
	Error        string `json:"error,omitempty"`
	RefreshError string `json:"refreshError,omitempty"`
}

// SkillEntryView is a marketplace.Entry with what is installed of it.
type SkillEntryView struct {
	Kind            marketplace.Kind `json:"kind"`
	Tier            marketplace.Tier `json:"tier,omitempty"`
	Name            string           `json:"name"`
	Description     string           `json:"description,omitempty"`
	By              string           `json:"by,omitempty"`
	Version         string           `json:"version,omitempty"`
	DeclaredVersion string           `json:"declaredVersion,omitempty"`
	LastUpdated     *time.Time       `json:"lastUpdated,omitempty"`
	Registry        string           `json:"registry"`
	Path            string           `json:"path,omitempty"`
	Keywords        []string         `json:"keywords,omitempty"`
	Skills          []string         `json:"skills,omitempty"`
	SetupScript     string           `json:"setupScript,omitempty"`
	// Installed is "", "enabled" or "disabled"; InstalledVersion its version; Update the
	// version an update would bring.
	Installed        string `json:"installed,omitempty"`
	InstalledVersion string `json:"installedVersion,omitempty"`
	Update           string `json:"update,omitempty"`
}

// SkillRegistryView is a skill.Registry.
type SkillRegistryView struct {
	Name    string     `json:"name"`
	Repo    string     `json:"repo,omitempty"`
	Source  string     `json:"source,omitempty"`
	Dir     string     `json:"dir"`
	Owner   string     `json:"owner,omitempty"`
	Plugins int        `json:"plugins"`
	Skills  int        `json:"skills"`
	Shallow bool       `json:"shallow,omitempty"`
	ReadAt  *time.Time `json:"readAt,omitempty"`
	Error   string     `json:"error,omitempty"`
	Issues  []string   `json:"issues,omitempty"`
}

// SkillInstalledView is a skill.Installed for skill.update --check.
type SkillInstalledView struct {
	Kind     marketplace.Kind `json:"kind"`
	Name     string           `json:"name"`
	Registry string           `json:"registry,omitempty"`
	Version  string           `json:"version,omitempty"`
	Update   string           `json:"update,omitempty"`
	Enabled  bool             `json:"enabled"`
}

func timePtr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func browseView(snap *skill.Snapshot, res marketplace.Result) SkillBrowseView {
	out := SkillBrowseView{Total: res.Total, Entries: []SkillEntryView{}, Registries: []SkillRegistryView{}, Error: snap.Err}
	for _, e := range res.Entries {
		v := SkillEntryView{
			Kind: e.Kind, Tier: e.Tier, Name: e.Name, Description: e.Description, By: e.By, Version: e.Version,
			DeclaredVersion: e.DeclaredVersion, LastUpdated: timePtr(e.LastUpdated), Registry: e.Registry, Path: e.Path,
			Keywords: e.Keywords, Skills: e.Skills, SetupScript: e.SetupScript,
		}
		if in, ok := snap.InstalledOf(e); ok {
			v.Installed, v.InstalledVersion = "disabled", in.Version
			if in.Enabled {
				v.Installed = "enabled"
			}
			if in.Update != nil {
				v.Update = in.Update.Version
			}
		}
		out.Entries = append(out.Entries, v)
	}
	for _, r := range snap.Registries {
		out.Registries = append(out.Registries, SkillRegistryView{
			Name: r.Name, Repo: r.Repo, Source: r.Source, Dir: r.Dir, Owner: r.Owner, Plugins: r.Plugins, Skills: r.Skills,
			Shallow: r.Shallow, ReadAt: timePtr(r.ReadAt), Error: r.Err, Issues: r.Issues,
		})
	}
	return out
}

// noMarketplace is skill.browse's answer when Claude Code has no marketplace.
const noMarketplace = "Claude Code has no plugin marketplace; add your organisation's with: claude plugin marketplace add <owner>/<repo> " +
	"(for example the " + skill.ExpectedMarketplace + " repository)"

func formatSkillBrowse(v SkillBrowseView) string {
	var sb strings.Builder
	if len(v.Registries) == 0 {
		sb.WriteString(noMarketplace)
		if v.Error != "" {
			sb.WriteString("\nerror: " + v.Error)
		}
		return sb.String()
	}
	if len(v.Entries) == 0 {
		sb.WriteString("nothing matches\n")
	} else {
		tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
		_, _ = fmt.Fprintln(tw, "NAME\tKIND\tTIER\tVERSION\tINSTALLED\tBY\tDESCRIPTION")
		for _, e := range v.Entries {
			inst := cmp.Or(e.Installed, "-")
			if e.Update != "" {
				inst += " (update)"
			}
			kind := string(e.Kind)
			if len(e.Skills) > 0 {
				kind += " (" + countWord(len(e.Skills), "skill") + ")"
			}
			_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", e.Name, kind, cmp.Or(string(e.Tier), "-"), cmp.Or(e.Version, "-"),
				inst, cmp.Or(e.By, "-"), clipText(e.Description, 60))
		}
		_ = tw.Flush()
		lines := strings.Split(sb.String(), "\n")
		for i, l := range lines {
			lines[i] = strings.TrimRight(l, " ")
		}
		sb.Reset()
		sb.WriteString(strings.Join(lines, "\n"))
		if v.Total > len(v.Entries) {
			fmt.Fprintf(&sb, "%d of %d shown (--limit shows more)\n", len(v.Entries), v.Total)
		}
	}
	if v.RefreshError != "" {
		sb.WriteString("refresh failed: " + v.RefreshError + "\n")
	}
	sb.WriteString(formatRegistries(v))
	return strings.TrimRight(sb.String(), "\n")
}

func formatRegistries(v SkillBrowseView) string {
	if len(v.Registries) == 0 {
		return noMarketplace
	}
	var sb strings.Builder
	for _, r := range v.Registries {
		fmt.Fprintf(&sb, "marketplace %s", r.Name)
		if r.Repo != "" {
			fmt.Fprintf(&sb, " (%s)", r.Repo)
		}
		fmt.Fprintf(&sb, ": %d plugin(s), %d skill(s)", r.Plugins, r.Skills)
		if r.ReadAt != nil {
			sb.WriteString(", read " + r.ReadAt.Local().Format("2006-01-02 15:04"))
		}
		sb.WriteString("\n")
		if r.Error != "" {
			sb.WriteString("  error: " + r.Error + "\n")
		}
		for _, is := range r.Issues {
			sb.WriteString("  issue: " + is + "\n")
		}
	}
	if v.Error != "" {
		sb.WriteString("error: " + v.Error + "\n")
	}
	return strings.TrimRight(sb.String(), "\n")
}

// countWord is "1 skill", "2 skills".
func countWord(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func clipText(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-3]) + "..."
	}
	return s
}

func filterInstalled(l []skill.Installed, name string) []skill.Installed {
	var out []skill.Installed
	for _, in := range l {
		if in.Name == name || in.ID() == name {
			out = append(out, in)
		}
	}
	return out
}

func installedViews(l []skill.Installed) []SkillInstalledView {
	out := []SkillInstalledView{}
	for _, in := range l {
		v := SkillInstalledView{Kind: in.Kind, Name: in.Name, Registry: in.Registry, Version: in.Version, Enabled: in.Enabled}
		if in.Update != nil {
			v.Update = in.Update.Version
		}
		out = append(out, v)
	}
	return out
}

func formatSkillUpdates(l []SkillInstalledView) string {
	if len(l) == 0 {
		return "every plugin and skill is up to date"
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "NAME\tKIND\tINSTALLED\tAVAILABLE\tMARKETPLACE")
	for _, v := range l {
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", v.Name, v.Kind, cmp.Or(v.Version, "-"), v.Update, v.Registry)
	}
	_ = tw.Flush()
	sb.WriteString("install with: code-foundry skill update [<name>]")
	return sb.String()
}

// noSkills stands in for a missing skill store: every command fails Unimplemented.
type noSkills struct{}

var errNoSkills = connect.NewError(connect.CodeUnimplemented, errors.New("the skill store is not running"))

func (noSkills) Snapshot() *skill.Snapshot                   { return &skill.Snapshot{} }
func (noSkills) Search(marketplace.Query) marketplace.Result { return marketplace.Result{} }
func (noSkills) Refresh(context.Context) error               { return errNoSkills }
func (noSkills) Updates(marketplace.Kind) []skill.Installed  { return nil }
func (noSkills) Remove(context.Context, string) (skill.Change, error) {
	return skill.Change{}, errNoSkills
}
func (noSkills) Setup(context.Context, string) (skill.SetupPlan, error) {
	return skill.SetupPlan{}, errNoSkills
}
func (noSkills) Install(context.Context, string, marketplace.Kind) (skill.Change, error) {
	return skill.Change{}, errNoSkills
}
func (noSkills) Enable(context.Context, string, marketplace.Kind) (skill.Change, error) {
	return skill.Change{}, errNoSkills
}
func (noSkills) Disable(context.Context, string, marketplace.Kind) (skill.Change, error) {
	return skill.Change{}, errNoSkills
}
func (noSkills) Update(context.Context, string, marketplace.Kind) ([]skill.Change, error) {
	return nil, errNoSkills
}
func (noSkills) Uninstall(context.Context, string, marketplace.Kind) (skill.Change, error) {
	return skill.Change{}, errNoSkills
}
