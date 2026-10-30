package dictation

import "net/url"

// Model is a Whisper model the engine can load: the registry is data, so a second model
// is one more entry. Exactly one today, and no picker anywhere.
type Model struct {
	// Name is its file name in the models directory.
	Name string
	// Title is how the settings page names it.
	Title string
	// Sources are tried in order until one serves the whole file: a source that fails
	// hands over to the next, which resumes the partial file (every source serves the
	// same bytes).
	Sources []Source
	// Size and SHA256 pin the file: a download is verified against both, and a file of
	// another size on disk is not the model.
	Size   int64
	SHA256 string
}

// Source is one place a model is downloaded from: a GitHub release asset, fetched
// through the user's gh, or a plain HTTPS URL. Exactly one of GitHub and URL is set.
type Source struct {
	GitHub *ReleaseAsset
	URL    string
}

// ReleaseAsset is a file attached to a GitHub release.
type ReleaseAsset struct {
	// Repo is "owner/name".
	Repo  string
	Tag   string
	Asset string
}

// Label names the source in errors and logs: "GitHub" or the URL's host.
func (s Source) Label() string {
	if s.GitHub != nil {
		return "GitHub"
	}
	if u, err := url.Parse(s.URL); err == nil && u.Host != "" {
		return u.Host
	}
	return s.URL
}

// Models is the registry, the default first.
var Models = []Model{
	{
		Name:  "ggml-large-v3-turbo-q8_0.bin",
		Title: "Whisper Large v3 Turbo",
		Sources: []Source{
			// A copy on the app's release repository, first: gh reaches GitHub through
			// the user's login and proxy where huggingface.co is blocked
			// (docs/notes/dictation-6-model-mirror.md). Pinned rather than
			// version.Repo(), so dev builds and a release-repo override find it too.
			{GitHub: &ReleaseAsset{Repo: "alexwaumann/code-foundry", Tag: "models-whisper-large-v3-turbo-q8_0", Asset: "ggml-large-v3-turbo-q8_0.bin"}},
			{URL: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin"},
		},
		// The Git LFS oid of the file at that URL, checked against a download on
		// 2026-10-29 (docs/notes/dictation-2-daemon.md); the release asset's digest is
		// the same.
		Size:   874188075,
		SHA256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
	},
}

// DefaultModel is the model the store downloads and loads.
func DefaultModel() Model { return Models[0] }
