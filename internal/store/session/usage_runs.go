package session

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

// A thread's usage is the sum of its sources (docs/notes/session-usage.md, PR 2):
//
//   - every transcript file the thread has used: Claude moves to a new one on /clear
//     (Session.Transcripts), and
//   - every subagent run under them: <project dir>/<claude session id>/subagents/
//     agent-<id>.jsonl, with agent-<id>.meta.json beside it (agentMeta).
//
// Each source has its own usageFold (its own streaming-repeat state). threadUsage holds
// them for the runner and decides, from the transcripts alone, which runs to follow:
//
//   - an Agent tool_use starts one (matched to its meta file's toolUseId; or by the
//     agentId of the tool use's result, whichever comes first),
//   - the tool use's result closes it, unless its status is async_launched (a
//     background run), which keeps it open until a <task-notification> naming the
//     agent id; any other result (completed, an error, an interrupt) closes it,
//   - a SendMessage result with resumedAgentId opens it again (the run appends to its
//     own file).
//
// Runs spawned by runs (spawnDepth 2+) write their meta and transcript into the same
// subagents/ directory and their lifecycle into their parent run's file, which is
// followed the same way, so they are live too. Closing a run drains its file once more
// and keeps its fold; only the file handle goes.

// AgentRun is one subagent run of a thread. Persisted (session_agent_runs; its Usage in
// session_source_usage).
type AgentRun struct {
	ID              string // Claude's agent id: agent-<ID>.jsonl
	ClaudeSessionID string // the transcript whose subagents/ directory holds the run
	ToolUseID       string // the Agent tool_use that spawned it; "" if never seen
	Description     string
	AgentType       string // "general-purpose", "Explore", ...
	Model           string // as requested: "haiku", "opus"; "" when inherited
	Effort          string
	SpawnDepth      int  // 1: spawned by the thread; 2+: by another run
	Background      bool // run_in_background, or launched async
	// Open: the run is still followed (its result has not reached the transcript).
	Open bool
	// StartedAt is the time of the run's first record; zero if unknown.
	StartedAt time.Time
	// Usage is the run's own fold, sorted like Session.Usage. Included in Session.Usage.
	Usage []UsageBucket
}

// sameRunInfo compares everything but Usage.
func sameRunInfo(a, b AgentRun) bool {
	a.Usage, b.Usage = nil, nil
	return a.ID == b.ID && a.ClaudeSessionID == b.ClaudeSessionID && a.ToolUseID == b.ToolUseID &&
		a.Description == b.Description && a.AgentType == b.AgentType && a.Model == b.Model &&
		a.Effort == b.Effort && a.SpawnDepth == b.SpawnDepth && a.Background == b.Background &&
		a.Open == b.Open && a.StartedAt.Equal(b.StartedAt)
}

func sameRuns(a, b []AgentRun) bool {
	return slices.EqualFunc(a, b, func(x, y AgentRun) bool { return sameRunInfo(x, y) && slices.Equal(x.Usage, y.Usage) })
}

// Source ids of session_source_usage.
func transcriptSource(cid string) string { return "t:" + cid }
func runSource(agentID string) string    { return "a:" + agentID }

// Safety net: a run whose file has not grown for this long while the thread sits at
// its prompt is closed, in case Claude never writes its closing record. A background
// run legitimately runs on while the thread is idle (a long build), so it gets
// backgroundIdleFactor times longer.
const (
	defaultAgentIdleClose = 10 * time.Minute
	backgroundIdleFactor  = 6
)

// ---- run lifecycle records ----

type runEventKind uint8

const (
	runSpawned  runEventKind = iota + 1 // an Agent tool_use
	runResult                           // a tool_result (agentId and status when it names a run)
	runNotified                         // a <task-notification> for a task (agent) id
	runResumed                          // a SendMessage result that resumed an agent
)

type runEvent struct {
	kind      runEventKind
	at        time.Time // the record's timestamp; zero if it had none
	toolUseID string
	agentID   string
	status    string // runResult: toolUseResult.status ("completed", "async_launched"); runNotified: <status>
	// runSpawned: the tool_use input. runResult: what toolUseResult says.
	background                            bool
	description, agentType, model, effort string
}

var (
	quotedAgentTool     = []byte(`"name":"Agent"`)
	quotedTaskTool      = []byte(`"name":"Task"`) // the tool's name before Claude Code 2.1
	quotedToolUseResult = []byte(`"toolUseResult"`)
	quotedToolUseID     = []byte(`"tool_use_id"`)
	quotedAgentID       = []byte(`"agentId"`)
	quotedResumedID     = []byte(`"resumedAgentId"`)
	taskNotification    = []byte(`<task-notification>`)

	notifyTaskID = regexp.MustCompile(`<task-id>([^<]*)</task-id>`)
	notifyStatus = regexp.MustCompile(`<status>([^<]*)</status>`)
)

// runRecord is the subset of a transcript record that run lifecycle reads.
type runRecord struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Operation string          `json:"operation"` // queue-operation
	Content   json.RawMessage `json:"content"`   // queue-operation
	Message   *struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
	ToolUseResult json.RawMessage `json:"toolUseResult"`
}

type contentBlock struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	ToolUseID string `json:"tool_use_id"`
	Input     *struct {
		Description     string `json:"description"`
		SubagentType    string `json:"subagent_type"`
		Model           string `json:"model"`
		Effort          string `json:"effort"`
		RunInBackground bool   `json:"run_in_background"`
	} `json:"input"`
}

type toolUseResult struct {
	Status         string `json:"status"`
	AgentID        string `json:"agentId"`
	ResumedAgentID string `json:"resumedAgentId"`
	AgentType      string `json:"agentType"`
	Description    string `json:"description"`
	IsAsync        bool   `json:"isAsync"`
}

// unmarshalLoose decodes like json.Unmarshal but keeps what it could decode when only
// a field's type did not match (Go fills every other field; toolUseResult is a string
// for some tools, an object for others).
func unmarshalLoose(data []byte, v any) bool {
	err := json.Unmarshal(data, v)
	var te *json.UnmarshalTypeError
	return err == nil || errors.As(err, &te)
}

// parseRunEvents returns the run lifecycle events in one transcript line (of the
// thread or of a run). Lines are rejected by byte searches before any decoding.
// watched reports whether a tool_result line names a tool use the caller is waiting
// on (its result may carry no agentId: an error, an interrupt). Records timestamped
// before notBefore are a fork's copy of its parent's history and are skipped.
func parseRunEvents(line []byte, notBefore time.Time, watched func([]byte) bool) (out []runEvent) {
	spawn := bytes.Contains(line, quotedAgentTool) || bytes.Contains(line, quotedTaskTool)
	result := bytes.Contains(line, quotedToolUseResult) && bytes.Contains(line, quotedToolUseID) &&
		(bytes.Contains(line, quotedAgentID) || bytes.Contains(line, quotedResumedID) || (watched != nil && watched(line)))
	notify := bytes.Contains(line, taskNotification)
	if !spawn && !result && !notify {
		return nil
	}
	var rec runRecord
	if !unmarshalLoose(line, &rec) {
		return nil
	}
	ts, tsErr := time.Parse(time.RFC3339Nano, rec.Timestamp)
	if tsErr == nil && ts.Before(notBefore) {
		return nil
	}
	defer func() {
		for i := range out {
			out[i].at = ts
		}
	}()
	switch rec.Type {
	case "assistant":
		if rec.Message == nil {
			return nil
		}
		var blocks []contentBlock
		if !unmarshalLoose(rec.Message.Content, &blocks) {
			return nil
		}
		for _, b := range blocks {
			if b.Type != "tool_use" || (b.Name != "Agent" && b.Name != "Task") || b.ID == "" {
				continue
			}
			ev := runEvent{kind: runSpawned, toolUseID: b.ID}
			if in := b.Input; in != nil {
				ev.background, ev.description, ev.agentType, ev.model, ev.effort =
					in.RunInBackground, in.Description, in.SubagentType, in.Model, in.Effort
			}
			out = append(out, ev)
		}
	case "user":
		if rec.Message == nil {
			return nil
		}
		var text string
		if json.Unmarshal(rec.Message.Content, &text) == nil {
			out = notification(text)
			return out
		}
		var blocks []contentBlock
		if !unmarshalLoose(rec.Message.Content, &blocks) {
			return nil
		}
		var res toolUseResult
		if len(rec.ToolUseResult) > 0 {
			unmarshalLoose(rec.ToolUseResult, &res)
		}
		for _, b := range blocks {
			if b.Type != "tool_result" || b.ToolUseID == "" {
				continue
			}
			if res.ResumedAgentID != "" {
				out = append(out, runEvent{kind: runResumed, toolUseID: b.ToolUseID, agentID: res.ResumedAgentID})
				continue
			}
			out = append(out, runEvent{kind: runResult, toolUseID: b.ToolUseID, agentID: res.AgentID, status: res.Status,
				background: res.IsAsync || res.Status == "async_launched", description: res.Description, agentType: res.AgentType})
		}
	case "queue-operation":
		var text string
		if rec.Operation == "enqueue" && json.Unmarshal(rec.Content, &text) == nil {
			out = notification(text)
		}
	}
	return out
}

// notification parses a <task-notification> message: Claude tells the thread a
// background task (for an agent, task-id is the agent id) stopped.
func notification(text string) []runEvent {
	if !strings.HasPrefix(strings.TrimSpace(text), string(taskNotification)) {
		return nil
	}
	m := notifyTaskID.FindStringSubmatch(text)
	if m == nil || m[1] == "" {
		return nil
	}
	ev := runEvent{kind: runNotified, agentID: strings.TrimSpace(m[1])}
	if s := notifyStatus.FindStringSubmatch(text); s != nil {
		ev.status = s[1]
	}
	return []runEvent{ev}
}

// agentMeta is agent-<id>.meta.json, written when a run is spawned. Claude rewrites it
// when the user stops a run, keeping only agentType: merge, never overwrite with "".
type agentMeta struct {
	AgentType    string `json:"agentType"`
	Description  string `json:"description"`
	ToolUseID    string `json:"toolUseId"`
	SpawnDepth   int    `json:"spawnDepth"`
	RequestShape string `json:"requestShape"` // "foreground" | "background" (absent before 2.1.29x)
	Model        string `json:"model"`
	Effort       string `json:"effort"`
}

func readAgentMeta(path string) (agentMeta, bool) {
	var m agentMeta
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &m) != nil {
		return agentMeta{}, false
	}
	return m, true
}

// orStr keeps cur unless it is empty.
func orStr(cur, next string) string { return cmp.Or(cur, next) }

// lineTime returns a record's timestamp, or zero.
func lineTime(line []byte) time.Time {
	var rec struct {
		Timestamp string `json:"timestamp"`
	}
	if !bytes.Contains(line, []byte(`"timestamp"`)) || !unmarshalLoose(line, &rec) {
		return time.Time{}
	}
	ts, _ := time.Parse(time.RFC3339Nano, rec.Timestamp)
	return ts
}

// ---- following files ----

// fileTail reads the complete new lines of one file, opening it lazily (an agent's
// meta file precedes its transcript by a few hundred ms).
type fileTail struct {
	path string
	f    *os.File
	off  int64
	lineSplitter
}

func (t *fileTail) read() ([][]byte, error) {
	if t.f == nil {
		f, err := os.Open(t.path)
		if err != nil {
			return nil, err
		}
		t.f = f
	}
	lines, err := readAppended(t.f, &t.off, &t.lineSplitter, nil)
	if err != nil {
		t.closeFile()
	}
	return lines, err
}

func (t *fileTail) closeFile() {
	if t.f != nil {
		_ = t.f.Close()
		t.f = nil
	}
}

// ---- the thread's folds ----

// fileUsage is one transcript file's own records.
type fileUsage struct {
	cid       string
	subagents string // <project dir>/<cid>/subagents
	fold      usageFold
}

// runUsage is one subagent run.
type runUsage struct {
	info       AgentRun // Usage is filled in by snapshot
	dir        string   // the subagents/ directory holding it
	fold       usageFold
	tail       fileTail
	metaRead   bool
	lastGrowth time.Time
	// stateAt is the time of the record that last opened or closed the run. An older
	// record changes nothing: a rescan reads the thread's file before its runs' files,
	// so a nested run's notification (enqueued in the thread's transcript) can come
	// before its launch (in its parent run's file).
	stateAt time.Time
}

// spawnInfo is an Agent tool use whose run is not known yet.
type spawnInfo struct {
	dir, cid string
	depth    int
	ev       runEvent
}

// threadUsage holds every fold of one thread. Owned by the runner goroutine.
type threadUsage struct {
	notBefore time.Time
	now       func() time.Time
	watchDir  func(dir string) // fsnotify a subagents/ directory with an open run; may be nil
	idleClose time.Duration

	files  []*fileUsage
	runs   map[string]*runUsage // by agent id
	byTool map[string]*runUsage // by spawning tool use id
	spawns map[string]spawnInfo // Agent tool uses without a run yet, by tool use id

	changed bool            // something to publish
	dirty   map[string]bool // sources whose buckets changed since the last snapshot
	// err is the first read error of a rescan other than a missing file: some fold is
	// partial and must not be published.
	err error
}

func newThreadUsage(notBefore time.Time, now func() time.Time, idleClose time.Duration) *threadUsage {
	if idleClose <= 0 {
		idleClose = defaultAgentIdleClose
	}
	return &threadUsage{notBefore: notBefore, now: now, idleClose: idleClose,
		runs: map[string]*runUsage{}, byTool: map[string]*runUsage{}, spawns: map[string]spawnInfo{}, dirty: map[string]bool{}}
}

// subagentsDir is where the runs of the transcript at path live.
func subagentsDir(transcriptPath, cid string) string {
	return filepath.Join(filepath.Dir(transcriptPath), cid, "subagents")
}

// file returns the transcript cid's fold, adding it (at path) if new.
func (u *threadUsage) file(cid, path string) *fileUsage {
	for _, f := range u.files {
		if f.cid == cid {
			return f
		}
	}
	f := &fileUsage{cid: cid, subagents: subagentsDir(path, cid), fold: usageFold{notBefore: u.notBefore}}
	u.files = append(u.files, f)
	return f
}

// transcriptLine folds one line of transcript f and applies its run lifecycle events.
func (u *threadUsage) transcriptLine(f *fileUsage, line []byte) {
	n := f.fold.requests
	f.fold.Line(line)
	if f.fold.requests != n {
		u.markDirty(transcriptSource(f.cid))
	}
	for _, ev := range parseRunEvents(line, u.notBefore, u.watched) {
		u.apply(f.subagents, f.cid, 1, ev)
	}
}

func (u *threadUsage) markDirty(source string) {
	u.dirty[source] = true
	u.changed = true
}

// watched reports whether line names a tool use the thread waits on: a spawn without
// its run yet, or an open run's spawn.
func (u *threadUsage) watched(line []byte) bool {
	for id := range u.spawns {
		if bytes.Contains(line, []byte(id)) {
			return true
		}
	}
	for id, r := range u.byTool {
		if r.info.Open && bytes.Contains(line, []byte(id)) {
			return true
		}
	}
	return false
}

// apply handles one lifecycle event read from a file in subagents dir dir of
// transcript cid; depth is the spawn depth of a run spawned by that file.
func (u *threadUsage) apply(dir, cid string, depth int, ev runEvent) {
	switch ev.kind {
	case runSpawned:
		if _, ok := u.byTool[ev.toolUseID]; !ok {
			u.spawns[ev.toolUseID] = spawnInfo{dir: dir, cid: cid, depth: depth, ev: ev}
		}
	case runResult:
		sp, spawned := u.spawns[ev.toolUseID]
		r := u.byTool[ev.toolUseID]
		known := spawned || r != nil
		if r == nil && ev.agentID != "" {
			r = u.runs[ev.agentID]
			if r == nil {
				tool := ""
				if spawned {
					dir, cid, tool = sp.dir, sp.cid, ev.toolUseID
				}
				// A run met here for the first time is folded at least once below.
				r = u.ensureRun(ev.agentID, dir, cid, tool)
				known = known || r != nil
			}
		}
		delete(u.spawns, ev.toolUseID)
		if r == nil {
			return
		}
		r.info.AgentType = orStr(r.info.AgentType, ev.agentType)
		r.info.Description = orStr(r.info.Description, ev.description)
		switch {
		case ev.status == "async_launched":
			if !r.info.Background {
				r.info.Background = true
				u.changed = true
			}
			u.open(r, ev.at)
		case known || ev.status == "completed":
			// The spawn's own result: completed, or an error or interrupt with no agentId.
			// Any other tool naming the agent (an output read, say) decides nothing.
			u.close(r, ev.at)
		}
	case runNotified:
		r := u.runs[ev.agentID]
		if r == nil {
			r = u.ensureRun(ev.agentID, dir, cid, "")
		}
		if r != nil {
			u.close(r, ev.at)
		}
	case runResumed:
		r := u.runs[ev.agentID]
		if r == nil {
			r = u.ensureRun(ev.agentID, dir, cid, "")
		}
		if r != nil {
			u.open(r, ev.at)
		}
	}
}

// ensureRun returns run agentID, adding it (closed, nothing read yet) if its meta or
// transcript exists in dir. nil when neither does: the id is not an agent's (a
// background shell's task id), or Claude never wrote the run.
func (u *threadUsage) ensureRun(agentID, dir, cid, toolUseID string) *runUsage {
	if r, ok := u.runs[agentID]; ok {
		return r
	}
	if !validAgentID(agentID) {
		return nil
	}
	path := filepath.Join(dir, "agent-"+agentID+".jsonl")
	meta, hasMeta := readAgentMeta(filepath.Join(dir, "agent-"+agentID+".meta.json"))
	if _, err := os.Stat(path); err != nil && !hasMeta {
		return nil
	}
	r := &runUsage{info: AgentRun{ID: agentID, ClaudeSessionID: cid, ToolUseID: toolUseID, SpawnDepth: 1},
		dir: dir, fold: usageFold{notBefore: u.notBefore}, tail: fileTail{path: path}}
	if hasMeta {
		u.mergeMeta(r, meta)
	}
	u.runs[agentID] = r
	u.link(r)
	u.changed = true
	return r
}

// validAgentID keeps ids from naming paths outside the directory.
func validAgentID(id string) bool {
	return id != "" && !strings.ContainsAny(id, `/\`) && id != "." && id != ".."
}

// link indexes r by its spawning tool use and takes over that spawn's input.
func (u *threadUsage) link(r *runUsage) {
	id := r.info.ToolUseID
	if id == "" {
		return
	}
	u.byTool[id] = r
	if sp, ok := u.spawns[id]; ok {
		delete(u.spawns, id)
		ev := sp.ev
		r.info.Description = orStr(r.info.Description, ev.description)
		r.info.AgentType = orStr(r.info.AgentType, ev.agentType)
		r.info.Model = orStr(r.info.Model, ev.model)
		r.info.Effort = orStr(r.info.Effort, ev.effort)
		r.info.Background = r.info.Background || ev.background
		if !r.metaRead && r.info.SpawnDepth < sp.depth {
			r.info.SpawnDepth = sp.depth
		}
	}
}

// mergeMeta takes the meta file's fields over anything the transcripts said (the
// spawn's input, a result), so a run reads the same whichever was met first, live or
// in a rescan; those only fill what the meta lacks.
func (u *threadUsage) mergeMeta(r *runUsage, m agentMeta) {
	r.metaRead = true
	r.info.Description = cmp.Or(m.Description, r.info.Description)
	r.info.AgentType = cmp.Or(m.AgentType, r.info.AgentType)
	r.info.Model = cmp.Or(m.Model, r.info.Model)
	r.info.Effort = cmp.Or(m.Effort, r.info.Effort)
	r.info.Background = r.info.Background || m.RequestShape == "background"
	if m.SpawnDepth > 0 {
		r.info.SpawnDepth = m.SpawnDepth
	}
	if r.info.ToolUseID == "" && m.ToolUseID != "" {
		r.info.ToolUseID = m.ToolUseID
		u.link(r)
	}
}

// stale reports whether a record at at is older than the one that last set r's state.
func (r *runUsage) stale(at time.Time) bool { return !at.IsZero() && at.Before(r.stateAt) }

// open starts (or resumes) following r from where its fold stopped, for a record at
// at (zero: no time, never stale).
func (u *threadUsage) open(r *runUsage, at time.Time) {
	if r.stale(at) {
		return
	}
	if !at.IsZero() {
		r.stateAt = at
	}
	if r.info.Open {
		return
	}
	r.info.Open = true
	r.lastGrowth = u.now()
	u.changed = true
	if u.watchDir != nil {
		u.watchDir(r.dir)
	}
}

// close drains r one last time and stops following it, for a record at at. Its fold
// stays.
func (u *threadUsage) close(r *runUsage, at time.Time) {
	u.drain(r)
	if r.stale(at) {
		return
	}
	if !at.IsZero() {
		r.stateAt = at
	}
	r.tail.closeFile()
	if r.info.Open {
		r.info.Open = false
		u.changed = true
	}
}

// drain folds r's new lines and applies the lifecycle events in them (runs it spawned).
func (u *threadUsage) drain(r *runUsage) {
	if !r.metaRead {
		if m, ok := readAgentMeta(filepath.Join(r.dir, "agent-"+r.info.ID+".meta.json")); ok {
			u.mergeMeta(r, m)
			u.changed = true
		}
	}
	lines, err := r.tail.read()
	if err != nil && !errors.Is(err, fs.ErrNotExist) && u.err == nil {
		u.err = err
	}
	if len(lines) == 0 {
		return
	}
	r.lastGrowth = u.now()
	n := r.fold.requests
	for _, line := range lines {
		if r.info.StartedAt.IsZero() {
			if ts := lineTime(line); !ts.IsZero() {
				r.info.StartedAt = ts.UTC().Truncate(time.Millisecond) // as persisted
				u.changed = true
			}
		}
		r.fold.Line(line)
		for _, ev := range parseRunEvents(line, u.notBefore, u.watched) {
			u.apply(r.dir, r.info.ClaudeSessionID, r.info.SpawnDepth+1, ev)
		}
	}
	if r.fold.requests != n {
		u.markDirty(runSource(r.info.ID))
	}
}

// openRuns lists the open runs, in a fixed order.
func (u *threadUsage) openRuns() []*runUsage {
	var out []*runUsage
	for _, r := range u.runs {
		if r.info.Open {
			out = append(out, r)
		}
	}
	slices.SortFunc(out, func(a, b *runUsage) int { return strings.Compare(a.info.ID, b.info.ID) })
	return out
}

// poll follows the runs: matches pending spawns to meta files, then drains every open
// run (after the thread's own lines, so a closing result has already been applied).
func (u *threadUsage) poll() {
	if len(u.spawns) > 0 {
		u.discover(false)
	}
	for _, r := range u.openRuns() {
		u.drain(r)
	}
}

// discover lists subagents/ directories for runs not known yet. Live (all false) it
// only looks where a spawn waits for its run and opens the runs whose meta names that
// spawn. In a rescan (all true) it lists every transcript's directory and also folds
// every other run file it finds, closed; runs are taken in spawn-depth order so a
// run's own spawns are known before its children are matched to them.
func (u *threadUsage) discover(all bool) {
	dirs := map[string]string{} // dir -> cid
	if all {
		for _, f := range u.files {
			dirs[f.subagents] = f.cid
		}
	} else {
		for _, sp := range u.spawns {
			dirs[sp.dir] = sp.cid
		}
	}
	type candidate struct {
		id, dir, cid string
		meta         agentMeta
		hasMeta      bool
	}
	var cands []candidate
	for dir, cid := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		seen := map[string]bool{}
		for _, e := range entries {
			name := e.Name()
			if !strings.HasPrefix(name, "agent-") {
				continue
			}
			id, ok := strings.CutSuffix(strings.TrimPrefix(name, "agent-"), ".meta.json")
			if !ok {
				if id, ok = strings.CutSuffix(strings.TrimPrefix(name, "agent-"), ".jsonl"); !ok || !all {
					continue
				}
			}
			if seen[id] || u.runs[id] != nil {
				continue
			}
			seen[id] = true
			m, hasMeta := readAgentMeta(filepath.Join(dir, "agent-"+id+".meta.json"))
			if !all {
				if _, waiting := u.spawns[m.ToolUseID]; !hasMeta || m.ToolUseID == "" || !waiting {
					continue
				}
			}
			cands = append(cands, candidate{id: id, dir: dir, cid: cid, meta: m, hasMeta: hasMeta})
		}
	}
	depth := func(c candidate) int { return max(c.meta.SpawnDepth, 1) }
	slices.SortFunc(cands, func(a, b candidate) int {
		return cmp.Or(cmp.Compare(depth(a), depth(b)), strings.Compare(a.id, b.id))
	})
	for _, c := range cands {
		_, waiting := u.spawns[c.meta.ToolUseID]
		waiting = waiting && c.meta.ToolUseID != ""
		r := u.ensureRun(c.id, c.dir, c.cid, "")
		if r == nil {
			continue
		}
		if waiting {
			u.open(r, time.Time{})
			u.drain(r)
		} else {
			u.close(r, time.Time{})
		}
	}
}

// settle completes a rescan: drains the open runs, folds every run file not met yet,
// and drains again (runs opened by the second step).
func (u *threadUsage) settle() {
	for _, r := range u.openRuns() {
		u.drain(r)
	}
	u.discover(true)
	for _, r := range u.openRuns() {
		u.drain(r)
	}
}

// adopt keeps a run that is no longer on disk with its last saved counters.
func (u *threadUsage) adopt(saved AgentRun) {
	if u.runs[saved.ID] != nil {
		return
	}
	r := &runUsage{info: saved, fold: seededFold(saved.Usage)}
	r.info.Open, r.info.Usage = false, nil
	u.runs[saved.ID] = r
	if r.info.ToolUseID != "" {
		u.byTool[r.info.ToolUseID] = r
	}
	u.markDirty(runSource(saved.ID))
}

// closeIdle is the safety net: closes runs that have not grown for idleClose (times
// backgroundIdleFactor for a background run) while the thread is at its prompt.
func (u *threadUsage) closeIdle(atPrompt bool) {
	if !atPrompt {
		return
	}
	now := u.now()
	for _, r := range u.openRuns() {
		limit := u.idleClose
		if r.info.Background {
			limit *= backgroundIdleFactor
		}
		if now.Sub(r.lastGrowth) >= limit {
			u.close(r, time.Time{})
		}
	}
}

// closeAll drops every file handle (the runner is done).
func (u *threadUsage) closeAll() {
	for _, r := range u.runs {
		r.tail.closeFile()
	}
}

// usageUpdate is what the runner publishes: the thread's total, its runs, and the
// sources whose buckets changed since the last update.
type usageUpdate struct {
	total   []UsageBucket
	runs    []AgentRun
	sources map[string][]UsageBucket
}

// snapshot sums every fold and takes the dirty sources' buckets.
func (u *threadUsage) snapshot() usageUpdate {
	var up usageUpdate
	lists := make([][]UsageBucket, 0, len(u.files)+len(u.runs))
	for _, f := range u.files {
		lists = append(lists, f.fold.Buckets())
		if u.dirty[transcriptSource(f.cid)] {
			up.addSource(transcriptSource(f.cid), lists[len(lists)-1])
		}
	}
	for _, r := range u.runs {
		run := r.info
		run.Usage = r.fold.Buckets()
		lists = append(lists, run.Usage)
		up.runs = append(up.runs, run)
		if u.dirty[runSource(run.ID)] {
			up.addSource(runSource(run.ID), run.Usage)
		}
	}
	sortRuns(up.runs)
	up.total = SumUsage(lists...)
	clear(u.dirty)
	u.changed = false
	return up
}

func (up *usageUpdate) addSource(id string, b []UsageBucket) {
	if up.sources == nil {
		up.sources = map[string][]UsageBucket{}
	}
	up.sources[id] = b
}

// sortRuns orders runs by start time (unknown last), then id.
func sortRuns(runs []AgentRun) {
	slices.SortFunc(runs, func(a, b AgentRun) int {
		if a.StartedAt.IsZero() != b.StartedAt.IsZero() {
			if a.StartedAt.IsZero() {
				return 1
			}
			return -1
		}
		return cmp.Or(a.StartedAt.Compare(b.StartedAt), strings.Compare(a.ID, b.ID))
	})
}

// seededFold is a fold holding saved buckets (a source whose file is gone).
func seededFold(bs []UsageBucket) usageFold {
	f := usageFold{}
	for _, b := range bs {
		if f.buckets == nil {
			f.buckets = map[usageKey]*UsageBucket{}
		}
		c := b
		f.buckets[b.key()] = &c
		f.requests += b.Requests
	}
	return f
}
