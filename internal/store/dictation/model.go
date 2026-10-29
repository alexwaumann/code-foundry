package dictation

// Model is a Whisper model the engine can load: the registry is data, so a second model
// is one more entry. Exactly one today, and no picker anywhere.
type Model struct {
	// Name is its file name in the models directory.
	Name string
	// Title is how the settings page names it.
	Title string
	URL   string
	// Size and SHA256 pin the file: a download is verified against both, and a file of
	// another size on disk is not the model.
	Size   int64
	SHA256 string
}

// Models is the registry, the default first.
var Models = []Model{
	{
		Name:  "ggml-large-v3-turbo-q8_0.bin",
		Title: "Whisper Large v3 Turbo",
		URL:   "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
		// The Git LFS oid of the file at that URL, checked against a download on
		// 2026-10-29 (docs/notes/dictation-2-daemon.md).
		Size:   874188075,
		SHA256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
	},
}

// DefaultModel is the model the store downloads and loads.
func DefaultModel() Model { return Models[0] }
