// Package registrytest has fakes for the registry package: a scripted gh.
package registrytest

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
)

// Gh is a fake gh: `api … repos/<repo>/contents/index.json` answers Indexes[repo],
// `release view [tag] -R <repo> --json …` answers Releases[repo+"@"+tag] (tag "" for the
// latest), and `release download <tag> -R <repo> -p <asset> -O <dst>` copies
// Assets[repo+"/"+tag+"/"+asset] (a local file) to dst. Anything missing answers like
// gh's 404. Calls records every argv.
type Gh struct {
	mu       sync.Mutex
	Indexes  map[string]string
	Releases map[string]string
	Assets   map[string]string
	// Err, when set, fails every call.
	Err   error
	calls [][]string
}

var _ registry.Gh = (*Gh)(nil)

// NewGh returns an empty fake.
func NewGh() *Gh {
	return &Gh{Indexes: map[string]string{}, Releases: map[string]string{}, Assets: map[string]string{}}
}

// Calls returns the argv of every call so far.
func (g *Gh) Calls() [][]string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.calls)
}

// Run implements registry.Gh.
func (g *Gh) Run(_ context.Context, args ...string) ([]byte, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls = append(g.calls, slices.Clone(args))
	if g.Err != nil {
		return nil, g.Err
	}
	notFound := &registry.GhError{Args: args, Msg: "gh: Not Found (HTTP 404)"}
	flag := func(name string) string {
		if i := slices.Index(args, name); i >= 0 && i+1 < len(args) {
			return args[i+1]
		}
		return ""
	}
	switch {
	case len(args) > 0 && args[0] == "api":
		path := args[len(args)-1]
		repo, ok := strings.CutSuffix(strings.TrimPrefix(path, "repos/"), "/contents/"+registry.IndexFile)
		if !ok {
			return nil, fmt.Errorf("fake gh: unexpected api path %s", path)
		}
		body, ok := g.Indexes[repo]
		if !ok {
			return nil, notFound
		}
		return []byte(body), nil
	case len(args) > 1 && args[0] == "release" && args[1] == "view":
		tag := ""
		if len(args) > 2 && !strings.HasPrefix(args[2], "-") {
			tag = args[2]
		}
		body, ok := g.Releases[flag("-R")+"@"+tag]
		if !ok {
			return nil, &registry.GhError{Args: args, Msg: "release not found"}
		}
		return []byte(body), nil
	case len(args) > 2 && args[0] == "release" && args[1] == "download":
		src, ok := g.Assets[flag("-R")+"/"+args[2]+"/"+flag("-p")]
		if !ok {
			return nil, &registry.GhError{Args: args, Msg: "no assets match the file pattern"}
		}
		data, err := os.ReadFile(src)
		if err != nil {
			return nil, err
		}
		return nil, os.WriteFile(flag("-O"), data, 0o600)
	}
	return nil, fmt.Errorf("fake gh: unexpected %v", args)
}
