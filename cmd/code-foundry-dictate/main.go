// Command code-foundry-dictate is the dictation engine: whisper.cpp with Silero VAD,
// driven by the daemon over newline-delimited JSON on stdin/stdout (internal/dictate has
// the protocol). Logs go to stderr; stdout carries only the protocol.
//
//	code-foundry-dictate                      serve the protocol on stdio
//	code-foundry-dictate --version            print the version
//	code-foundry-dictate --transcribe x.wav --model ggml-….bin
//	                                          transcribe a 16 kHz mono 16-bit WAV, one
//	                                          JSON phrase per line, then exit
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/dictate"
	"github.com/alexwaumann/code-foundry/internal/dictate/whisper"
	"github.com/alexwaumann/code-foundry/internal/version"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("code-foundry-dictate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	showVersion := fs.Bool("version", false, "print the version and exit")
	wav := fs.String("transcribe", "", "transcribe a 16 kHz mono 16-bit PCM WAV file and exit")
	model := fs.String("model", "", "the whisper model for --transcribe")
	verbose := fs.Bool("v", false, "debug logs on stderr")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		_, _ = fmt.Fprintf(stdout, "code-foundry-dictate %s\n", version.Version)
		return 0
	}
	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: level}))

	if *wav != "" {
		if *model == "" {
			_, _ = fmt.Fprintln(stderr, "code-foundry-dictate: --transcribe needs --model")
			return 2
		}
		if err := transcribe(*wav, *model, stdout, log); err != nil {
			log.Error("dictate: transcribe", "err", err)
			return 1
		}
		return 0
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	engine := whisper.Start(log)
	defer engine.Close()
	pressure, err := engine.WatchMemoryPressure()
	if err != nil {
		log.Warn("dictate: memory pressure is not watched", "err", err)
	}
	log.Info("dictate: serving", "version", version.Version, "whisper", engine.Version())
	if err := dictate.NewServer(engine, stdout, log).Serve(ctx, stdin, pressure); err != nil && ctx.Err() == nil {
		log.Error("dictate: serve", "err", err)
		return 1
	}
	return 0
}

// phraseLine is one --transcribe output line.
type phraseLine struct {
	Text    string `json:"text"`
	StartMS int64  `json:"start_ms"`
	EndMS   int64  `json:"end_ms"`
	InferMS int64  `json:"infer_ms"`
}

func transcribe(wavPath, model string, stdout io.Writer, log *slog.Logger) error {
	b, err := os.ReadFile(wavPath)
	if err != nil {
		return err
	}
	samples, err := dictate.ReadWAV(b)
	if err != nil {
		return err
	}
	engine := whisper.Start(log)
	defer engine.Close()
	srv := dictate.NewServer(engine, io.Discard, log)
	start := time.Now()
	if err := engine.Load(model); err != nil {
		return err
	}
	log.Info("dictate: loaded", "load_ms", time.Since(start).Milliseconds(), "rss_bytes", engine.RSS(), "whisper", engine.Version())
	start = time.Now()
	enc := json.NewEncoder(stdout)
	var phrases int
	err = srv.TranscribeSamples(samples, func(p dictate.PhraseEvent) {
		phrases++
		_ = enc.Encode(phraseLine{Text: p.Text, StartMS: p.StartMS, EndMS: p.EndMS, InferMS: p.InferMS})
	})
	log.Info("dictate: transcribed", "audio_ms", int64(len(samples))*1000/dictate.SampleRate, "wall_ms", time.Since(start).Milliseconds(), "phrases", phrases)
	return err
}
