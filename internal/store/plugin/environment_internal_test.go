package plugin

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

func TestValidateEnvironment(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	// A link under home to a directory outside it is outside.
	escape := filepath.Join(home, "escape")
	if err := os.Symlink(outside, escape); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		in         pluginsdk.Environment
		wantEnv    []string
		wantPath   []string
		wantDirs   []string
		wantIssues []string
	}{
		{name: "plain", in: pluginsdk.Environment{Env: map[string]string{"CF_HELLO": "1", "B_TOKEN_FILE": "~/x"}},
			wantEnv: []string{"B_TOKEN_FILE=~/x", "CF_HELLO=1"}},
		{name: "reserved keys", in: pluginsdk.Environment{Env: map[string]string{
			"PATH": "/x", "HOME": "/x", "CODE_FOUNDRY_TOKEN": "x", "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDECODE": "1",
			"CLAUDE_CONFIG_DIR": "/x", "CLAUDE_EFFORT": "max", "SHELL": "x", "USER": "x", "TMPDIR": "x", "OK": "1"}},
			wantEnv: []string{"OK=1"},
			wantIssues: []string{"env CLAUDECODE is reserved", "env CLAUDE_CODE_USE_BEDROCK is reserved", "env CLAUDE_CONFIG_DIR is reserved",
				"env CLAUDE_EFFORT is reserved", "env CODE_FOUNDRY_TOKEN is reserved", "env HOME is reserved", "env PATH is reserved",
				"env SHELL is reserved", "env TMPDIR is reserved", "env USER is reserved"}},
		{name: "reserved keys in any case", in: pluginsdk.Environment{Env: map[string]string{
			"path": "/x", "Path": "/x", "home": "/x", "code_foundry_token": "x", "Claude_Code_X": "1", "node_options": "x", "PATH_EXTRA": "ok"}},
			wantEnv: []string{"PATH_EXTRA=ok"},
			wantIssues: []string{"env Claude_Code_X is reserved", "env Path is reserved", "env code_foundry_token is reserved",
				"env home is reserved", "env node_options is reserved: it loads code", "env path is reserved"}},
		{name: "a link out of home", in: pluginsdk.Environment{PathPrepend: []string{escape}, AddDirs: []string{escape}},
			wantIssues: []string{"pathPrepend " + escape + " is outside your home directory", "addDirs " + escape + " is outside your home directory"}},
		{name: "keys that load code", in: pluginsdk.Environment{Env: map[string]string{
			"DYLD_INSERT_LIBRARIES": "/x.dylib", "LD_PRELOAD": "/x.so", "NODE_OPTIONS": "--require /x.js", "PYTHONPATH": "/x",
			"PERL5OPT": "-Mx", "RUBYOPT": "-rx", "BASH_ENV": "/x", "ENV": "/x", "ZDOTDIR": "/x", "SSH_ASKPASS": "/x",
			"ANTHROPIC_BASE_URL": "https://gw.example", "AWS_PROFILE": "work", "LDFLAGS": "-L/x", "ENVIRONMENT": "prod"}},
			wantEnv: []string{"ANTHROPIC_BASE_URL=https://gw.example", "AWS_PROFILE=work", "ENVIRONMENT=prod", "LDFLAGS=-L/x"},
			wantIssues: []string{"env BASH_ENV is reserved: it loads code", "env DYLD_INSERT_LIBRARIES is reserved: it loads code",
				"env ENV is reserved: it loads code", "env LD_PRELOAD is reserved: it loads code", "env NODE_OPTIONS is reserved: it loads code",
				"env PERL5OPT is reserved: it loads code", "env PYTHONPATH is reserved: it loads code", "env RUBYOPT is reserved: it loads code",
				"env SSH_ASKPASS is reserved: it loads code", "env ZDOTDIR is reserved: it loads code"}},
		{name: "bad names and values", in: pluginsdk.Environment{Env: map[string]string{
			"1X": "a", "A-B": "a", "BIG": strings.Repeat("x", MaxEnvValue+1), "NUL": "a\x00b", "MAX": strings.Repeat("x", MaxEnvValue)}},
			wantEnv:    []string{"MAX=" + strings.Repeat("x", MaxEnvValue)},
			wantIssues: []string{`env "1X" is not a variable name`, `env "A-B" is not a variable name`, "env BIG is 8193 bytes; at most 8192", "env NUL is not text"}},
		{name: "dirs", in: pluginsdk.Environment{
			PathPrepend: []string{"~/bin", "relative", outside, dir, "~/bin"},
			AddDirs:     []string{"~/data", "~/missing", outside, "/a:b"}},
			wantPath: []string{filepath.Join(home, "bin"), dir},
			wantDirs: []string{dir},
			wantIssues: []string{`pathPrepend "relative" is not an absolute path`, "pathPrepend " + outside + " is outside your home directory",
				"addDirs " + filepath.Join(home, "missing") + " is not a directory", "addDirs " + outside + " is outside your home directory",
				`addDirs "/a:b" has a character a path list cannot hold`}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, issues := validateEnvironment("p", tt.in, home)
			var env []string
			for k, v := range e.Env {
				env = append(env, k+"="+v)
			}
			slices.Sort(env)
			if !slices.Equal(env, tt.wantEnv) || !slices.Equal(e.PathPrepend, tt.wantPath) || !slices.Equal(e.AddDirs, tt.wantDirs) {
				t.Errorf("env %q path %q dirs %q, want %q %q %q", env, e.PathPrepend, e.AddDirs, tt.wantEnv, tt.wantPath, tt.wantDirs)
			}
			if len(issues) != len(tt.wantIssues) {
				t.Fatalf("issues = %q, want %q", issues, tt.wantIssues)
			}
			for i, want := range tt.wantIssues {
				if !strings.HasPrefix(issues[i], want) {
					t.Errorf("issue %d = %q, want it to start %q", i, issues[i], want)
				}
			}
		})
	}
	// A cap on how many variables.
	many := map[string]string{}
	for i := range maxEnvKeys + 3 {
		many["K"+strings.Repeat("A", i)] = "1"
	}
	e, issues := validateEnvironment("p", pluginsdk.Environment{Env: many}, home)
	if len(e.Env) != maxEnvKeys || len(issues) != 3 {
		t.Errorf("%d keys, %d issues", len(e.Env), len(issues))
	}
}

// Plugins apply in name order: a later plugin loses a key an earlier one sets, and says so.
func TestResolveConflicts(t *testing.T) {
	envs := []Environment{
		{Plugin: "alpha", Env: map[string]string{"SHARED": "a", "ONLY_A": "1"}},
		{Plugin: "beta", Env: map[string]string{"SHARED": "b", "ONLY_B": "1"}, Issues: []string{"earlier issue"}},
		{Plugin: "gamma", Env: map[string]string{"SHARED": "g"}},
	}
	got := resolve(envs)
	if got[0].Env["SHARED"] != "a" || len(got[0].Issues) != 0 {
		t.Errorf("alpha = %+v", got[0])
	}
	if _, ok := got[1].Env["SHARED"]; ok || got[1].Env["ONLY_B"] != "1" ||
		!slices.Equal(got[1].Issues, []string{"earlier issue", "env SHARED is also set by plugin alpha, which applies first (plugins apply in name order)"}) {
		t.Errorf("beta = %+v", got[1])
	}
	if len(got[2].Env) != 0 || len(got[2].Issues) != 1 || !strings.Contains(got[2].Issues[0], "plugin alpha") {
		t.Errorf("gamma = %+v", got[2])
	}
	if envs[1].Env["SHARED"] != "b" {
		t.Error("resolve changed its input")
	}
}

func TestEnvironmentScope(t *testing.T) {
	tests := []struct {
		name  string
		e     Environment
		scope SpawnScope
		want  bool
	}{
		{"every project", Environment{}, SpawnScope{ProjectID: "p1"}, true},
		{"not home threads by default", Environment{}, SpawnScope{NoProject: true}, false},
		{"home threads asked for", Environment{NoProject: true}, SpawnScope{NoProject: true}, true},
		{"listed project", Environment{Projects: []string{"p1"}}, SpawnScope{ProjectID: "p1"}, true},
		{"other project", Environment{Projects: []string{"p1"}}, SpawnScope{ProjectID: "p2"}, false},
		{"a workspace member", Environment{Projects: []string{"p3"}}, SpawnScope{ProjectID: "p2", MemberProjectIDs: []string{"p2", "p3"}}, true},
		{"no workspace member", Environment{Projects: []string{"p4"}}, SpawnScope{ProjectID: "p2", MemberProjectIDs: []string{"p2", "p3"}}, false},
		{"projects only, home thread", Environment{Projects: []string{"p1"}}, SpawnScope{NoProject: true}, false},
	}
	for _, tt := range tests {
		if got := tt.e.matches(tt.scope); got != tt.want {
			t.Errorf("%s: matches = %v, want %v", tt.name, got, tt.want)
		}
	}
}
