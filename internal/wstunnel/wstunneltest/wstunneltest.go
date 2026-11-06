// Package wstunneltest is the client side of internal/wstunnel for tests: what the GUI's
// fetch shim does on the wire, and a real Connect stream to carry.
package wstunneltest

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// Procedures of the real services a test can use.
const (
	Stream = codefoundryv1connect.TerminalServiceAttachProcedure
	Unary  = codefoundryv1connect.HealthServicePingProcedure
	// ClientStream is the one client-streaming procedure.
	ClientStream = codefoundryv1connect.DictationServiceAudioProcedure
)

// EndStream is the Connect envelope flag of the stream's last message.
const EndStream = 2

// Attach is a real Connect TerminalService.Attach handler running fn, and its path.
func Attach(fn func(context.Context, *connect.ServerStream[v1.AttachEvent]) error) (string, http.Handler) {
	return Stream, connect.NewServerStreamHandler(Stream,
		func(ctx context.Context, _ *connect.Request[v1.AttachRequest], s *connect.ServerStream[v1.AttachEvent]) error {
			return fn(ctx, s)
		})
}

// Output is an AttachEvent carrying data.
func Output(data []byte) *v1.AttachEvent {
	return &v1.AttachEvent{Event: &v1.AttachEvent_Output_{Output: &v1.AttachEvent_Output{Data: data}}}
}

// Dial is what Client opens a socket with.
type Dial struct {
	URL string // ws://host:port/stream/<procedure>
	// Origins are sent as Origin headers, one each; none sends no Origin.
	Origins []string
	// Host overrides the Host header.
	Host string
	// Header is added to the upgrade.
	Header http.Header
	// Subprotocols are offered on the upgrade.
	Subprotocols []string
	// HTTPClient dials, for a listener that is not TCP. Nil: the default.
	HTTPClient *http.Client
}

// Client is one tunnel's client end.
type Client struct {
	Conn *websocket.Conn
}

// Open upgrades. On a refused upgrade the response has the status.
func (d Dial) Open(ctx context.Context) (*Client, *http.Response, error) {
	h := d.Header.Clone()
	if h == nil {
		h = http.Header{}
	}
	for _, o := range d.Origins {
		h.Add("Origin", o)
	}
	c, resp, err := websocket.Dial(ctx, d.URL, &websocket.DialOptions{HTTPHeader: h, Host: d.Host, Subprotocols: d.Subprotocols, HTTPClient: d.HTTPClient})
	if err != nil {
		return nil, resp, fmt.Errorf("dial tunnel: %w", err)
	}
	c.SetReadLimit(-1)
	return &Client{Conn: c}, resp, nil
}

// Headers is a head for a Connect streaming call with token; empty sends no Authorization.
func Headers(token string) map[string]string {
	h := map[string]string{"Content-Type": "application/connect+proto", "Connect-Protocol-Version": "1"}
	if token != "" {
		h["Authorization"] = "Bearer " + token
	}
	return h
}

// Body is a one-message Connect streaming request body.
func Body(m proto.Message) ([]byte, error) {
	b, err := proto.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
	out := make([]byte, 5, 5+len(b))
	binary.BigEndian.PutUint32(out[1:], uint32(len(b)))
	return append(out, b...), nil
}

// Send sends the head and the body.
func (c *Client) Send(ctx context.Context, headers map[string]string, body []byte) error {
	head, err := json.Marshal(map[string]any{"headers": headers})
	if err != nil {
		return fmt.Errorf("marshal head: %w", err)
	}
	if err := c.Conn.Write(ctx, websocket.MessageText, head); err != nil {
		return fmt.Errorf("send head: %w", err)
	}
	if err := c.Conn.Write(ctx, websocket.MessageBinary, body); err != nil {
		return fmt.Errorf("send body: %w", err)
	}
	return nil
}

// Head is the response head.
type Head struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Counts  bool              `json:"counts"`
}

// ReadHead reads the response head, which must be the next message.
func (c *Client) ReadHead(ctx context.Context) (Head, error) {
	typ, b, err := c.Conn.Read(ctx)
	if err != nil {
		return Head{}, fmt.Errorf("read head: %w", err)
	}
	if typ != websocket.MessageText {
		return Head{}, errors.New("read head: not a text message")
	}
	var h Head
	if err := json.Unmarshal(b, &h); err != nil {
		return Head{}, fmt.Errorf("read head: %w", err)
	}
	return h, nil
}

// Frame is one Connect envelope.
type Frame struct {
	Flags   byte
	Payload []byte
}

// End reports whether this is the stream's last message.
func (f Frame) End() bool { return f.Flags&EndStream != 0 }

// ReadFrame reads the next binary message, which must be exactly one envelope.
func (c *Client) ReadFrame(ctx context.Context) (Frame, error) {
	typ, b, err := c.Conn.Read(ctx)
	if err != nil {
		return Frame{}, fmt.Errorf("read frame: %w", err)
	}
	if typ != websocket.MessageBinary || len(b) < 5 || int(binary.BigEndian.Uint32(b[1:5])) != len(b)-5 {
		return Frame{}, fmt.Errorf("read frame: not one envelope (%d bytes)", len(b))
	}
	return Frame{Flags: b[0], Payload: b[5:]}, nil
}

// Ack tells the daemon how many body bytes the client has taken so far.
func (c *Client) Ack(ctx context.Context, n int64) error {
	if err := c.Conn.Write(ctx, websocket.MessageText, []byte(strconv.FormatInt(n, 10))); err != nil {
		return fmt.Errorf("send count: %w", err)
	}
	return nil
}

// ReadClose reads until the daemon closes and returns the close code, -1 when the socket
// went without one.
func (c *Client) ReadClose(ctx context.Context) websocket.StatusCode {
	for {
		if _, _, err := c.Conn.Read(ctx); err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

// Contains reports whether f is an end of stream carrying a Connect error whose JSON has s.
func (f Frame) Contains(s string) bool { return f.End() && strings.Contains(string(f.Payload), s) }
