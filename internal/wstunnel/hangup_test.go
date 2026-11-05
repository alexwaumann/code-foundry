package wstunnel_test

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/wstunnel"
	"github.com/alexwaumann/code-foundry/internal/wstunnel/wstunneltest"
)

// rawUpgrade is a client that sends only what a test writes: the library's would finish a frame.
func rawUpgrade(t *testing.T, r *rig) net.Conn {
	t.Helper()
	addr := strings.TrimPrefix(r.srv.URL, "http://")
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	fmt.Fprintf(c, "GET /stream%s HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"+
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", wstunneltest.Stream, addr, origin)
	resp, err := http.ReadResponse(bufio.NewReader(c), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade: %d", resp.StatusCode)
	}
	return c
}

// A client with no token declares a frame past the read limit, sends only part of it and goes
// quiet. The library's Close skips the rest of that frame with no deadline, so only closing the
// connection ends the tunnel.
func TestUnfinishedOversizeFrameDoesNotHoldTheTunnel(t *testing.T) {
	r := newRig(t, wstunnel.Options{FinalTimeout: 100 * time.Millisecond, FirstFrameTimeout: 100 * time.Millisecond}, nil)
	for range 5 {
		c := rawUpgrade(t, r)
		h := binary.BigEndian.AppendUint64([]byte{0x81, 0x80 | 127}, 1<<20)
		h = append(h, 0, 0, 0, 0) // the mask key
		if _, err := c.Write(append(h, make([]byte, 64<<10+10)...)); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := r.tunnel.Drain(ctx); err != nil {
		t.Fatalf("tunnels still open: %v", err)
	}
}
