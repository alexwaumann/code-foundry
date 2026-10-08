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
	h := NewHealth(start, version.Info{Version: "1.2.3", Commit: "abc", GoVersion: "go1.26"})
	h.now = func() time.Time { return start.Add(90 * time.Second) }

	ping, err := h.Ping(context.Background(), connect.NewRequest(&v1.PingRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if ping.Msg.GetPid() != int32(os.Getpid()) || ping.Msg.GetVersion() != "1.2.3" ||
		ping.Msg.GetUptime().AsDuration() != 90*time.Second {
		t.Fatalf("Ping = %v", ping.Msg)
	}

	ver, err := h.Version(context.Background(), connect.NewRequest(&v1.VersionRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if ver.Msg.GetVersion() != "1.2.3" || ver.Msg.GetCommit() != "abc" || ver.Msg.GetGoVersion() != "go1.26" {
		t.Fatalf("Version = %v", ver.Msg)
	}
}
