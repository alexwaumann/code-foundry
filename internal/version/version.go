// Package version reports the build version of code-foundry.
package version

import (
	"runtime"
	"runtime/debug"
)

// Version is set at build time with -ldflags "-X github.com/alexwaumann/code-foundry/internal/version.Version=...".
var Version = "dev"

// Info describes the running build.
type Info struct {
	Version   string
	Commit    string
	GoVersion string
}

// Get returns build information, filling the commit from the embedded VCS info.
func Get() Info {
	info := Info{Version: Version, GoVersion: runtime.Version()}
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
