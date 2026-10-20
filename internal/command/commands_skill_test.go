package command_test

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/skill"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace/marketplacetest"
	"github.com/alexwaumann/code-foundry/internal/store/skill/skilltest"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

type skillFixture struct {
	reg       *command.Registry
	store     *skill.Store
	claude    *skilltest.Claude
	term      *commandtest.Terminal
	skillsDir string
}

// newSkillFixture registers skill.* against a real skill store over the fixture
// marketplace and a fake claude (enterprise-data 1.4.0 installable).
func newSkillFixture(t *testing.T) skillFixture {
	t.Helper()
	f := skillFixture{reg: command.NewRegistry(), claude: skilltest.New(), term: &commandtest.Terminal{},
		skillsDir: filepath.Join(t.TempDir(), "skills")}
	f.claude.Set([]skilltest.Marketplace{{Name: "ai-marketplace", Source: "github", Repo: "acme/ai-marketplace", InstallLocation: marketplacetest.Checkout(t)}}, nil)
	f.claude.SetAvailable("enterprise-data@ai-marketplace", "1.4.0")
	s, err := skill.New(skill.Options{DB: dbtest.Open(t), Claude: f.claude, SkillsDir: f.skillsDir, DisabledDir: filepath.Join(t.TempDir(), "disabled"),
		Log: slog.New(slog.DiscardHandler), Now: func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) }})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.store = s
	project := &commandtest.Project{Projects: []*v1.Project{{Id: "p1", Path: "/src/app", Worktrees: []*v1.Worktree{{Path: "/src/app", IsMain: true}, {Path: "/src/app-wt"}}}}}
	thread := &commandtest.Thread{Current: &v1.Thread{ProjectId: "p1", WorktreePath: "/src/app-wt"}}
	if err := command.RegisterSkill(f.reg, command.SkillDeps{Skills: s, Terminal: f.term, Project: project, Thread: thread}); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f skillFixture) invoke(t *testing.T, c command.Context, name string, args map[string]string, yes bool) (command.Result, error) {
	t.Helper()
	return f.reg.Invoke(context.Background(), c, name, args, command.Confirmed(yes))
}

func TestSkillCommands(t *testing.T) {
	f := newSkillFixture(t)
	steps := []struct {
		name    string
		cmd     string
		args    map[string]string
		yes     bool
		wantErr error  // errors.Is
		wantMsg string // substring of the message or the error
	}{
		{name: "browse", cmd: "skill.browse", args: map[string]string{"query": "sql"},
			wantMsg: "NAME             KIND               TIER        VERSION   INSTALLED  BY             DESCRIPTION\n" +
				"sql-helper       skill              enterprise  20260110  -          Jane Doe       Write SQL for the warehouse.\n" +
				"enterprise-data  plugin (2 skills)  enterprise  1.4.0     -          Data Platform  Query the data warehouse and its catalog.\n" +
				"marketplace ai-marketplace (acme/ai-marketplace): 4 plugin(s), 3 skill(s), read"},
		{name: "browse filtered and limited", cmd: "skill.browse", args: map[string]string{"kind": "skill", "tier": "enterprise", "limit": "1"},
			wantMsg: "1 of 2 shown (--limit shows more)"},
		{name: "browse a bad tier", cmd: "skill.browse", args: map[string]string{"tier": "gold"}, wantErr: command.ErrInvalidArgs},
		{name: "install a skill", cmd: "skill.install", args: map[string]string{"name": "pr-review"},
			wantMsg: "installed skill pr-review 20260305 from ai-marketplace (" + filepath.Join(f.skillsDir, "pr-review") + ")\n" +
				"it has a setup script (install.sh); run it in a terminal with: code-foundry skill setup pr-review"},
		{name: "install it again", cmd: "skill.install", args: map[string]string{"name": "pr-review"}, wantMsg: "skill pr-review 20260305 is installed already"},
		{name: "install a plugin", cmd: "skill.install", args: map[string]string{"name": "enterprise-data"},
			wantMsg: "installed plugin enterprise-data@ai-marketplace 1.4.0 from ai-marketplace"},
		{name: "browse shows installed", cmd: "skill.browse", args: map[string]string{"query": "pr-review"}, wantMsg: "pr-review  skill  enterprise  20260305  enabled"},
		{name: "install unknown", cmd: "skill.install", args: map[string]string{"name": "nope"}, wantErr: command.ErrInvalidArgs, wantMsg: `no plugin or skill named "nope"`},
		{name: "install ambiguous", cmd: "skill.install", args: map[string]string{"name": "lint-kit"}, wantMsg: "lint-kit",
			wantErr: command.ErrInvalidArgs}, // only a plugin here: claude does not offer it
		{name: "disable asks", cmd: "skill.disable", args: map[string]string{"name": "pr-review"}, wantErr: command.ErrNeedsConfirmation,
			wantMsg: "Disable pr-review? Threads that are running keep it until they restart. New threads pick this up at once."},
		{name: "disable", cmd: "skill.disable", args: map[string]string{"name": "pr-review"}, yes: true, wantMsg: "disabled skill pr-review"},
		{name: "disable again", cmd: "skill.disable", args: map[string]string{"name": "pr-review"}, yes: true, wantMsg: "skill pr-review is disabled already"},
		{name: "enable", cmd: "skill.enable", args: map[string]string{"name": "pr-review"}, wantMsg: "enabled skill pr-review"},
		{name: "disable a plugin", cmd: "skill.disable", args: map[string]string{"name": "enterprise-data", "kind": "plugin"}, yes: true,
			wantMsg: "disabled plugin enterprise-data@ai-marketplace"},
		{name: "update check", cmd: "skill.update", args: map[string]string{"check": "true"}, wantMsg: "every plugin and skill is up to date"},
		{name: "update one", cmd: "skill.update", args: map[string]string{"name": "pr-review"}, wantMsg: "skill pr-review 20260305 is up to date"},
		{name: "update every", cmd: "skill.update", wantMsg: "every plugin and skill is up to date"},
		{name: "uninstall asks", cmd: "skill.uninstall", args: map[string]string{"name": "pr-review"}, wantErr: command.ErrNeedsConfirmation,
			wantMsg: "Uninstall pr-review? Threads that are running keep it until they restart."},
		{name: "uninstall", cmd: "skill.uninstall", args: map[string]string{"name": "pr-review"}, yes: true, wantMsg: "uninstalled skill pr-review"},
		{name: "uninstall a plugin", cmd: "skill.uninstall", args: map[string]string{"name": "enterprise-data@ai-marketplace"}, yes: true,
			wantMsg: "uninstalled plugin enterprise-data@ai-marketplace"},
		{name: "uninstall again", cmd: "skill.uninstall", args: map[string]string{"name": "enterprise-data"}, yes: true,
			wantErr: command.ErrInvalidArgs, wantMsg: `no installed plugin or skill named "enterprise-data"`},
		{name: "refresh", cmd: "skill.refresh", wantMsg: "marketplace ai-marketplace (acme/ai-marketplace): 4 plugin(s), 3 skill(s)"},
	}
	for _, st := range steps {
		res, err := f.invoke(t, command.Context{}, st.cmd, st.args, st.yes)
		if st.wantErr != nil {
			if !errors.Is(err, st.wantErr) || !strings.Contains(err.Error(), st.wantMsg) {
				t.Errorf("%s: err = %v, want %v containing %q", st.name, err, st.wantErr, st.wantMsg)
			}
			continue
		}
		if err != nil || !strings.Contains(res.Message, st.wantMsg) {
			t.Errorf("%s: %v\n got %q\nwant %q", st.name, err, res.Message, st.wantMsg)
		}
	}
}

func TestSkillCommandRefusals(t *testing.T) {
	f := newSkillFixture(t)
	for _, name := range []string{"lint-kit", "sql-helper"} {
		if err := os.MkdirAll(filepath.Join(f.skillsDir, name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(f.skillsDir, name, "SKILL.md"), []byte("---\nname: mine\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	f.claude.Set(f.claude.Marketplaces, []skilltest.Plugin{{ID: "lint-kit@ai-marketplace", Version: "0.2.1", Enabled: true}})
	if err := f.store.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		cmd     string
		args    map[string]string
		wantErr error
		failed  bool
		wantMsg string
	}{
		{"ambiguous", "skill.disable", map[string]string{"name": "lint-kit"}, command.ErrInvalidArgs, false,
			`"lint-kit" is both a plugin and a skill; choose one with --kind plugin or --kind skill`},
		{"local uninstall", "skill.uninstall", map[string]string{"name": "lint-kit", "kind": "skill"}, command.ErrInvalidArgs, false,
			"skill lint-kit is local (Code Foundry did not install it), so it cannot be uninstalled; remove deletes it"},
		{"local collision", "skill.install", map[string]string{"name": "sql-helper"}, command.ErrInvalidArgs, false,
			"already exists and Code Foundry did not install it"},
		{"claude refuses", "skill.install", map[string]string{"name": "lint-kit", "kind": "plugin"}, command.ErrInvalidArgs, false,
			`install plugin lint-kit@ai-marketplace: Plugin "lint-kit" not found in marketplace "ai-marketplace"`},
		{"claude fails", "skill.enable", map[string]string{"name": "lint-kit", "kind": "plugin"}, nil, true, "boom"},
		{"setup without a context", "skill.setup", map[string]string{"name": "lint-kit"}, command.ErrInvalidArgs, false, "select a thread or project first"},
	}
	f.claude.Fail("plugin enable", &skill.ClaudeError{Args: []string{"plugin", "enable"}, Msg: "boom"})
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := f.invoke(t, command.Context{}, tt.cmd, tt.args, true)
			if err == nil || (tt.wantErr != nil && !errors.Is(err, tt.wantErr)) || command.IsFailed(err) != tt.failed || !strings.Contains(err.Error(), tt.wantMsg) {
				t.Errorf("err = %v (failed %t), want %v containing %q", err, command.IsFailed(err), tt.wantErr, tt.wantMsg)
			}
		})
	}
}

func TestSkillSetupCommand(t *testing.T) {
	f := newSkillFixture(t)
	if _, err := f.invoke(t, command.Context{}, "skill.install", map[string]string{"name": "pr-review"}, false); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(f.skillsDir, "pr-review")
	tests := []struct {
		name       string
		ctx        command.Context
		wantLabels map[string]string
	}{
		{"thread", command.Context{ActiveThreadID: "s1"}, termlabel.SetupTerminal("s1", "p1", "/src/app-wt", "pr-review")},
		{"worktree", command.Context{ActiveProjectID: "p1", ActiveWorktreePath: "/src/app-wt"}, termlabel.SetupTerminal("", "p1", "/src/app-wt", "pr-review")},
		{"project", command.Context{ActiveProjectID: "p1"}, termlabel.SetupTerminal("", "p1", "/src/app", "pr-review")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := f.invoke(t, tt.ctx, "skill.setup", map[string]string{"name": "pr-review"}, false)
			if err != nil || res.Message != "running pr-review's setup (install.sh) in terminal t1" {
				t.Fatalf("setup = %q, %v", res.Message, err)
			}
			reqs := f.term.Requests()
			req, ok := reqs[len(reqs)-1].(*v1.CreateTerminalRequest)
			if !ok || req.GetCwd() != dir || strings.Join(req.GetArgv(), " ") != "/bin/sh install.sh" {
				t.Fatalf("create = %v", reqs[len(reqs)-1])
			}
			for k, v := range tt.wantLabels {
				if req.GetLabels()[k] != v {
					t.Errorf("label %s = %q, want %q (all %v)", k, req.GetLabels()[k], v, req.GetLabels())
				}
			}
			if len(req.GetLabels()) != len(tt.wantLabels) {
				t.Errorf("labels = %v, want %v", req.GetLabels(), tt.wantLabels)
			}
		})
	}
	for _, tt := range []struct {
		name, skill, want string
	}{
		{"no script", "haiku-writer", "has no setup script"},
		{"unknown", "nope", `no installed skill named "nope"`},
	} {
		if tt.name == "no script" {
			if _, err := f.invoke(t, command.Context{}, "skill.install", map[string]string{"name": tt.skill}, false); err != nil {
				t.Fatal(err)
			}
		}
		_, err := f.invoke(t, command.Context{ActiveThreadID: "s1"}, "skill.setup", map[string]string{"name": tt.skill}, false)
		if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%s: %v", tt.name, err)
		}
	}
}

// Without a skill store the commands list but fail.
func TestSkillCommandsWithoutStore(t *testing.T) {
	r := command.NewRegistry()
	if err := command.RegisterSkill(r, command.SkillDeps{}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Invoke(context.Background(), command.Context{}, "skill.install", map[string]string{"name": "x"}); err == nil {
		t.Error("install without a store succeeded")
	}
	res, err := r.Invoke(context.Background(), command.Context{}, "skill.browse", nil)
	if err != nil || !strings.Contains(res.Message, "Claude Code has no plugin marketplace; add your organisation's with: claude plugin marketplace add <owner>/<repo> (for example the ai-marketplace repository)") {
		t.Errorf("browse = %q, %v", res.Message, err)
	}
}
