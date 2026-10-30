package api

import (
	"context"
	"os"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/version"
)

func TestHealth(t *testing.T) {
	start := time.Unix(1000, 0)
	h := NewHealth(start, version.Info{Version: "1.2.3", Commit: "abc", GoVersion: "go1.26"}, "/Users/me/.code-foundry/pages/welcome.html")
	h.now = func() time.Time { return start.Add(90 * time.Second) }

	ping, err := h.Ping(context.Background(), connect.NewRequest(&v1.PingRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if ping.Msg.GetPid() != int32(os.Getpid()) || ping.Msg.GetVersion() != "1.2.3" ||
		ping.Msg.GetUptime().AsDuration() != 90*time.Second {
		t.Fatalf("Ping = %v", ping.Msg)
	}
}

func TestHealthVersion(t *testing.T) {
	info := version.Info{Version: "1.2.3", Commit: "abc", GoVersion: "go1.26"}
	tests := []struct {
		name    string
		welcome string
		want    *v1.VersionResponse
	}{
		{
			name:    "welcome page",
			welcome: "/Users/me/.code-foundry/pages/welcome.html",
			want:    &v1.VersionResponse{Version: "1.2.3", Commit: "abc", GoVersion: "go1.26", WelcomePage: "/Users/me/.code-foundry/pages/welcome.html"},
		},
		{
			name: "no welcome page",
			want: &v1.VersionResponse{Version: "1.2.3", Commit: "abc", GoVersion: "go1.26"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := NewHealth(time.Unix(1000, 0), info, tt.welcome)
			ver, err := h.Version(context.Background(), connect.NewRequest(&v1.VersionRequest{}))
			if err != nil {
				t.Fatal(err)
			}
			got := ver.Msg
			if got.GetVersion() != tt.want.GetVersion() || got.GetCommit() != tt.want.GetCommit() ||
				got.GetGoVersion() != tt.want.GetGoVersion() || got.GetWelcomePage() != tt.want.GetWelcomePage() {
				t.Fatalf("Version = %v, want %v", got, tt.want)
			}
		})
	}
}
