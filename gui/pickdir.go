package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// PickDirectory shows the native folder picker, opened at startDir (as typed: "~/x" or
// absolute; the nearest existing directory, else home), and returns the chosen
// directory, or "" when the user cancels. The result is not validated here: the
// daemon applies the home-directory rule to whatever is submitted.
func (s *AppService) PickDirectory(startDir string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("pick directory: %w", err)
	}
	app := application.Get()
	d := app.Dialog.OpenFile().
		CanChooseFiles(false).
		CanChooseDirectories(true).
		CanCreateDirectories(true).
		ResolvesAliases(true).
		SetTitle("Choose a project folder").
		SetButtonText("Choose").
		SetDirectory(pickStart(startDir, home, isDir))
	if w := app.Window.Current(); w != nil {
		d.AttachToWindow(w)
	}
	path, err := d.PromptForSingleSelection()
	if err != nil {
		return "", fmt.Errorf("pick directory: %w", err)
	}
	s.log.Debug("directory picked", "path", path)
	return path, nil
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// pickStart is the directory the folder picker opens at for a typed path: "~"
// expanded, then the nearest existing ancestor. Anything empty, relative, or outside
// home starts at home.
func pickStart(typed, home string, isDir func(string) bool) string {
	p := typed
	switch {
	case p == "~" || strings.HasPrefix(p, "~/"):
		p = home + p[1:]
	case !filepath.IsAbs(p):
		return home
	}
	p = filepath.Clean(p)
	if !fsx.Within(home, p) {
		return home
	}
	for p != home && !isDir(p) {
		p = filepath.Dir(p)
	}
	return p
}
