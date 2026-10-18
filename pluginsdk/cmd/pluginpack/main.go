// Command pluginpack packs plugin package directories into release tarballs for a plugin
// registry (docs/notes/plugins-7-registry.md):
//
//	go run github.com/alexwaumann/code-foundry/pluginsdk/cmd/pluginpack@<version> \
//	    -out dist -repo owner/code-foundry-plugin-x -entry dist/x.json \
//	    darwin/arm64=build/arm64 darwin/amd64=build/amd64
//
// Each argument is a package directory (plugin.json plus the executable its exec names),
// optionally prefixed with its platform (default darwin/<this machine's arch>). For each
// it writes <out>/<name>-<version>-<os>-<arch>.tar.gz, adds its line to
// <out>/checksums.txt, and prints `<sha256>  <file>`. With -entry it also writes the
// registry entry (plugins/<name>.json in the registry repository), whose download URLs
// are the GitHub release v<version> of -repo, or -url-base/<file> when given.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"

	"github.com/alexwaumann/code-foundry/pluginsdk/pack"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "pluginpack:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("pluginpack", flag.ContinueOnError)
	fs.SetOutput(stderr)
	out := fs.String("out", "dist", "directory for the tarballs and checksums.txt")
	repo := fs.String("repo", "", "the plugin's GitHub repository, owner/name (for -entry)")
	entry := fs.String("entry", "", "also write the registry entry JSON to this file")
	urlBase := fs.String("url-base", "", "download URLs are <url-base>/<file> instead of the GitHub release v<version> of -repo")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: pluginpack [-out dist] [-repo owner/name -entry file [-url-base url]] [<os>/<arch>=]DIR...")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		fs.Usage()
		return fmt.Errorf("no package directory")
	}
	if *entry != "" && *repo == "" {
		return fmt.Errorf("-entry needs -repo")
	}
	var results []pack.Result
	for _, a := range fs.Args() {
		platform, dir := "darwin/"+runtime.GOARCH, a
		if p, d, ok := strings.Cut(a, "="); ok {
			platform, dir = p, d
		}
		r, err := pack.Tarball(dir, *out, platform)
		if err != nil {
			return fmt.Errorf("%s: %w", dir, err)
		}
		results = append(results, r)
		fmt.Fprintf(stdout, "%s  %s\n", r.SHA256, r.File)
	}
	if err := pack.WriteChecksums(*out, results...); err != nil {
		return err
	}
	if *entry == "" {
		return nil
	}
	e, err := pack.MakeEntry(*repo, results, func(r pack.Result) string {
		if *urlBase != "" {
			return strings.TrimRight(*urlBase, "/") + "/" + r.Base
		}
		return pack.ReleaseURL(*repo, r.Version, r.Base)
	})
	if err != nil {
		return err
	}
	b, err := pack.MarshalEntry(e)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*entry, b, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "registry entry: %s\n", *entry)
	return nil
}
