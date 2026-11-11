package workspace

import (
	"path/filepath"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

func TestWithin(t *testing.T) {
	tmp := t.TempDir()
	for _, tt := range []struct {
		name, path, root string
		want             bool
	}{
		{"the root itself", "/src/web", "/src/web", true},
		{"inside", "/src/web/a/b", "/src/web", true},
		{"a sibling with the root as prefix", "/src/website", "/src/web", false},
		{"outside", "/src/api", "/src/web", false},
		{"under /", "/src/web", "/", true},
		{"the root in another case", "/src/web/a", "/SRC/Web", true},
		{"the path in another case", "/Src/WEB/a", "/src/web", true},
		{"uncleaned", "/src/web/../web/./a", "/src/web/", true},
		{"through a symlink", filepath.Join(tmp, "a"), realPath(tmp), true},
		{"empty path", "", "/src/web", false},
		{"empty root", "/src/web", "", false},
	} {
		if got := Within(tt.path, tt.root); got != tt.want {
			t.Errorf("%s: Within(%q, %q) = %v, want %v", tt.name, tt.path, tt.root, got, tt.want)
		}
	}
}

// A project is found by a path inside it typed in another case, as APFS finds the folder.
func TestResolveProjectByPathInAnotherCase(t *testing.T) {
	pf := projecttest.New(nil)
	pf.Put(project.Project{ID: "r-web", Name: "web", Path: "/Users/me/code/web"})
	pf.Put(project.Project{ID: "r-sub", Name: "sub", Path: "/Users/me/code/web/sub"})
	for _, tt := range []struct{ ref, want string }{
		{"/Users/me/Code/Web/src", "r-web"},
		{"/users/me/code/WEB/Sub/x", "r-sub"},
	} {
		got, err := ResolveProject(pf.Snapshot(), tt.ref)
		if err != nil || got.ID != tt.want {
			t.Errorf("ResolveProject(%q) = %q, %v; want %q", tt.ref, got.ID, err, tt.want)
		}
	}
}
