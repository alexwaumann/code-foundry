package dictationtest

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/dictation"
)

// GhAssetID is the id Gh gives its one asset.
const GhAssetID = 7

// Gh is a fake gh for the store's GitHub source. It serves one release asset as gh
// does: `api repos/<repo>/releases/tags/<tag>` prints the release JSON, and
// `api --include ... repos/<repo>/releases/assets/<id>` prints a status line, headers
// and the asset's bytes, honouring a Range header (GitHub's object store does, and gh
// carries it across the redirect). Set the fields before the first Run.
type Gh struct {
	Asset dictation.ReleaseAsset
	Body  []byte
	// State is the asset's state in the release (default "uploaded").
	State string
	// Missing fails every run as with no gh; LoggedOut as gh without a login.
	Missing, LoggedOut bool
	// IgnoreRange sends the whole file (200) whatever the Range.
	IgnoreRange bool
	// FailAfter, when > 0, makes a transfer exit non-zero after that many body bytes.
	FailAfter int
	// Hold, when set, blocks each transfer after half its body until closed (or the
	// run is cancelled).
	Hold chan struct{}

	mu     sync.Mutex
	calls  [][]string
	ranges []string
}

var _ dictation.GhRunner = (*Gh)(nil)

// Run implements dictation.GhRunner.
func (g *Gh) Run(ctx context.Context, args []string, stdout io.Writer) error {
	g.mu.Lock()
	g.calls = append(g.calls, slices.Clone(args))
	g.mu.Unlock()
	switch {
	case g.Missing:
		return dictation.ErrGhNotFound
	case g.LoggedOut:
		return &dictation.GhError{Code: 4, Stderr: "To get started with GitHub CLI, please run:  gh auth login\n"}
	}
	path := args[len(args)-1]
	repo := "repos/" + g.Asset.Repo + "/releases/"
	switch path {
	case repo + "tags/" + g.Asset.Tag:
		return g.release(stdout)
	case repo + "assets/" + strconv.Itoa(GhAssetID):
		return g.asset(ctx, args, stdout)
	}
	return &dictation.GhError{Code: 1, Stderr: "gh: Not Found (HTTP 404)\n"}
}

func (g *Gh) release(stdout io.Writer) error {
	state := g.State
	if state == "" {
		state = "uploaded"
	}
	type asset struct {
		ID    int    `json:"id"`
		Name  string `json:"name"`
		Size  int    `json:"size"`
		State string `json:"state"`
	}
	b, err := json.Marshal(map[string]any{
		"tag_name": g.Asset.Tag,
		"assets": []asset{
			{ID: 3, Name: "other.bin", Size: 1, State: "uploaded"},
			{ID: GhAssetID, Name: g.Asset.Asset, Size: len(g.Body), State: state},
		},
	})
	if err != nil {
		return err
	}
	_, err = stdout.Write(b)
	return err
}

func (g *Gh) asset(ctx context.Context, args []string, stdout io.Writer) error {
	from := -1
	for i, a := range args {
		if r, ok := strings.CutPrefix(a, "Range: bytes="); ok && i > 0 && args[i-1] == "-H" {
			g.mu.Lock()
			g.ranges = append(g.ranges, a)
			g.mu.Unlock()
			if n, err := strconv.Atoi(strings.TrimSuffix(r, "-")); err == nil && !g.IgnoreRange {
				from = n
			}
		}
	}
	body := g.Body
	head := "HTTP/2.0 200 OK\r\nContent-Length: " + strconv.Itoa(len(body)) + "\r\n"
	if from >= len(body) {
		_, _ = io.WriteString(stdout, "HTTP/2.0 416 Range Not Satisfiable\r\n\r\n")
		return &dictation.GhError{Code: 1, Stderr: "gh: HTTP 416\n"}
	}
	if from >= 0 {
		head = fmt.Sprintf("HTTP/2.0 206 Partial Content\r\nContent-Range: bytes %d-%d/%d\r\n", from, len(body)-1, len(body))
		body = body[from:]
	}
	if _, err := io.WriteString(stdout, head+"Content-Type: application/octet-stream\r\n\r\n"); err != nil {
		return err
	}
	if g.FailAfter > 0 && g.FailAfter < len(body) {
		if _, err := stdout.Write(body[:g.FailAfter]); err != nil {
			return err
		}
		return &dictation.GhError{Code: 1, Stderr: "stream error: stream ID 1; INTERNAL_ERROR\n"}
	}
	if g.Hold != nil {
		if _, err := stdout.Write(body[:len(body)/2]); err != nil {
			return err
		}
		select {
		case <-g.Hold:
		case <-ctx.Done():
			return ctx.Err()
		}
		body = body[len(body)/2:]
	}
	_, err := stdout.Write(body)
	return err
}

// Calls returns each run's arguments.
func (g *Gh) Calls() [][]string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.calls)
}

// Ranges returns the Range headers transfers carried ("Range: bytes=N-").
func (g *Gh) Ranges() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.ranges)
}

// Transfers counts the asset downloads asked for.
func (g *Gh) Transfers() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, c := range g.calls {
		if strings.Contains(c[len(c)-1], "/releases/assets/") {
			n++
		}
	}
	return n
}
