package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/reflect/protoreflect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// runEvents is the events verb: EventService.Watch on stdout, one line per event, for
// agents and scripts that follow the daemon (docs/notes/agents-1-wait-events.md). It is
// a local verb because registry commands are unary. --json events carry the daemon's
// epoch; resuming with --since and --since-epoch across a daemon restart starts over
// with snapshots (docs/notes/agents-5-cli.md). Heartbeats are not printed. It ends
// on Ctrl-C or when a piped stdin closes (exit 0), or when the daemon goes away: exit 1
// with the --since and --since-epoch to resume with (docs/notes/orch-cli-batch.md).
func runEvents(ctx context.Context, cl *cli, args []string) error {
	fs := cl.newFlagSet("events")
	sourceFlag := fs.String("source", "", "comma-separated `sources` to follow (default all): "+strings.Join(eventSourceNames(), ", "))
	since := fs.Uint64("since", 0, "with --since-epoch, resume after this `seq` (the last one seen): replays the events after it if the daemon still has them, else starts with snapshots (as it does without --since-epoch)")
	sinceEpoch := fs.String("since-epoch", "", "with --since: the `epoch` that seq was read under (every --json event has it); "+
		"another daemon's epoch (it restarted) starts with snapshots instead of resuming")
	asJSON := fs.Bool("json", false, "print each event as one JSON object (protojson, with its seq and epoch)")
	if err := cl.parseFlags(fs, args); err != nil {
		return quietHelp(err)
	}
	sources, err := parseEventSources(*sourceFlag)
	if err != nil {
		fmt.Fprintf(cl.stderr, "code-foundry events: %s\n", err)
		return errUsage
	}
	if *since > 0 && *sinceEpoch == "" {
		// Without the epoch a seq cannot be told from a restarted daemon's same number
		// (E8: --since 2 replayed the new daemon's events and missed the restart).
		fmt.Fprintf(cl.stderr, "code-foundry events: --since %d without --since-epoch could be another daemon's seq; "+
			"starting with snapshots (pass both to resume)\n", *since)
		*since = 0
	}
	c, err := cl.connect(ctx)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if f, ok := cl.stdin.(*os.File); ok && isPipe(f) {
		// A supervising process ends the stream by closing the pipe.
		go func() {
			_, _ = io.Copy(io.Discard, f)
			cancel()
		}()
	}
	stream, err := c.Events.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: sources, SinceSeq: *since, SinceEpoch: *sinceEpoch, ClientKind: v1.ClientKind_CLIENT_KIND_CLI}))
	if err != nil {
		return cl.eventsFailed(ctx, err)
	}
	defer func() { _ = stream.Close() }()
	// Where a resume starts: the last live event's seq (snapshots have none) and the
	// epoch every event carries.
	last, epoch := *since, *sinceEpoch
	for stream.Receive() {
		ev := stream.Msg()
		if e := ev.GetEpoch(); e != "" && e != epoch {
			last, epoch = 0, e
		}
		if ev.GetSeq() > 0 {
			last = ev.GetSeq()
		}
		if ev.GetHeartbeat() != nil {
			continue
		}
		line := eventLine(ev)
		if *asJSON {
			b, err := protojson.Marshal(ev)
			if err != nil {
				return fmt.Errorf("encode event: %w", err)
			}
			line = string(b)
		}
		if _, err := fmt.Fprintln(cl.stdout, line); err != nil {
			return nil // stdout closed (| head): done
		}
	}
	if ctx.Err() != nil || errors.Is(stream.Err(), context.Canceled) {
		return nil // Ctrl-C, or the supervising process closed stdin
	}
	// The daemon never ends a stream while it runs: it went away (E8: exit 0 and
	// nothing on stderr looked like a normal end).
	fmt.Fprintln(cl.stderr, "code-foundry events: "+connectionLost(last, epoch, stream.Err()))
	return errReported
}

// connectionLost says the stream's daemon went away (err, when the stream had one) and
// how to resume after the last seq seen under epoch.
func connectionLost(last uint64, epoch string, err error) string {
	msg := "daemon connection lost"
	if err != nil {
		msg += " (" + err.Error() + ")"
	}
	if last == 0 || epoch == "" {
		return msg + "; run events again to start with snapshots"
	}
	return fmt.Sprintf("%s; resume with --since %d --since-epoch %s", msg, last, epoch)
}

// eventsFailed is a stream that did not start: nil when the user or stdin stopped it.
func (cl *cli) eventsFailed(ctx context.Context, err error) error {
	if err == nil || ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return nil
	}
	return fmt.Errorf("events: %w", err)
}

func isPipe(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&(os.ModeNamedPipe|os.ModeSocket) != 0
}

// eventSourceName is a source's --source name: EVENT_SOURCE_THREAD_LIST is thread-list.
func eventSourceName(s v1.EventSource) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimPrefix(s.String(), "EVENT_SOURCE_")), "_", "-")
}

// eventSourceNames lists the --source names in enum order.
func eventSourceNames() []string {
	var out []string
	for n := range v1.EventSource_name {
		if s := v1.EventSource(n); s != v1.EventSource_EVENT_SOURCE_UNSPECIFIED {
			out = append(out, eventSourceName(s))
		}
	}
	slices.SortFunc(out, func(a, b string) int {
		return int(v1.EventSource_value[sourceEnumName(a)]) - int(v1.EventSource_value[sourceEnumName(b)])
	})
	return out
}

func sourceEnumName(name string) string {
	return "EVENT_SOURCE_" + strings.ToUpper(strings.ReplaceAll(name, "-", "_"))
}

// parseEventSources reads --source: comma-separated names (thread-list or thread_list);
// empty means every source.
func parseEventSources(s string) ([]v1.EventSource, error) {
	var out []v1.EventSource
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		n, ok := v1.EventSource_value[sourceEnumName(strings.ToLower(part))]
		if !ok || n == 0 {
			return nil, fmt.Errorf("unknown source %q (sources: %s)", part, strings.Join(eventSourceNames(), ", "))
		}
		if src := v1.EventSource(n); !slices.Contains(out, src) {
			out = append(out, src)
		}
	}
	return out, nil
}

// eventLine is an event without --json: "<seq> <source> <what> [<key>][: <status>]",
// "-" for a snapshot's seq, e.g. "42 thread-list updated s-1a2b: busy (working)".
func eventLine(ev *v1.Event) string {
	seq := "-"
	if ev.GetSeq() > 0 {
		seq = strconv.FormatUint(ev.GetSeq(), 10)
	}
	m := ev.ProtoReflect()
	fd := m.WhichOneof(m.Descriptor().Oneofs().ByName("event"))
	if fd == nil {
		return seq + " (empty event)"
	}
	parts := []string{seq, strings.ReplaceAll(string(fd.Name()), "_", "-")}
	if fd.Message() == nil {
		return strings.Join(parts, " ")
	}
	inner := m.Get(fd).Message()
	what, val := firstSet(inner)
	if what == nil {
		return strings.Join(parts, " ")
	}
	parts = append(parts, strings.ReplaceAll(string(what.Name()), "_", "-"))
	line := strings.Join(parts, " ")
	switch {
	case what.Kind() == protoreflect.StringKind:
		return line + " " + val.String()
	case what.Kind() == protoreflect.Uint64Kind || what.Kind() == protoreflect.Int64Kind:
		// An epoch (skill epoch 3, plugin registry-epoch 2).
		return line + " " + val.String()
	case what.Message() == nil || what.IsList() || what.IsMap():
		return line
	}
	msg := val.Message()
	if key := messageKey(msg); key != "" {
		line += " " + key
	}
	if st := messageStatus(msg); st != "" {
		line += ": " + st
	}
	return line
}

// firstSet is the event's case: the set field of its oneof, else its first set field.
func firstSet(m protoreflect.Message) (protoreflect.FieldDescriptor, protoreflect.Value) {
	if oo := m.Descriptor().Oneofs(); oo.Len() > 0 {
		if fd := m.WhichOneof(oo.Get(0)); fd != nil {
			return fd, m.Get(fd)
		}
	}
	var fd protoreflect.FieldDescriptor
	var v protoreflect.Value
	m.Range(func(f protoreflect.FieldDescriptor, val protoreflect.Value) bool {
		fd, v = f, val
		return false
	})
	return fd, v
}

// keyFields name what an event is about, in order of preference.
var keyFields = []protoreflect.Name{"id", "thread_id", "run_id", "path", "worktree_path", "repo_slug", "slug", "name"}

func messageKey(m protoreflect.Message) string {
	fields := m.Descriptor().Fields()
	for _, n := range keyFields {
		if fd := fields.ByName(n); fd != nil && fd.Kind() == protoreflect.StringKind {
			if s := m.Get(fd).String(); s != "" {
				return s
			}
		}
	}
	return ""
}

// messageStatus is a thread's "status (reason)" (or any message with those fields).
func messageStatus(m protoreflect.Message) string {
	fields := m.Descriptor().Fields()
	fd := fields.ByName("status")
	if fd == nil || fd.Kind() != protoreflect.EnumKind {
		return ""
	}
	v := fd.Enum().Values().ByNumber(m.Get(fd).Enum())
	if v == nil {
		return ""
	}
	name := string(v.Name())
	if i := strings.Index(name, "_STATUS_"); i >= 0 {
		name = name[i+len("_STATUS_"):]
	}
	st := strings.ReplaceAll(strings.ToLower(name), "_", " ")
	if r := fields.ByName("status_reason"); r != nil {
		if s := m.Get(r).String(); s != "" {
			st += " (" + s + ")"
		}
	}
	return st
}
