package command

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/pluginscaffold"
)

// plugin.new (docs/notes/plugin-new.md): start a plugin repository from the minimal
// example, with the module made and the SDK fetched at this daemon's pin.

// PluginScaffolder makes a plugin repository (pluginscaffold.Scaffolder).
type PluginScaffolder interface {
	New(ctx context.Context, name, parent, owner string) (pluginscaffold.Result, error)
}

var errNoScaffolder = connect.NewError(connect.CodeUnimplemented, errors.New("plugin new is not available"))

// RegisterPluginNew registers plugin.new. A nil s registers it failing with
// Unimplemented.
func RegisterPluginNew(r *Registry, s PluginScaffolder) error {
	return r.Register(Command{
		Name:      "plugin.new",
		NoPalette: true,
		Title:     "New Plugin",
		Description: "Start a plugin repository: <dir>/" + pluginscaffold.DirPrefix + "<name> from the minimal example " +
			"with its name filled in, then go mod init, go get the SDK at this daemon's pin and go mod tidy (up to 3 minutes). " +
			"If go fails, the files stay and it prints the commands to finish by hand (exit 1). It runs neither git init nor plugin dev.",
		Category:     "Plugin",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "name", Type: String, Required: true, Positional: true, Description: "The plugin's name: lowercase letters, digits and single hyphens, a letter first"},
			{Name: "dir", Type: Path, Required: true, Positional: true, Description: "The folder to make the repository in, inside your home directory"},
			{Name: "owner", Type: String, Description: "GitHub owner for the module path github.com/<owner>/" + pluginscaffold.DirPrefix + "<name> (default: a bare module path)"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if s == nil {
				return Result{}, errNoScaffolder
			}
			res, err := s.New(ctx, a.String("name"), a.Path("dir"), a.String("owner"))
			if errors.Is(err, pluginscaffold.ErrInvalid) {
				return Result{}, connect.NewError(connect.CodeInvalidArgument, err)
			}
			if err != nil {
				return Result{}, err
			}
			msg, code := formatPluginNew(res, a.String("owner"), a.String("name"))
			return Result{Message: msg, JSON: res, ExitCode: code}, nil
		},
	})
}

// formatPluginNew is plugin.new's output and exit code: the next step, or the commands
// that finish the module when the go step failed.
func formatPluginNew(res pluginscaffold.Result, owner, name string) (string, int) {
	dir := quoteArg(res.Dir)
	next := "make build && code-foundry plugin dev \"$PWD\" --follow=false"
	lines := []string{fmt.Sprintf("created %s (module %s, %d files)", res.Dir, res.Module, len(res.Files))}
	code := 0
	if res.GoError != "" {
		code = 1
		lines = append(lines, "the go step failed: "+res.GoError, "finish it by hand:", "  cd "+dir)
		for _, c := range res.Finish {
			lines = append(lines, "  "+c)
		}
		lines = append(lines, "then: "+next)
	} else {
		lines = append(lines, "next: cd "+dir+" && "+next)
	}
	if owner == "" {
		lines = append(lines, "before publishing: go mod edit -module github.com/<owner>/"+pluginscaffold.DirPrefix+name)
	}
	return strings.Join(lines, "\n"), code
}

// plainArg is a shell word that needs no quotes.
var plainArg = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

// quoteArg is s as one shell word.
func quoteArg(s string) string {
	if plainArg.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
