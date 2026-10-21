package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// errConnLost: the daemon went away during a call the CLI was still waiting on (it
// stopped or restarted: `daemon restart`, an update's `app restart`, quitting the app).
// Exit 1, like any failure, with words that say what happened.
var errConnLost = errors.New("daemon connection lost (it stopped or restarted)")

// connLost reports whether err is the daemon going away rather than the CLI giving up:
// the call was cancelled (the daemon's handler context on shutdown) or the connection
// broke, while the CLI's own ctx is still live.
func connLost(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	c := connect.CodeOf(err)
	return c == connect.CodeCanceled || c == connect.CodeUnavailable
}

// rewaitDefaultFor is thread.wait's and thread.send's default for, when the command's
// spec does not say.
const rewaitDefaultFor = 10 * time.Minute

// rewait retries a wait the daemon dropped by going away, once, for the time left of
// its --for: thread.wait as it was, and the wait half of thread.send --wait as a
// thread.wait (the message was sent; sending again would repeat it). Connect brings the
// daemon back (starting it when none runs). Anything else, or no time left, keeps err.
func (cl *cli) rewait(ctx context.Context, cmd *v1.Command, uctx *v1.UiContext, vals map[string]string, spent time.Duration, err error) (*v1.InvokeCommandResponse, error) {
	name := cmd.GetName()
	wait := map[string]string{}
	switch name {
	case "thread.wait":
		for k, v := range vals {
			wait[k] = v
		}
	case "thread.send":
		if b, _ := strconv.ParseBool(vals["wait"]); !b {
			return nil, err
		}
		if id := vals["id"]; id != "" {
			wait["id"] = id
		}
	default:
		return nil, err
	}
	limit := rewaitDefaultFor
	for _, a := range cmd.GetArgs() {
		if a.GetName() == "for" && a.GetDefaultValue() != "" {
			if d, perr := time.ParseDuration(a.GetDefaultValue()); perr == nil {
				limit = d
			}
		}
	}
	if v := strings.TrimSpace(vals["for"]); v != "" {
		d, perr := time.ParseDuration(v)
		if perr != nil {
			return nil, err
		}
		limit = d
	}
	left := (limit - spent).Truncate(time.Second)
	if left < time.Second {
		return nil, err
	}
	wait["for"] = left.String()
	fmt.Fprintf(cl.stderr, "code-foundry %s: the daemon stopped or restarted while waiting; waiting again for %s\n", name, left)
	return cl.invoke(ctx, &v1.Command{Name: "thread.wait"}, uctx, wait, false)
}
