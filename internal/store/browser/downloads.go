package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode"
)

// What a page may put on the user's disk. Chrome saves every download under its guid in
// <dir>/incoming, where it is inert: no name the page chose, nothing Finder shows. It reaches the
// downloads folder, under a cleaned name, only when the user's click asked for it or the user
// says yes. So a page that starts forty downloads with no gesture gets forty questions at most,
// and refusing one deletes it.
//
//   - A click or Enter in the surface lets one download through, within gestureWindow.
//   - With no gesture the surface asks, a few at a time. The file waits in incoming meanwhile,
//     up to maxAskBytes: there is no way to pause it, and no way to fetch it again later.
//   - A page nobody can see downloads nothing.
//   - A surface takes at most maxDownloadsPerPage files and maxDownloadBytesPerPage until the
//     user goes somewhere or reloads. A page cannot reset that by navigating itself.
//
// Page.downloadWillBegin names the session, so a subframe's download is its page's. A frame in
// a cross-site iframe sends only the browser's event, which says nothing a surface can be found
// by: nothing passes on a gesture then, and the surface on screen asks.

// The limits, per surface until the user next navigates or reloads.
const (
	maxDownloadsPerPage     = 20
	maxDownloadBytesPerPage = 4 << 30
	maxAskBytes             = 256 << 20
	maxAsking               = 5
	gestureWindow           = 5 * time.Second
)

// A Download's states.
const (
	DownloadAsking     = "asking"
	DownloadInProgress = "inProgress"
	DownloadCompleted  = "completed"
	DownloadCanceled   = "canceled"
	DownloadBlocked    = "blocked"
)

// download is one of Chrome's downloads, by guid. Its fields need Store.mu.
type download struct {
	sf       *surface // nil: nothing on screen to ask, so it was blocked
	allowed  bool
	blocked  bool
	staged   string // where it finished in incoming, once it did
	received int64
}

// incoming is where Chrome saves, under guids.
func (s *Store) incoming() string { return filepath.Join(s.opts.Dir, "incoming") }

// prepareDownloads readies both folders. What is left in incoming is what nobody allowed.
func (s *Store) prepareDownloads() error {
	if err := os.RemoveAll(s.incoming()); err != nil {
		return fmt.Errorf("browser downloads: %w", err)
	}
	for _, dir := range []string{s.incoming(), s.Downloads()} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("browser downloads: %w", err)
		}
	}
	return nil
}

type downloadParams struct {
	FrameID string `json:"frameId"`
	GUID    string `json:"guid"`
	URL     string `json:"url"`
	Name    string `json:"suggestedFilename"`
}

// onPageDownload is a download of a frame this session can see, its subframes too.
func onPageDownload(s *Store, in *instance, t *target, params json.RawMessage) {
	var p downloadParams
	if json.Unmarshal(params, &p) == nil {
		s.beginDownload(in, t, p)
	}
}

// onBrowserDownload is every download. It comes after the page's, so one still unknown here has
// no session: a frame in a cross-site iframe, or a popup not attached yet. Should Chrome ever
// send these the other way round, every download only asks.
func onBrowserDownload(s *Store, in *instance, params json.RawMessage) {
	var p downloadParams
	if json.Unmarshal(params, &p) != nil || in.downloads[p.GUID] != nil {
		return
	}
	s.beginDownload(in, in.targets[p.FrameID], p)
}

// beginDownload decides what becomes of a download Chrome has started. t is nil when nothing says
// whose it is. Needs Store.mu.
func (s *Store) beginDownload(in *instance, t *target, p downloadParams) {
	if p.GUID == "" || in.downloads[p.GUID] != nil {
		return
	}
	d := &download{}
	in.downloads[p.GUID] = d
	site := siteOf(p.URL)
	if t != nil {
		d.sf = t.surface
		site = siteOf(t.url)
	} else {
		d.sf = s.surfaceOnScreen()
	}
	if d.sf == nil {
		s.log.Debug("a download with no surface to ask was blocked")
		s.cancelDownload(in, p.GUID, d)
		return
	}
	sf := d.sf
	state := sf.verdict(t, time.Now())
	switch state {
	case DownloadBlocked:
		s.cancelDownload(in, p.GUID, d)
	case DownloadInProgress:
		d.allowed = true
		sf.budget.files++
	case DownloadAsking:
		sf.budget.files++
	}
	sf.addDownload(Download{ID: p.GUID, Name: safeName(p.Name), Site: clip(site, maxLabel), State: state})
	sf.publish()
}

// verdict is the rule at the top of this file. Needs Store.mu.
func (sf *surface) verdict(t *target, now time.Time) string {
	switch {
	case t != nil && !sf.onScreen(t):
		return DownloadBlocked
	case sf.budget.files >= maxDownloadsPerPage || sf.budget.bytes >= maxDownloadBytesPerPage:
		return DownloadBlocked
	case t != nil && sf.takeGesture(now):
		return DownloadInProgress
	case sf.countDownloads(DownloadAsking) < maxAsking:
		return DownloadAsking
	}
	return DownloadBlocked
}

// onScreen reports t is what a viewer sees: the top of a surface with a viewer, or a popup about
// to go there. Needs Store.mu.
func (sf *surface) onScreen(t *target) bool {
	return len(sf.viewers) > 0 && (sf.top() == t || !slices.Contains(sf.stack, t))
}

// takeGesture uses up the user's last click: one click, one download. Needs Store.mu.
func (sf *surface) takeGesture(now time.Time) bool {
	if sf.gesture.IsZero() || now.Sub(sf.gesture) > gestureWindow {
		return false
	}
	sf.gesture = time.Time{}
	return true
}

// surfaceOnScreen is the surface a download nobody can place asks on: of those with a viewer, the
// one the user touched last. Nil with nothing on screen. Needs Store.mu.
func (s *Store) surfaceOnScreen() *surface {
	var best *surface
	for _, sf := range s.surfaces {
		if len(sf.viewers) > 0 && (best == nil || sf.gesture.After(best.gesture)) {
			best = sf
		}
	}
	return best
}

func (sf *surface) countDownloads(state string) int {
	n := 0
	for _, d := range sf.state.Downloads {
		if d.State == state {
			n++
		}
	}
	return n
}

// addDownload lists a download. The list is bounded, and a full one gives up what is over and
// done with, the oldest first. Blocked ones past it are only counted: a page can make those
// without end, but only maxDownloadsPerPage of the others. Needs Store.mu.
func (sf *surface) addDownload(d Download) {
	if len(sf.state.Downloads) >= maxDownloadList {
		if d.State == DownloadBlocked {
			sf.state.DownloadsBlocked++
			return
		}
		i := slices.IndexFunc(sf.state.Downloads, func(x Download) bool {
			return x.State != DownloadAsking && x.State != DownloadInProgress
		})
		if i >= 0 {
			sf.state.Downloads = slices.Delete(sf.state.Downloads, i, i+1)
		}
	}
	sf.state.Downloads = append(sf.state.Downloads, d)
}

// entry is a listed download by id, nil for none. Needs Store.mu.
func (sf *surface) entry(id string) *Download {
	for i := range sf.state.Downloads {
		if sf.state.Downloads[i].ID == id {
			return &sf.state.Downloads[i]
		}
	}
	return nil
}

// abandonDownloads closes the list of a Chrome that is gone: what it was still fetching went with
// it, and incoming is swept at the next launch. Needs Store.mu.
func (sf *surface) abandonDownloads() {
	for i := range sf.state.Downloads {
		if d := &sf.state.Downloads[i]; d.State == DownloadAsking || d.State == DownloadInProgress {
			d.State = DownloadCanceled
		}
	}
}

// cancelDownload stops a download and deletes what it left. Needs Store.mu.
func (s *Store) cancelDownload(in *instance, guid string, d *download) {
	d.blocked, d.allowed = true, false
	if d.sf != nil {
		if e := d.sf.entry(guid); e != nil {
			e.State = DownloadBlocked
		}
	}
	if d.staged != "" {
		go removeStaged(d.staged)
		delete(in.downloads, guid)
		return
	}
	// Off the reader: this is a call. A download that finishes first is deleted when its last
	// progress event comes, which is why it stays in in.downloads until then.
	go func() {
		if err := in.call(context.Background(), "", "Browser.cancelDownload", map[string]any{"guid": guid}, nil); err != nil {
			s.log.Debug("cancel download", "err", err)
		}
	}()
}

func removeStaged(path string) { _ = os.Remove(path) }

// onDownloadProgress follows a download to its end.
func onDownloadProgress(s *Store, in *instance, params json.RawMessage) {
	var p struct {
		GUID     string  `json:"guid"`
		State    string  `json:"state"`
		FilePath string  `json:"filePath"`
		Received float64 `json:"receivedBytes"`
		Total    float64 `json:"totalBytes"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	d := in.downloads[p.GUID]
	if d == nil {
		return
	}
	switch p.State {
	case DownloadInProgress:
		s.downloadGrew(in, p.GUID, d, int64(p.Received), int64(p.Total))
	case DownloadCompleted:
		// The name is Chrome's guid; the folder is ours, and Chrome may report it resolved.
		d.staged = filepath.Join(s.incoming(), filepath.Base(p.FilePath))
		switch {
		case d.blocked:
			go removeStaged(d.staged)
			delete(in.downloads, p.GUID)
		case d.allowed:
			go s.finishDownload(in, p.GUID, d)
		}
	default:
		delete(in.downloads, p.GUID)
		if d.sf != nil {
			if e := d.sf.entry(p.GUID); e != nil && e.State != DownloadBlocked {
				e.State = DownloadCanceled
				d.sf.publish()
			}
		}
	}
}

// downloadGrew charges the surface for what came in, and stops what is past a limit. Needs
// Store.mu.
func (s *Store) downloadGrew(in *instance, guid string, d *download, received, total int64) {
	if d.sf == nil || d.blocked {
		return
	}
	sf := d.sf
	if grew := received - d.received; grew > 0 {
		d.received = received
		sf.budget.bytes += grew
	}
	size := max(received, total)
	if sf.budget.bytes > maxDownloadBytesPerPage || size > maxDownloadBytesPerPage || (!d.allowed && size > maxAskBytes) {
		s.cancelDownload(in, guid, d)
		sf.publish()
	}
}

// finishDownload moves a finished, allowed download to where the user sees it.
func (s *Store) finishDownload(in *instance, guid string, d *download) {
	s.mu.Lock()
	name := ""
	if d.sf != nil {
		if e := d.sf.entry(guid); e != nil {
			name = e.Name
		}
	}
	staged := d.staged
	s.mu.Unlock()
	s.moving.Lock()
	final, err := moveInto(staged, s.Downloads(), name)
	s.moving.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(in.downloads, guid)
	if d.sf == nil {
		return
	}
	e := d.sf.entry(guid)
	if e == nil {
		return
	}
	if err != nil {
		s.log.Debug("download not moved", "err", err)
		e.State = DownloadCanceled
	} else {
		e.State, e.Path = DownloadCompleted, final
	}
	d.sf.publish()
}

// AnswerDownload is the user's word on a download the surface asked about.
func (s *Store) AnswerDownload(_ context.Context, key, id string, allow bool) error {
	in, sf, _, err := s.shown(key)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d, e := in.downloads[id], sf.entry(id)
	if d == nil || d.sf != sf || e == nil || e.State != DownloadAsking {
		return ErrNotPending
	}
	if !allow {
		s.cancelDownload(in, id, d)
		sf.publish()
		return nil
	}
	d.allowed = true
	e.State = DownloadInProgress
	if d.staged != "" {
		go s.finishDownload(in, id, d)
	}
	sf.publish()
	return nil
}

// safeName is a page's name for a file as the user sees it: one path element, nothing hidden, no
// invisible character turning report<RLO>fdp.exe into report.pdf. Chrome cleans names too; this
// does not depend on it.
func safeName(name string) string {
	name = strings.ToValidUTF8(name, "")
	name = strings.Map(func(r rune) rune {
		switch {
		case unicode.Is(unicode.Cc, r), unicode.Is(unicode.Cf, r):
			return -1
		case r == '/', r == '\\', r == ':':
			return '_'
		}
		return r
	}, name)
	name = strings.TrimLeft(strings.TrimSpace(name), ".")
	if len(name) > maxLabel {
		ext := filepath.Ext(name)
		if len(ext) > maxLabel/2 {
			ext = ""
		}
		name = strings.ToValidUTF8(name[:maxLabel-len(ext)], "") + ext
	}
	if name == "" {
		return "download"
	}
	return name
}

// moveInto moves a file into dir under name, or "name (1).ext" and so on, never over another.
func moveInto(path, dir, name string) (string, error) {
	if name == "" {
		name = "download"
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; i < 1000; i++ {
		final := filepath.Join(dir, name)
		if i > 0 {
			final = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
		}
		if _, err := os.Lstat(final); err == nil {
			continue
		}
		if err := os.Rename(path, final); err != nil {
			return "", fmt.Errorf("move download: %w", err)
		}
		return final, nil
	}
	return "", fmt.Errorf("move download: too many files named %s", name)
}
