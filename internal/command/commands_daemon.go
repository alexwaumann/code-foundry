package command

import (
	"context"
	"fmt"
	"time"

	"github.com/alexwaumann/code-foundry/internal/version"
)

// DaemonInfo is what the daemon.* commands report.
type DaemonInfo struct {
	PID     int
	Version version.Info
	Started time.Time
	Home    string
	Socket  string
	// Now defaults to time.Now.
	Now func() time.Time
}

// DaemonStatus is daemon.status's JSON result.
type DaemonStatus struct {
	PID           int     `json:"pid"`
	Version       string  `json:"version"`
	Commit        string  `json:"commit,omitempty"`
	UptimeSeconds float64 `json:"uptime_seconds"`
	Home          string  `json:"home"`
	Socket        string  `json:"socket"`
}

// DaemonVersion is daemon.version's JSON result.
type DaemonVersion struct {
	Version   string `json:"version"`
	Commit    string `json:"commit,omitempty"`
	GoVersion string `json:"go_version"`
}

// RegisterDaemon registers daemon.status and daemon.version.
func RegisterDaemon(r *Registry, info DaemonInfo) error {
	if info.Now == nil {
		info.Now = time.Now
	}
	return r.RegisterAll(
		Command{
			Name:        "daemon.status",
			Title:       "Daemon Status",
			Description: "Show the daemon's pid, version, uptime, and config home.",
			Category:    "Daemon",
			Run: func(context.Context, Context, Args) (Result, error) {
				up := info.Now().Sub(info.Started).Round(time.Second)
				return Result{
					Message: fmt.Sprintf("daemon pid %d, version %s, up %s, home %s",
						info.PID, info.Version.Version, up, info.Home),
					JSON: DaemonStatus{
						PID:           info.PID,
						Version:       info.Version.Version,
						Commit:        info.Version.Commit,
						UptimeSeconds: up.Seconds(),
						Home:          info.Home,
						Socket:        info.Socket,
					},
				}, nil
			},
		},
		Command{
			Name:        "daemon.version",
			Title:       "Daemon Version",
			Description: "Show the daemon's build version.",
			Category:    "Daemon",
			Run: func(context.Context, Context, Args) (Result, error) {
				v := info.Version
				msg := "code-foundry " + v.Version
				if v.Commit != "" {
					msg += " (" + v.Commit + ")"
				}
				return Result{
					Message: msg + " " + v.GoVersion,
					JSON:    DaemonVersion{Version: v.Version, Commit: v.Commit, GoVersion: v.GoVersion},
				}, nil
			},
		},
	)
}
