package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/paths"
)

// EnvDaemonBinary points the GUI at a specific code-foundry binary to auto-start.
const EnvDaemonBinary = "CODE_FOUNDRY_BIN"

// DaemonEndpoint is how the frontend reaches the daemon's loopback listener.
type DaemonEndpoint struct {
	BaseURL string `json:"baseUrl"`
	Token   string `json:"token"`
}

// DaemonService is bound to the frontend. It is the only thing the Wails host exposes.
type DaemonService struct {
	paths paths.Paths
	log   *slog.Logger
	mu    sync.Mutex // serialises auto-start attempts from concurrent calls
}

// NewDaemonService returns a DaemonService for the daemon at p.
func NewDaemonService(p paths.Paths, log *slog.Logger) *DaemonService {
	return &DaemonService{paths: p, log: log}
}

// GetDaemonEndpoint ensures the daemon is running (starting it if needed) and returns
// its loopback base URL and bearer token. The frontend calls it at startup and again
// whenever a request fails, which picks up a restarted daemon's new port and token.
func (s *DaemonService) GetDaemonEndpoint(ctx context.Context) (DaemonEndpoint, error) {
	if _, err := s.connect(ctx); err != nil {
		return DaemonEndpoint{}, err
	}
	ep, err := client.ReadEndpoint(s.paths)
	if err != nil {
		return DaemonEndpoint{}, err
	}
	return DaemonEndpoint{BaseURL: ep.BaseURL, Token: ep.Token}, nil
}

// connect returns a client for the daemon, starting it from daemonBinary() if it is not
// running. The frontend (through GetDaemonEndpoint) and the host's relaunch watcher both
// use it, so a daemon that stops (daemon.restart) comes back even while the webview is
// hidden and its timers are suspended.
func (s *DaemonService) connect(ctx context.Context) (*client.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	bin, err := daemonBinary()
	if err != nil {
		s.log.Debug("no code-foundry binary found; can only use an already running daemon", "err", err)
	}
	c, err := client.Connect(ctx, s.paths, client.ConnectOptions{DaemonBinary: bin, Logger: s.log})
	if err != nil {
		return nil, fmt.Errorf("connect to daemon: %w", err)
	}
	return c, nil
}

// exportDaemonBinary sets CODE_FOUNDRY_BIN to the CLI this app auto-starts (the
// code-foundry next to it when installed), so the daemon and the sessions it spawns inherit it and
// can call the CLI without it being on PATH.
func exportDaemonBinary(log *slog.Logger) {
	if os.Getenv(EnvDaemonBinary) != "" {
		return
	}
	bin, err := daemonBinary()
	if err != nil {
		return
	}
	_ = os.Setenv(EnvDaemonBinary, bin)
	log.Debug("daemon binary", "path", bin)
}

// daemonBinary finds the code-foundry CLI to spawn: $CODE_FOUNDRY_BIN, then a sibling
// of this executable (<app dir>/code-foundry when installed), then
// ../bin/code-foundry relative to the working directory (`wails3 dev` from gui/ after
// `make build`), then $PATH.
func daemonBinary() (string, error) {
	if b := os.Getenv(EnvDaemonBinary); b != "" {
		return b, nil
	}
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "code-foundry"))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "..", "bin", "code-foundry"))
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return filepath.Clean(c), nil
		}
	}
	if b, err := exec.LookPath("code-foundry"); err == nil {
		return b, nil
	}
	return "", errors.New("code-foundry not found: set " + EnvDaemonBinary + ", run `make build`, or put it on PATH")
}
