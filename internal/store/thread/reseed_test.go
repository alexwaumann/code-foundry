package thread

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// sentTexts are the user messages' texts the fake got, in order.
func (e *env) sentTexts() []string {
	var out []string
	for _, m := range e.sent() {
		if t := userTextOf(m); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// lastUser is the last user message item.
func lastUser(items []Item) Item {
	for i := len(items) - 1; i >= 0; i-- {
		if items[i].Kind == KindUserMessage {
			return items[i]
		}
	}
	return Item{}
}

func TestCleanSeed(t *testing.T) {
	tests := []struct {
		name           string
		prompt, prefix string
		dirs           []string
		want           seed
		wantErr        bool
	}{
		{name: "empty"},
		{name: "trimmed, dirs cleaned and once", prompt: " p ", prefix: "\nx\n", dirs: []string{"/a/b/", " ", "/a/b", "/c/../d"},
			want: seed{prompt: "p", prefix: "x", dirs: []string{"/a/b", "/d"}}},
		{name: "a relative dir", dirs: []string{"a/b"}, wantErr: true},
		{name: "a NUL", prompt: "a\x00b", wantErr: true},
		{name: "a NUL in the prefix", prefix: "\x00", wantErr: true},
		{name: "a long prompt", prompt: strings.Repeat("x", maxSystemPromptAppend+1), wantErr: true},
		{name: "a long prefix", prefix: strings.Repeat("x", maxSeedPrefix+1), wantErr: true},
		{name: "the longest prefix", prefix: strings.Repeat("x", maxSeedPrefix), want: seed{prefix: strings.Repeat("x", maxSeedPrefix)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := cleanSeed(tt.prompt, tt.dirs, tt.prefix)
			if tt.wantErr {
				if !errors.Is(err, ErrInvalidArgument) {
					t.Fatalf("err = %v, want invalid argument", err)
				}
				return
			}
			if err != nil || got.prompt != tt.want.prompt || got.prefix != tt.want.prefix || !slices.Equal(got.dirs, tt.want.dirs) {
				t.Errorf("= %+v, %v; want %+v", got, err, tt.want)
			}
		})
	}
}

// The reseed's holds are the idle stop's, without the effort change, the grace and the
// cache.
func TestReseedHoldOf(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	quiet := idleInputs{now: now, atPrompt: true, startedAt: now, cacheExpiresAt: now.Add(time.Hour), lastActive: now,
		cacheTTL: time.Hour, idleGrace: 5 * time.Minute, effortChange: true}
	tests := []struct {
		name string
		edit func(*idleInputs)
		want string
	}{
		{name: "quiet: warm cache, young process and an effort change do not hold", want: ""},
		{name: "busy", edit: func(in *idleInputs) { in.atPrompt = false }, want: "busy"},
		{name: "a pending request", edit: func(in *idleInputs) { in.pendingRequest = true }, want: "pending request"},
		{name: "background work", edit: func(in *idleInputs) { in.backgroundWork = true }, want: "background work"},
		{name: "a message on its way", edit: func(in *idleInputs) { in.messageOnItsWay = true }, want: "message on its way"},
		{name: "starting", edit: func(in *idleInputs) { in.starting = true }, want: "starting"},
		{name: "closing", edit: func(in *idleInputs) { in.closing = true }, want: "closing"},
		{name: "an unfinished item", edit: func(in *idleInputs) { in.unfinishedItem = true }, want: "unfinished item"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := quiet
			if tt.edit != nil {
				tt.edit(&in)
			}
			if got := reseedHoldOf(in); got != tt.want {
				t.Errorf("reseedHoldOf = %q, want %q", got, tt.want)
			}
		})
	}
	if idleHoldOf(quiet) == "" {
		t.Errorf("the idle stop should hold the same inputs")
	}
}

// A stopped thread records the reseed; its next message starts a new conversation with
// the seed, the prefix before that message only.
func TestReseedStopped(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "worker", InitialPrompt: "first"})
	e.waitFor(s.ID, "the turn", turnOver)
	cid := argOf(e.argvOf(), "--session-id")
	e.writeTranscript(cid, userLine("first"))
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	before := e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
	if before.Epoch != 1 || before.ContextTokens == 0 {
		t.Fatalf("before = epoch %d, context %d; want 1 and some", before.Epoch, before.ContextTokens)
	}
	dir := t.TempDir()
	got, stopped, err := e.m.Reseed(e.ctx(), s.ID, ReseedOptions{SystemPromptAppend: "You are the worker.", AddDirs: []string{dir}, Prefix: "MEMORY: tangerine"})
	if err != nil || stopped || got.Epoch != 2 || !got.FreshStart || got.SeedPrefix != "MEMORY: tangerine" || got.ContextTokens != 0 || got.ReseedPending {
		t.Fatalf("Reseed = %+v, %v, %v", got, stopped, err)
	}
	// Persisted.
	e.restart()
	if got, _ := e.m.Get(e.ctx(), s.ID); got.Epoch != 2 || !got.FreshStart || got.SeedPrefix != "MEMORY: tangerine" ||
		got.SystemPromptAppend != "You are the worker." || !slices.Equal(got.SpawnAddDirs, []string{dir}) {
		t.Fatalf("after a restart = %+v", got)
	}

	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "hello"}); err != nil {
		t.Fatal(err)
	}
	argv := e.waitArgv("the fresh start", func(a []string) bool { return argOf(a, "--session-id") != cid && argOf(a, "--session-id") != "" })
	if slices.Contains(argv, "--resume") || !strings.HasSuffix(argOf(argv, "--append-system-prompt"), "\n\nYou are the worker.") ||
		!slices.Contains(argv, dir) {
		t.Errorf("argv %q", argv)
	}
	e.waitSent("the seeded message", func(m map[string]any) bool { return userTextOf(m) == "MEMORY: tangerine\n\nhello" })
	items := e.waitItems(s.ID, "the turn", func(items []Item) bool { return lastUser(items).SeedPrefix != "" && hasTurnEnd(items) })
	if u := lastUser(items); u.Text != "hello" || u.SeedPrefix != "MEMORY: tangerine" {
		t.Errorf("item = %+v", u)
	}
	after := e.waitFor(s.ID, "the seed sent", func(s Thread) bool { return s.SeedPrefix == "" && turnOver(s) })
	if after.FreshStart || after.Epoch != 2 || after.ClaudeSessionID == cid || after.Name != "worker" || after.LastError != "" {
		t.Errorf("after = %+v", after)
	}
	// The next message has no prefix, and a later start resumes the new conversation.
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	e.waitSent("the plain message", func(m map[string]any) bool { return userTextOf(m) == "again" })
	if n := len(slices.DeleteFunc(e.sentTexts(), func(t string) bool { return !strings.HasPrefix(t, "MEMORY") })); n != 1 {
		t.Errorf("the prefix went %d times", n)
	}
	// The items are kept: both conversations' messages are in the thread.
	var texts []string
	for _, it := range e.items(s.ID).Items {
		if it.Kind == KindUserMessage {
			texts = append(texts, it.Text)
		}
	}
	if !slices.Equal(texts, []string{"first", "hello", "again"}) {
		t.Errorf("user items = %q", texts)
	}
}

// A connected thread idle at its prompt stops at once; its next message starts fresh.
func TestReseedIdleStops(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "idle"})
	cid := argOf(e.argvOf(), "--session-id")
	got, stopped, err := e.m.Reseed(e.ctx(), s.ID, ReseedOptions{Prefix: "seed"})
	if err != nil || !stopped || got.Epoch != 2 {
		t.Fatalf("Reseed = %+v, %v, %v", got, stopped, err)
	}
	off := e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
	if off.DisconnectReason != ReasonReseed || off.ReseedPending || off.ContextTokens != 0 || !off.FreshStart {
		t.Errorf("stopped = %+v", off)
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "go"}); err != nil {
		t.Fatal(err)
	}
	e.waitSent("the seeded message", func(m map[string]any) bool { return userTextOf(m) == "seed\n\ngo" })
	if argv := e.argvOf(); slices.Contains(argv, "--resume") || argOf(argv, "--session-id") == cid {
		t.Errorf("argv %q", argv)
	}
}

// A thread waiting on a permission prompt keeps its process until the turn is over
// (ReseedPending meanwhile), then stops.
func TestReseedWaitsForTheTurn(t *testing.T) {
	e := newFixtureEnv(t, "write-allow")
	s := e.create(CreateOptions{PermissionMode: PermissionSupervised, InitialPrompt: "write"})
	e.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	got, stopped, err := e.m.Reseed(e.ctx(), s.ID, ReseedOptions{Prefix: "seed"})
	if err != nil || stopped || !got.ReseedPending || got.Epoch != 2 {
		t.Fatalf("Reseed = %+v, %v, %v", got, stopped, err)
	}
	time.Sleep(50 * time.Millisecond)
	if got, _ := e.m.Get(e.ctx(), s.ID); got.State != StateConnected || !got.ReseedPending {
		t.Fatalf("stopped mid-turn: %+v", got)
	}
	p := e.items(s.ID).Pending
	if _, err := e.m.Respond(e.ctx(), s.ID, p[0].RequestID, Decision{Allow: true}); err != nil {
		t.Fatal(err)
	}
	off := e.waitFor(s.ID, "stopped after the turn", func(s Thread) bool { return s.State == StateDisconnected })
	if off.DisconnectReason != ReasonReseed || off.ReseedPending || off.ContextTokens != 0 || !off.FreshStart || off.SeedPrefix != "seed" {
		t.Errorf("stopped = %+v", off)
	}
	if items := e.items(s.ID).Items; !hasTurnEnd(items) {
		t.Errorf("the turn did not end before the stop:\n%s", describeItems(items))
	}
}

func TestReseedRefusals(t *testing.T) {
	e := newEnv(t)
	s := e.stopped("x")
	for _, o := range []ReseedOptions{{AddDirs: []string{"rel"}}, {Prefix: "a\x00"}} {
		if _, _, err := e.m.Reseed(e.ctx(), s.ID, o); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("Reseed(%+v) err = %v", o, err)
		}
	}
	if _, _, err := e.m.Reseed(e.ctx(), "s-nope", ReseedOptions{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread err = %v", err)
	}
	// An empty seed clears the thread's.
	if _, _, err := e.m.Reseed(e.ctx(), s.ID, ReseedOptions{SystemPromptAppend: "a", AddDirs: []string{"/tmp"}}); err != nil {
		t.Fatal(err)
	}
	got, _, err := e.m.Reseed(e.ctx(), s.ID, ReseedOptions{})
	if err != nil || got.Epoch != 3 || got.SystemPromptAppend != "" || got.SpawnAddDirs != nil || got.SeedPrefix != "" {
		t.Errorf("cleared = %+v, %v", got, err)
	}
}

func TestEnsureResident(t *testing.T) {
	e := newEnv(t)
	cwd := filepath.Join(e.home, "residents", "ember")
	r, created, err := e.m.EnsureResident(e.ctx(), "ember", ResidentOptions{Cwd: cwd, DisplayName: "Ember", Model: "haiku", Effort: "low",
		SystemPromptAppend: "You are Ember.", Prefix: "MEMORY: none yet"})
	if err != nil || !created {
		t.Fatalf("EnsureResident = %+v, %v, %v", r, created, err)
	}
	if r.Kind != KindResident || r.ResidentName != "ember" || r.Name != "Ember" || r.WorktreePath != cwd || r.ProjectID != "" ||
		r.State != StateDisconnected || r.Epoch != 1 || r.Model != "haiku" {
		t.Errorf("resident = %+v", r)
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		t.Errorf("cwd not made: %v", err)
	}
	again, created, err := e.m.EnsureResident(e.ctx(), "ember", ResidentOptions{Cwd: "/elsewhere", DisplayName: "Other"})
	if err != nil || created || again.ID != r.ID || again.Name != "Ember" {
		t.Errorf("again = %+v, %v, %v", again, created, err)
	}
	for _, bad := range []struct {
		name string
		o    ResidentOptions
	}{{"Ember", ResidentOptions{Cwd: cwd}}, {"", ResidentOptions{Cwd: cwd}}, {"other", ResidentOptions{Cwd: "rel"}},
		{"other", ResidentOptions{Cwd: cwd, Effort: "loud"}}} {
		if _, _, err := e.m.EnsureResident(e.ctx(), bad.name, bad.o); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("EnsureResident(%q, %+v) err = %v", bad.name, bad.o, err)
		}
	}

	// Left out of lists unless asked for.
	user := e.stopped("user's")
	ids := func(o ListOptions) []string {
		list, err := e.m.List(e.ctx(), o)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, t := range list {
			out = append(out, t.ID)
		}
		slices.Sort(out)
		return out
	}
	both := []string{r.ID, user.ID}
	slices.Sort(both)
	if got := ids(ListOptions{}); !slices.Equal(got, []string{user.ID}) {
		t.Errorf("List = %v, want only the user's", got)
	}
	if got := ids(ListOptions{IncludeResident: true}); !slices.Equal(got, both) {
		t.Errorf("List with residents = %v", got)
	}
	if got := ids(ListOptions{All: true}); !slices.Equal(got, both) {
		t.Errorf("List all = %v", got)
	}

	// It refuses what would end or copy it.
	if _, err := e.m.Archive(e.ctx(), r.ID, true); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("Archive err = %v", err)
	}
	if _, err := e.m.Snooze(e.ctx(), r.ID, time.Now().Add(time.Hour)); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("Snooze err = %v", err)
	}
	if err := e.m.Remove(e.ctx(), r.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("Remove err = %v", err)
	}
	if _, err := e.m.Fork(e.ctx(), r.ID, ""); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("Fork err = %v", err)
	}
	if _, err := e.m.Archive(e.ctx(), r.ID, false); err != nil {
		t.Errorf("unarchive (a no-op) err = %v", err)
	}

	// A message starts it in its directory with its seed; it keeps its name.
	if _, err := e.m.Send(e.ctx(), r.ID, Message{Text: "Plan my day"}); err != nil {
		t.Fatal(err)
	}
	e.waitSent("the seeded message", func(m map[string]any) bool { return userTextOf(m) == "MEMORY: none yet\n\nPlan my day" })
	spawn := e.spec(r.ID)
	if realPath(spawn.Cwd) != realPath(cwd) || slices.Contains(spawn.Argv, "--resume") || !strings.HasSuffix(argOf(spawn.Argv, "--append-system-prompt"), "You are Ember.") {
		t.Errorf("spawn = %+v", spawn)
	}
	got := e.waitFor(r.ID, "the turn", func(s Thread) bool { return turnOver(s) && s.SeedPrefix == "" })
	if got.Name != "Ember" || got.NameProvisional || got.AutoNamed || got.LastError != "" || got.FreshStart {
		t.Errorf("after the turn = %+v", got)
	}
	e.mu.Lock()
	named := slices.Clone(e.named)
	e.mu.Unlock()
	if slices.Contains(named, "Plan my day") {
		t.Errorf("the namer ran for the resident: %q", named)
	}

	// Its children are created by it as usual.
	child := e.create(CreateOptions{Name: "child", CreatedBy: r.ID})
	if child.CreatedBy != r.ID || child.Kind != KindNormal {
		t.Errorf("child = %+v", child)
	}

	// One per name, across a restart.
	e.restart()
	again, created, err = e.m.EnsureResident(e.ctx(), "ember", ResidentOptions{Cwd: cwd})
	if err != nil || created || again.ID != r.ID || again.Kind != KindResident || again.Epoch != 1 {
		t.Errorf("after a restart = %+v, %v, %v", again, created, err)
	}
	other, created, err := e.m.EnsureResident(e.ctx(), "scout", ResidentOptions{Cwd: filepath.Join(e.home, "residents", "scout")})
	if err != nil || !created || other.ID == r.ID {
		t.Errorf("a second resident = %+v, %v, %v", other, created, err)
	}
}
