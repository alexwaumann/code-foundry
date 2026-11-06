# Reading the source

{{cf.provenance}}

For how Code Foundry works inside, or behaviour the references do not cover, read its
source; never answer that from memory. The line under this file's title gives the build
and its source, `https://github.com/<owner>/<repo>/tree/<ref>` (a public repository; with
no `/tree/<ref>`, use `main`). Read files at that ref with your own tools:

- WebFetch `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`, or, when
  `gh` is installed, `gh api 'repos/<owner>/<repo>/contents/<path>?ref=<ref>' -H
  'Accept: application/vnd.github.raw'` (for a directory, drop the header: it lists it).
- When the ref 404s, use the `commit` from `code-foundry daemon.version --json` as the
  ref; when that 404s too (a local build), use `main` and say so.
- Start at `docs/ARCHITECTURE.md`, then read the package it names for the topic (for
  example `internal/store/thread/` for threads) and follow the code from there.
- Cite the file paths your answer rests on; notes and comments may be stale, the code is not.
- If the line says `dev build`, say the answer comes from that source, not their build.
