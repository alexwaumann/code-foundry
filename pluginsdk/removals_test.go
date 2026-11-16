package pluginsdk

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// deprecatedSymbols walks the module's Go files (tests and testdata aside) and returns
// every symbol whose doc comment has a "Deprecated:" paragraph, and every symbol at all,
// named as Removal.Symbols names them: "Host.SetFlag", "Flag", "InitializeParams.Flags",
// "plugintest.Options.Flags".
func deprecatedSymbols(t *testing.T) (deprecated, all map[string]bool) {
	t.Helper()
	deprecated, all = map[string]bool{}, map[string]bool{}
	fset := token.NewFileSet()
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == "testdata" || strings.HasPrefix(d.Name(), ".")) && path != "." {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			return err
		}
		prefix := ""
		if dir := filepath.Dir(path); dir != "." {
			prefix = f.Name.Name + "."
		}
		note := func(name string, docs ...*ast.CommentGroup) {
			if !ast.IsExported(name[strings.LastIndex(name, ".")+1:]) {
				return
			}
			all[prefix+name] = true
			for _, doc := range docs {
				if text := doc.Text(); strings.HasPrefix(text, "Deprecated: ") || strings.Contains(text, "\nDeprecated: ") {
					deprecated[prefix+name] = true
				}
			}
		}
		for _, decl := range f.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				name := d.Name.Name
				if d.Recv != nil && len(d.Recv.List) == 1 {
					rt := d.Recv.List[0].Type
					if s, ok := rt.(*ast.StarExpr); ok {
						rt = s.X
					}
					if id, ok := rt.(*ast.Ident); ok {
						name = id.Name + "." + name
					}
				}
				note(name, d.Doc)
			case *ast.GenDecl:
				for _, spec := range d.Specs {
					switch s := spec.(type) {
					case *ast.TypeSpec:
						note(s.Name.Name, s.Doc, d.Doc)
						if st, ok := s.Type.(*ast.StructType); ok {
							for _, fld := range st.Fields.List {
								for _, n := range fld.Names {
									note(s.Name.Name+"."+n.Name, fld.Doc)
								}
							}
						}
					case *ast.ValueSpec:
						for _, n := range s.Names {
							docs := []*ast.CommentGroup{s.Doc}
							if len(d.Specs) == 1 {
								docs = append(docs, d.Doc)
							}
							note(n.Name, docs...)
						}
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return deprecated, all
}

// The removal list and the code agree both ways: every "Deprecated:" symbol in the module
// is listed, and every listed symbol exists and says it is deprecated. Each entry is
// well formed.
func TestRemovalsMatchTheCode(t *testing.T) {
	deprecated, all := deprecatedSymbols(t)
	listed := map[string]bool{}
	for _, r := range Removals {
		for _, s := range r.Symbols {
			if listed[s] {
				t.Errorf("%s is listed twice", s)
			}
			listed[s] = true
			switch {
			case !all[s]:
				t.Errorf("%s is listed in Removals but not in the code (deleted? then take it off the list)", s)
			case !deprecated[s]:
				t.Errorf("%s is listed in Removals but its doc comment has no Deprecated: paragraph", s)
			}
		}
		day := func(what, v string) {
			if _, err := time.Parse(time.DateOnly, v); err != nil {
				t.Errorf("%s: %s %q is not YYYY-MM-DD", r.Symbol(), what, v)
			}
		}
		day("deprecated", r.Deprecated)
		switch r.Stage {
		case StageDeprecated:
			if r.Retired != "" {
				t.Errorf("%s: deprecated, but retired on %s", r.Symbol(), r.Retired)
			}
		case StageRetired:
			day("retired", r.Retired)
		default:
			t.Errorf("%s: stage %q", r.Symbol(), r.Stage)
		}
		if len(r.Symbols) == 0 || r.Replacement == "" || r.Hint == "" {
			t.Errorf("%+v: needs symbols, a replacement and a hint", r)
		}
	}
	for s := range deprecated {
		if !listed[s] {
			t.Errorf("%s is marked Deprecated: but not in Removals (removals.go)", s)
		}
	}
	if r, ok := RemovalOfMethod(MethodThreadSetFlag); !ok || r.Symbol() != "Host.SetFlag" || r.Stage != StageDeprecated || r.Deprecated != "2026-11-16" {
		t.Errorf("thread/setFlag: %+v, %v", r, ok)
	}
}

// A retired stub keeps its signature, does nothing and calls Retired, which logs once per
// process per symbol, naming the replacement.
func TestRetired(t *testing.T) {
	old := Removals
	t.Cleanup(func() { Removals = old })
	Removals = append(slices.Clone(old), Removal{Symbols: []string{"Host.TestGone"}, Method: "test/gone", Replacement: "Host.Notify",
		Hint: "post a notification", Stage: StageRetired, Deprecated: "2026-01-01", Retired: "2026-03-01"})
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	// The shape of a retired stub.
	stub := func(int) error {
		Retired(log, "Host.TestGone")
		return nil
	}
	for range 3 {
		if err := stub(1); err != nil {
			t.Fatal(err)
		}
	}
	out := buf.String()
	if n := strings.Count(out, "level=WARN"); n != 1 {
		t.Fatalf("%d warnings, want 1:\n%s", n, out)
	}
	if !strings.Contains(out, "Host.TestGone (test/gone) was retired on 2026-03-01 and does nothing: use Host.Notify (post a notification)") ||
		!strings.Contains(out, "replacement=Host.Notify") {
		t.Errorf("warning:\n%s", out)
	}
	// Another symbol warns on its own.
	Retired(log, "Host.TestUnlisted")
	if !strings.Contains(buf.String(), "Host.TestUnlisted was retired and does nothing") {
		t.Errorf("unlisted:\n%s", buf.String())
	}
}
