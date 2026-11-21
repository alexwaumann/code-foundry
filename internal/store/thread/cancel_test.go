package thread

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// wireStep is one line of a probe capture (claudestream/testdata/*.wire.jsonl; Claude
// Code 2.1.284, docs/notes/cancel-queued-messages.md): "out" to Claude, "in" from it.
type wireStep struct {
	Dir string          `json:"dir"`
	Msg json.RawMessage `json:"msg"`
}

func wireSteps(t *testing.T, name string) []wireStep {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "claudestream", "testdata", name+".wire.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var out []wireStep
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var s wireStep
		if err := json.Unmarshal([]byte(l), &s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

// The captured streams through the projection, with the daemon's side of each cancel as
// cancel.go does it: the user's Cancel claims the message before it asks (so the
// "cancelled" lifecycle takes it back) and takes it back on {"cancelled":true}; an
// interrupt's hold asks without a claim and marks it unsent on {"cancelled":true}.
// "{"cancelled":false}" changes nothing: Claude read it.
func TestCancelCaptured(t *testing.T) {
	const pineapple, mango = "Also reply with the word PINEAPPLE.", "Also reply with the word MANGO."
	tests := []struct {
		fixture string
		// hold: the cancels are an interrupt's (holdUserQueued), not the user's Cancel.
		hold bool
		// gone: the messages (by text) that left the log as cancelled; unsent: the ones
		// marked not sent; read: the ones Claude read (ReadAt).
		gone, unsent, read []string
	}{
		{fixture: "cancel-queued", gone: []string{pineapple}},
		{fixture: "cancel-late", read: []string{pineapple}},
		{fixture: "cancel-first-of-two", gone: []string{pineapple}, read: []string{mango}},
		// The user's Cancel, then an interrupt: gone, and nothing starts.
		{fixture: "cancel-then-interrupt", gone: []string{pineapple}},
		// An interrupt with the message queued: held, not sent. The interrupted turn's own
		// prompt gets a "cancelled" lifecycle too, which changes nothing (it was read).
		{fixture: "cancel-then-interrupt", hold: true, unsent: []string{pineapple}},
		// Before this change (no hold): the interrupt started the queued message at once
		// as the next turn.
		{fixture: "interrupt-queued", read: []string{pineapple}},
	}
	for _, tt := range tests {
		name := tt.fixture
		if tt.hold {
			name += " (held by the interrupt)"
		}
		t.Run(name, func(t *testing.T) {
			log := newThreadLog("s", bus.New(), time.Now, nil)
			saved := map[string]Item{}
			w := itemWriter{log: log, save: func(it Item) { saved[it.ID] = it }}
			p := newProjector(w, runningTotals{known: true})
			ids := map[string]string{} // text -> item id
			cancelling := ""
			for _, s := range wireSteps(t, tt.fixture) {
				var m struct {
					Type    string `json:"type"`
					UUID    string `json:"uuid"`
					Message struct {
						Content []struct {
							Text string `json:"text"`
						} `json:"content"`
					} `json:"message"`
					Request struct {
						Subtype     string `json:"subtype"`
						MessageUUID string `json:"message_uuid"`
					} `json:"request"`
					Response struct {
						Response struct {
							Cancelled *bool `json:"cancelled"`
						} `json:"response"`
					} `json:"response"`
				}
				if err := json.Unmarshal(s.Msg, &m); err != nil {
					t.Fatal(err)
				}
				switch {
				case s.Dir == "out" && m.Type == "user":
					text := m.Message.Content[0].Text
					ids[text] = m.UUID
					// The first prompt goes to an idle Claude; the rest while it works.
					w.add(Item{ID: m.UUID, Kind: KindUserMessage, Text: text, Queued: len(ids) > 1})
				case s.Dir == "out" && m.Request.Subtype == "cancel_async_message":
					cancelling = m.Request.MessageUUID
					if !tt.hold {
						log.claimTakeBack(cancelling)
					}
				case s.Dir == "out":
				case m.Type == "control_response" && m.Response.Response.Cancelled != nil:
					if *m.Response.Response.Cancelled {
						if tt.hold {
							w.consume(cancelling, false)
						} else {
							w.takeBack(cancelling)
						}
					}
					log.releaseTakeBack(cancelling)
				default:
					p.event(claudestream.Parse(s.Msg))
				}
			}
			var gone, unsent, read []string
			for text, id := range ids {
				it, ok := log.get(id)
				switch {
				case !ok && log.wasCancelled(id) && saved[id].Cancelled && !saved[id].Queued:
					gone = append(gone, text)
				case !ok:
					t.Errorf("%q left the log, but not as cancelled (saved %+v)", text, saved[id])
				case it.Cancelled || it.Queued:
					t.Errorf("%q still in the log: %+v", text, it)
				case it.Unsent:
					unsent = append(unsent, text)
				case !it.ReadAt.IsZero():
					read = append(read, text)
				}
			}
			for _, got := range [][]string{gone, unsent, read} {
				slices.Sort(got)
			}
			if !slices.Equal(gone, tt.gone) || !slices.Equal(unsent, tt.unsent) || !slices.Equal(read, tt.read) {
				t.Errorf("gone %q unsent %q read %q; want gone %q unsent %q read %q", gone, unsent, read, tt.gone, tt.unsent, tt.read)
			}
			// The first prompt is never touched by a cancel, nor by its own "cancelled" lifecycle
			// at an interrupt.
			for text, id := range ids {
				if strings.HasPrefix(text, "Use the Bash tool") {
					if it, ok := log.get(id); !ok || it.Unsent || it.Cancelled {
						t.Errorf("the first prompt is %+v", it)
					}
				}
			}
			// A log loaded from the rows never has a cancelled message.
			var rows []Item
			for _, it := range saved {
				rows = append(rows, it)
			}
			rows = append(rows, log.snapshot().Items...)
			loaded := slices.DeleteFunc(slices.Clone(rows), func(it Item) bool { return it.Cancelled })
			for _, it := range newThreadLog("s", bus.New(), time.Now, dedupe(loaded)).snapshot().Items {
				if it.Cancelled {
					t.Errorf("reloaded log has %s", it.ID)
				}
			}
		})
	}
}

// dedupe keeps each id's last item.
func dedupe(items []Item) []Item {
	idx := map[string]int{}
	var out []Item
	for _, it := range items {
		if i, ok := idx[it.ID]; ok {
			out[i] = it
			continue
		}
		idx[it.ID] = len(out)
		out = append(out, it)
	}
	return out
}

// Cancel, Re-send and the interrupt's hold through the Manager with the fake claude: a
// message sent while a permission is pending is queued (TestSendWhileWorkingIsQueued).
func TestCancelQueuedMessage(t *testing.T) {
	tests := []struct {
		name string
		late bool // the fake answers {"cancelled":false}: Claude read it first
	}{
		{name: "queued: it leaves Claude's queue and the log"},
		{name: "Claude read it first: refused, nothing changes", late: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var vars []string
			if tt.late {
				vars = []string{"CF_FAKE_CLAUDE_CANCEL=late"}
			}
			re := newFixtureEnvAt(t, fixturePath("write-allow"), vars)
			s := re.create(CreateOptions{Model: "haiku", PermissionMode: PermissionSupervised, InitialPrompt: "create hello.txt"})
			re.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
			it, err := re.m.Send(re.ctx(), s.ID, Message{Text: "status?", ComposerText: "status?"})
			if err != nil || !it.Queued {
				t.Fatalf("send: %+v %v", it, err)
			}
			got, err := re.m.CancelMessage(re.ctx(), s.ID, it.ID)
			re.waitSent("the cancel", func(m map[string]any) bool {
				r, _ := m["request"].(map[string]any)
				return r["subtype"] == "cancel_async_message" && r["message_uuid"] == it.ID
			})
			if tt.late {
				if !errors.Is(err, ErrFailedPrecondition) || !errors.Is(err, errMessageRead) {
					t.Fatalf("cancel = %v, want already read", err)
				}
				if cur, ok := re.m.mustLog(t, s.ID).get(it.ID); !ok || !cur.Queued {
					t.Errorf("after a late cancel: %+v %v", cur, ok)
				}
				return
			}
			if err != nil || !got.Cancelled || got.Text != "status?" || got.ComposerText != "status?" {
				t.Fatalf("cancel = %+v, %v", got, err)
			}
			if slices.ContainsFunc(re.items(s.ID).Items, func(x Item) bool { return x.ID == it.ID }) {
				t.Error("the cancelled message is still in the items")
			}
			// Its row says it was cancelled; a log loaded from the rows leaves it out, and so do
			// prompt history and search.
			rows, err := scanItems(re.ctx(), re.m.opts.DB, s.ID, `SELECT ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data
				FROM thread_items WHERE thread_id = ? AND item_id = ?`, s.ID, it.ID)
			if err != nil || len(rows) != 1 || !rows[0].Cancelled {
				t.Errorf("row %+v %v", rows, err)
			}
			if loaded, _ := loadItems(re.ctx(), re.m.opts.DB, s.ID); slices.ContainsFunc(loaded, func(x Item) bool { return x.ID == it.ID }) {
				t.Error("loadItems has the cancelled message")
			}
			var prompts []string
			_ = scanPrompts(re.ctx(), re.m.opts.DB, s.ID, func(r promptRow) bool { prompts = append(prompts, r.text); return true })
			if slices.Contains(prompts, "status?") {
				t.Errorf("prompt history has it: %q", prompts)
			}
			// A second Cancel says so.
			if _, err := re.m.CancelMessage(re.ctx(), s.ID, it.ID); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "cancelled already") {
				t.Errorf("second cancel = %v", err)
			}
		})
	}
}

// An interrupt first takes the user's own queued messages out of Claude's queue (they
// become not sent and stay where they are), then interrupts; a wake's and another
// thread's queued messages are left in the queue. Re-send sends one again as a new
// message and drops the old one; Cancel drops a not sent one.
func TestInterruptHoldsUserQueued(t *testing.T) {
	re := newFixtureEnv(t, "write-allow")
	s := re.create(CreateOptions{Model: "haiku", PermissionMode: PermissionSupervised, InitialPrompt: "create hello.txt"})
	re.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	mine, err := re.m.Send(re.ctx(), s.ID, Message{Text: "status?"})
	if err != nil || !mine.Queued {
		t.Fatalf("send: %+v %v", mine, err)
	}
	// What other senders left queued (written straight into the log: only who sent them matters).
	log := re.m.mustLog(t, s.ID)
	w := re.m.writer(s.ID, log)
	w.add(Item{ID: "wake-1", Kind: KindUserMessage, Text: "child idle", Origin: OriginWake, WakeTitle: "child idle", Queued: true})
	w.add(Item{ID: "lead-1", Kind: KindUserMessage, Text: "also do X", SentBy: "lead", Queued: true})

	if err := re.m.Interrupt(re.ctx(), s.ID, ""); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, m := range re.sent() {
		if r, ok := m["request"].(map[string]any); ok && (r["subtype"] == "cancel_async_message" || r["subtype"] == "interrupt") {
			order = append(order, r["subtype"].(string)+":"+str(r["message_uuid"]))
		}
	}
	if want := []string{"cancel_async_message:" + mine.ID, "interrupt:"}; !slices.Equal(order, want) {
		t.Errorf("sent %v, want %v", order, want)
	}
	items := re.waitItems(s.ID, "the user's message not sent", func(items []Item) bool {
		i := slices.IndexFunc(items, func(x Item) bool { return x.ID == mine.ID })
		return i >= 0 && items[i].Unsent && !items[i].Queued
	})
	for _, id := range []string{"wake-1", "lead-1"} {
		if i := slices.IndexFunc(items, func(x Item) bool { return x.ID == id }); i < 0 || !items[i].Queued {
			t.Errorf("%s: not left queued: %+v", id, items)
		}
	}

	// Refusals.
	for _, tc := range []struct {
		item string
		want error
		msg  string
	}{
		{item: "nope", want: ErrNotFound},
		{item: "wake-1", want: ErrFailedPrecondition, msg: "a wake"},
		{item: "lead-1", want: ErrFailedPrecondition, msg: "sent by thread lead"},
		{item: items[0].ID, want: ErrFailedPrecondition, msg: "already read by Claude"}, // the first prompt
		{item: "", want: ErrInvalidArgument},
	} {
		if _, err := re.m.CancelMessage(re.ctx(), s.ID, tc.item); !errors.Is(err, tc.want) || !strings.Contains(err.Error(), tc.msg) {
			t.Errorf("cancel %q = %v, want %v %q", tc.item, err, tc.want, tc.msg)
		}
		if _, _, err := re.m.ResendMessage(re.ctx(), s.ID, tc.item); !errors.Is(err, tc.want) {
			t.Errorf("re-send %q = %v, want %v", tc.item, err, tc.want)
		}
	}
	if _, _, err := re.m.ResendMessage(re.ctx(), s.ID, "lead-1"); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("re-send of another thread's = %v", err)
	}

	// Re-send: a new message with the same text; the old one goes.
	again, gone, err := re.m.ResendMessage(re.ctx(), s.ID, mine.ID)
	if err != nil || again.ID == mine.ID || again.Text != "status?" || len(gone) != 0 {
		t.Fatalf("re-send = %+v %v %v", again, gone, err)
	}
	re.waitSent("the message again", func(m map[string]any) bool { return m["type"] == "user" && m["uuid"] == again.ID })
	if slices.ContainsFunc(re.items(s.ID).Items, func(x Item) bool { return x.ID == mine.ID }) {
		t.Error("the re-sent message is still in the items")
	}
	if _, err := re.m.CancelMessage(re.ctx(), s.ID, mine.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("cancel after re-send = %v", err)
	}

	// Cancel of a not sent one: no request, it just goes.
	w.add(Item{ID: "unsent-1", Kind: KindUserMessage, Text: "later", Unsent: true})
	before := len(re.sent())
	if got, err := re.m.CancelMessage(re.ctx(), s.ID, "unsent-1"); err != nil || !got.Cancelled || got.Text != "later" {
		t.Errorf("cancel unsent = %+v %v", got, err)
	}
	for _, m := range re.sent()[before:] {
		if r, ok := m["request"].(map[string]any); ok && r["subtype"] == "cancel_async_message" {
			t.Errorf("cancel of a not sent message asked Claude: %v", m)
		}
	}

	// An archived thread refuses both.
	w.add(Item{ID: "unsent-2", Kind: KindUserMessage, Text: "later", Unsent: true})
	if _, err := re.m.Archive(re.ctx(), s.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := re.m.CancelMessage(re.ctx(), s.ID, "unsent-2"); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "archived") {
		t.Errorf("cancel on an archived thread = %v", err)
	}
	if _, _, err := re.m.ResendMessage(re.ctx(), s.ID, "unsent-2"); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "archived") {
		t.Errorf("re-send on an archived thread = %v", err)
	}
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// Re-send keeps a gone attachment on show (the bubble draws it dashed) but sends without
// it, and says which.
func TestResendGoneAttachment(t *testing.T) {
	keep := filepath.Join(t.TempDir(), "keep.png")
	if err := os.WriteFile(keep, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	gonePath := filepath.Join(t.TempDir(), "gone.png")
	k, g := stagedStill([]string{keep, gonePath})
	if !slices.Equal(k, []string{keep}) || !slices.Equal(g, []string{gonePath}) {
		t.Errorf("stagedStill = %v %v", k, g)
	}
	o := &outgoing{text: "hi", shown: []string{keep, gonePath}}
	if it := userItem("u", o); !slices.Equal(it.Attachments, []string{keep, gonePath}) {
		t.Errorf("item attachments %v", it.Attachments)
	}
}
