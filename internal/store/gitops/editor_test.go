package gitops

import (
	"errors"
	"os/exec"
	"slices"
	"testing"
)

func fakeEditorEnv(env map[string]string, onPath []string, apps []string) editorEnv {
	return editorEnv{
		getenv: func(k string) string { return env[k] },
		lookPath: func(name string) (string, error) {
			if slices.Contains(onPath, name) {
				return "/bin/" + name, nil
			}
			return "", exec.ErrNotFound
		},
		exists: func(p string) bool { return slices.Contains(apps, p) },
	}
}

func TestResolveEditor(t *testing.T) {
	const wt = "/w/my repo"
	tests := []struct {
		name       string
		configured string
		env        map[string]string
		onPath     []string
		apps       []string
		want       []string
		wantErr    error
	}{
		{"configured, path appended", "code -n", nil, []string{"code"}, nil, []string{"/bin/code", "-n", wt}, nil},
		{"configured with placeholder", "open -a 'Zed Preview' {path}", nil, nil, nil, []string{"open", "-a", "Zed Preview", wt}, nil},
		{"configured absolute", "/opt/x/ed --flag", nil, []string{"ed"}, nil, []string{"/opt/x/ed", "--flag", wt}, nil},
		{"configured not found stays a name", "subl", nil, nil, nil, []string{"subl", wt}, nil},
		{"configured bad quoting", "code 'oops", nil, nil, nil, nil, ErrInvalidArgument},
		{"VISUAL gui editor", "", map[string]string{"VISUAL": "zed --wait", "EDITOR": "vim"}, []string{"zed", "code"}, nil, []string{"/bin/zed", "--wait", wt}, nil},
		{"EDITOR terminal editor ignored", "", map[string]string{"EDITOR": "vim"}, []string{"vim", "code"}, nil, []string{"/bin/code", wt}, nil},
		{"cursor preferred over code", "", nil, []string{"code", "cursor"}, nil, []string{"/bin/cursor", wt}, nil},
		{"app bundle fallback", "", nil, nil, []string{"/Applications/Visual Studio Code.app"}, []string{"/usr/bin/open", "-a", "Visual Studio Code", wt}, nil},
		{"nothing", "", map[string]string{"EDITOR": "nano"}, nil, nil, nil, errNoEditor},
		{"blank setting means detect", "   ", nil, []string{"zed"}, nil, []string{"/bin/zed", wt}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveEditor(tt.configured, wt, fakeEditorEnv(tt.env, tt.onPath, tt.apps))
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("argv = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSplitWords(t *testing.T) {
	tests := []struct {
		in   string
		want []string
		err  bool
	}{
		{"code", []string{"code"}, false},
		{"  code   -n  ", []string{"code", "-n"}, false},
		{`open -a "Visual Studio Code"`, []string{"open", "-a", "Visual Studio Code"}, false},
		{`a\ b 'c d' "e \"f\""`, []string{"a b", "c d", `e "f"`}, false},
		{`x''y`, []string{"xy"}, false},
		{"", nil, false},
		{`"open`, nil, true},
		{`'open`, nil, true},
	}
	for _, tt := range tests {
		got, err := splitWords(tt.in)
		if (err != nil) != tt.err {
			t.Errorf("splitWords(%q) err = %v, want err %v", tt.in, err, tt.err)
			continue
		}
		if !slices.Equal(got, tt.want) {
			t.Errorf("splitWords(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
