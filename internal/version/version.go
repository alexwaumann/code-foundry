// Package version reports the build version of code-foundry.
package version

import (
	"runtime"
	"runtime/debug"
)

// Version is set at build time with -ldflags "-X github.com/alexwaumann/code-foundry/internal/version.Version=...".
var Version = "dev"

// Commit is the commit to report when the binary has no VCS stamp: Go stamps one only
// when the module's .git is a directory, so a build in a git worktree (where .git is a
// file) has none. `make build` sets it with -ldflags "-X ...version.Commit=<sha>[-dirty]".
var Commit = ""

// PluginSDKTag is the pluginsdk/vX.Y.Z tag on the commit the binary was built from
// ("" when it has none): the plugin skill pins the SDK at that version rather than the
// commit. The daemon cannot run git when it starts, so `make build` resolves it
// (`git tag --points-at HEAD 'pluginsdk/v*'`) into
// -ldflags "-X ...version.PluginSDKTag=pluginsdk/vX.Y.Z".
var PluginSDKTag = ""

// Info describes the running build.
type Info struct {
	Version   string
	Commit    string
	GoVersion string
	// PluginSDKTag is PluginSDKTag: the pluginsdk/vX.Y.Z tag on Commit, if any.
	PluginSDKTag string
}

// Get returns build information, filling the commit from the embedded VCS info, else
// from Commit.
func Get() Info {
	info := Info{Version: Version, Commit: Commit, GoVersion: runtime.Version(), PluginSDKTag: PluginSDKTag}
	if bi, ok := debug.ReadBuildInfo(); ok {
		dirty := false
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				info.Commit = s.Value
			case "vcs.modified":
				dirty = s.Value == "true"
			}
		}
		if dirty && info.Commit != "" {
			info.Commit += "-dirty"
		}
	}
	return info
}
