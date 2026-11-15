package scripts

import (
	"bufio"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// frontendPhaseRuns runs check-scope.sh over a branch's changed paths and reports
// whether it asks for the frontend phase.
func frontendPhaseRuns(t *testing.T, env []string, changed ...string) bool {
	t.Helper()
	script, err := filepath.Abs("check-scope.sh")
	if err != nil {
		t.Fatal(err)
	}
	list := filepath.Join(t.TempDir(), "changed")
	body := ""
	if len(changed) > 0 {
		body = strings.Join(changed, "\n") + "\n"
	}
	if err := os.WriteFile(list, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/bash", script, "frontend", "--files", list)
	cmd.Env = append(os.Environ(), env...)
	err = cmd.Run()
	if err == nil {
		return true
	}
	if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
		return false
	}
	t.Fatalf("check-scope.sh: %v", err)
	return false
}

func TestCheckScopeFrontend(t *testing.T) {
	tests := []struct {
		name    string
		changed []string
		env     []string
		run     bool
	}{
		{"a Go store only", []string{"internal/store/thread/manager.go", "internal/store/thread/manager_test.go"}, nil, false},
		{"a note only", []string{"docs/notes/check-scope.md"}, nil, false},
		{"go.mod", []string{"go.mod", "go.sum"}, nil, false},
		{"a frontend file", []string{"gui/frontend/src/lib/thread.ts"}, nil, true},
		{"a frontend file among Go files", []string{"internal/api/thread.go", "gui/frontend/src/lib/thread.ts"}, nil, true},
		{"the Go side of the GUI", []string{"gui/main.go"}, nil, false},
		{"a proto", []string{"proto/codefoundry/v1/thread.proto"}, nil, true},
		{"a command, which the mock's tests read", []string{"internal/command/commands_thread.go"}, nil, true},
		{"a layout fixture the frontend shares", []string{"internal/layout/testdata/fits.json"}, nil, true},
		{"layout code beside the fixtures", []string{"internal/layout/fit.go"}, nil, false},
		{"one listed file", []string{"pluginsdk/ui/icons.go"}, nil, true},
		{"its neighbour", []string{"pluginsdk/ui/icons_test.go"}, nil, false},
		{"a file whose name starts like a listed file", []string{"Makefile.bak"}, nil, false},
		{"the Makefile", []string{"Makefile"}, nil, true},
		{"a check script", []string{"scripts/go-test.sh"}, nil, true},
		{"nothing changed", nil, nil, true},
		{"CHECK_ALL", []string{"internal/store/thread/manager.go"}, []string{"CHECK_ALL=1"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := frontendPhaseRuns(t, tt.env, tt.changed...); got != tt.run {
				t.Fatalf("frontend phase runs = %v, want %v", got, tt.run)
			}
		})
	}
}

// escape is a relative path that climbs at least one directory, as a frontend file
// writes one to reach the rest of the repository (`new URL("../../../internal/…")`, a
// `?raw` import).
var escape = regexp.MustCompile(`(?:\.\./)+[A-Za-z0-9_@./-]+`)

// TestFrontendInputsListed keeps frontend-inputs.txt complete: every existing path
// outside gui/frontend that a file the frontend phase loads names relatively must be
// listed, or a branch changing it would skip the tests that read it.
func TestFrontendInputsListed(t *testing.T) {
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	var dirs, files []string
	f, err := os.Open("frontend-inputs.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for sc := bufio.NewScanner(f); sc.Scan(); {
		line := strings.TrimSpace(sc.Text())
		switch {
		case line == "" || strings.HasPrefix(line, "#"):
		case strings.HasSuffix(line, "/"):
			dirs = append(dirs, line)
		default:
			files = append(files, line)
		}
		if line != "" && !strings.HasPrefix(line, "#") {
			if _, err := os.Stat(filepath.Join(root, line)); err != nil {
				t.Errorf("frontend-inputs.txt lists %s, which does not exist", line)
			}
		}
	}
	listed := func(rel string) bool {
		for _, d := range dirs {
			if strings.HasPrefix(rel+"/", d) {
				return true
			}
		}
		for _, f := range files {
			if rel == f {
				return true
			}
		}
		return false
	}

	frontend := filepath.Join(root, "gui", "frontend")
	missing := map[string]string{}
	err = filepath.WalkDir(frontend, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(frontend, path)
		if d.IsDir() {
			switch rel {
			// Not loaded by the frontend phase: dependencies, build output, and the
			// Playwright suite (`make gui-e2e`, not part of check).
			case "node_modules", "dist", "dist-e2e", "e2e", "test-results", "playwright-report", "bindings":
				return filepath.SkipDir
			}
			return nil
		}
		switch filepath.Ext(path) {
		case ".ts", ".tsx", ".css", ".html", ".json":
		default:
			return nil
		}
		if rel == "vite.config.ts" {
			// Its paths are the folders Vite may serve from (server.fs.allow), wider
			// than what is read; a read is a relative path in the file that makes it.
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range escape.FindAllString(string(src), -1) {
			target := filepath.Clean(filepath.Join(filepath.Dir(path), m))
			out, err := filepath.Rel(root, target)
			if err != nil || strings.HasPrefix(out, "..") || strings.HasPrefix(out+"/", "gui/frontend/") {
				continue
			}
			if _, err := os.Stat(target); err != nil {
				continue // a path in a fixture or a comment, not a file here
			}
			if !listed(filepath.ToSlash(out)) {
				missing[filepath.ToSlash(out)] = filepath.ToSlash(filepath.Join("gui/frontend", rel))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	paths := make([]string, 0, len(missing))
	for p := range missing {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		t.Errorf("%s reads %s, which scripts/frontend-inputs.txt does not list", missing[p], p)
	}
}
