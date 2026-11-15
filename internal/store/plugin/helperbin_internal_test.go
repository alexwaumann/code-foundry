package plugin

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

// The plugins these tests run are this test binary in a helper mode (helper_test.go).
// The copy they run is a second build of it without -race: a race-instrumented process
// takes about a second to start on macOS arm64 (docs/notes/fake-claude-binary.md), and
// the package starts a few hundred plugins. The tests themselves, and so the Manager,
// stay under -race; what loses it is the plugin's side of the pipe, which pluginsdk's
// own tests cover.
var helperBin struct {
	once sync.Once
	dir  string
	path string
	err  error
}

// HelperBin is the path of the uninstrumented test binary, built on first use: a
// subprocess `go test -c` does not inherit -race. The build cache holds the compile, so
// a later run pays the link only.
func HelperBin(t testing.TB) string {
	t.Helper()
	helperBin.once.Do(func() {
		dir, err := os.MkdirTemp("", "pluginhelper")
		if err != nil {
			helperBin.err = err
			return
		}
		helperBin.dir = dir
		path := filepath.Join(dir, "plugin.test")
		build := exec.Command("go", "test", "-c", "-o", path, ".")
		if out, err := build.CombinedOutput(); err != nil {
			helperBin.err = fmt.Errorf("build the helper plugin (go test -c): %w\n%s", err, out)
			return
		}
		helperBin.path = path
	})
	if helperBin.err != nil {
		t.Fatal(helperBin.err)
	}
	return helperBin.path
}

func TestMain(m *testing.M) {
	code := m.Run()
	if helperBin.dir != "" {
		_ = os.RemoveAll(helperBin.dir)
	}
	os.Exit(code)
}
