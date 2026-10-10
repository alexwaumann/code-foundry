import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, FolderPlus, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { appendProgress, cloneRepo, lookupGitHub, searchGitHub, type CloneProgressView, type GitHubRepoView } from "@/api/addProject";
import { errorMessage, isAbort } from "@/api/stream";
import { Button } from "@/components/ui/button";
import { parseGitHubInput } from "@/lib/githubRef";
import { tildify } from "@/lib/path";
import { closeAddProject, registerFolder, selectAddedProject } from "@/stores/addProject";

/** What the tab shows under the input. */
type View =
  | { kind: "idle" }
  | { kind: "loading"; what: string }
  | { kind: "results"; query: string; repos: GitHubRepoView[] }
  | { kind: "repo"; repo: GitHubRepoView; fromResults: View | null }
  | { kind: "message"; text: string };

type Clone = { state: "idle" } | { state: "running"; lines: CloneProgressView[] } | { state: "failed"; lines: CloneProgressView[]; error: string };

function Badge({ children, tone = "muted" }: { children: string; tone?: "muted" | "amber" }) {
  const cls = tone === "amber" ? "border-amber-500/40 text-amber-300" : "border-border text-muted-foreground";
  return <span className={`shrink-0 rounded border px-1.5 py-px text-[10px] font-medium tracking-wide uppercase ${cls}`}>{children}</span>;
}

function RepoBadges({ repo }: { repo: GitHubRepoView }) {
  return (
    <>
      {repo.visibility && repo.visibility !== "public" && <Badge>{repo.visibility}</Badge>}
      {repo.fork && <Badge>fork</Badge>}
      {repo.archived && <Badge tone="amber">archived</Badge>}
    </>
  );
}

function ResultRow({ repo, onPick }: { repo: GitHubRepoView; onPick: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      onClick={onPick}
      data-testid="add-project-github-result"
      data-slug={repo.slug}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-sm">{repo.slug}</span>
        <RepoBadges repo={repo} />
        {repo.clonePathExists && <span className="ml-auto shrink-0 text-xs text-muted-foreground">already cloned</span>}
      </span>
      {repo.description && <span className="line-clamp-1 text-xs text-muted-foreground">{repo.description}</span>}
    </button>
  );
}

function ProgressLog({ lines }: { lines: readonly CloneProgressView[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div ref={ref} className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed" data-testid="add-project-clone-progress">
      {lines.length === 0 ? (
        <div className="text-muted-foreground">Starting gh repo clone…</div>
      ) : (
        lines.map((l, i) => (
          <div key={i} className="break-all whitespace-pre-wrap" data-testid="add-project-clone-line" data-transient={l.transient ? "true" : undefined}>
            {l.line}
          </div>
        ))
      )}
    </div>
  );
}

/** A repository picked from the results or looked up: where it goes, and Clone. */
function RepoCard({ repo, onBack }: { repo: GitHubRepoView; onBack: (() => void) | null }) {
  const [clone, setClone] = useState<Clone>({ state: "idle" });
  const [adding, setAdding] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  // Closing the dialog (or going back) cancels a clone in flight; the daemon removes it.
  useEffect(
    () => () => {
      ctl.current?.abort();
    },
    [],
  );
  const running = clone.state === "running";

  const start = async () => {
    ctl.current?.abort();
    const ac = new AbortController();
    ctl.current = ac;
    let lines: CloneProgressView[] = [];
    setClone({ state: "running", lines });
    try {
      const added = await cloneRepo(
        repo.owner,
        repo.name,
        (p) => {
          lines = appendProgress(lines, p);
          setClone({ state: "running", lines });
        },
        undefined,
        ac.signal,
      );
      toast.success(`Cloned ${repo.slug}`);
      closeAddProject();
      selectAddedProject(added.id);
    } catch (err) {
      if (isAbort(err) || ac.signal.aborted) return;
      setClone({ state: "failed", lines, error: errorMessage(err) });
    }
  };

  // The destination exists (cloned before, by hand or by the app): add that folder.
  const addExisting = async () => {
    setAdding(true);
    try {
      const added = await registerFolder(repo.clonePath);
      toast.success(`Added ${added.name}`);
      closeAddProject();
      selectAddedProject(added.id);
    } catch (err) {
      setClone({ state: "failed", lines: [], error: errorMessage(err) });
      setAdding(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="add-project-github-selected" data-slug={repo.slug}>
      {onBack && (
        <button
          type="button"
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          onClick={onBack}
          disabled={running}
          data-testid="add-project-github-back"
        >
          <ArrowLeft className="size-3" aria-hidden /> Results
        </button>
      )}
      <div className="flex flex-col gap-1 rounded-md border px-3 py-2.5" data-testid="add-project-github-card">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm font-medium">{repo.slug}</span>
          <RepoBadges repo={repo} />
        </span>
        {repo.description && <span className="text-xs text-muted-foreground">{repo.description}</span>}
        <span className="mt-1 text-xs text-muted-foreground">
          Clones into <span className="font-mono text-foreground" data-testid="add-project-clone-dest">{tildify(repo.clonePath)}</span>
        </span>
        {repo.clonePathExists && (
          <span className="text-xs text-amber-300" data-testid="add-project-clone-exists">
            That folder already exists, so it cannot be cloned there. Add the existing folder instead.
          </span>
        )}
      </div>
      {clone.state !== "idle" && <ProgressLog lines={clone.lines} />}
      {clone.state === "failed" && (
        <p className="text-xs whitespace-pre-wrap text-destructive" role="alert" data-testid="add-project-clone-error">
          {clone.error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {running && <span className="mr-auto text-xs text-muted-foreground">Closing the dialog cancels the clone.</span>}
        {repo.clonePathExists ? (
          <Button type="button" size="sm" disabled={adding} onClick={() => void addExisting()} data-testid="add-project-add-existing">
            {adding ? <Loader2 className="animate-spin" aria-hidden /> : <FolderPlus aria-hidden />}
            Add existing folder
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={running} onClick={() => void start()} data-testid="add-project-clone">
            {running ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
            {running ? "Cloning…" : clone.state === "failed" ? "Retry clone" : "Clone"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * GitHub: one input for an https://github.com URL, owner/repo, or search text. Enter
 * looks up an exact repository (its card) or searches (up to 20 results); nothing is
 * sent while typing. Picking a result shows its card; Clone streams gh's progress and,
 * on success, closes the dialog on the new project.
 */
export function GitHubTab({ active }: { active: boolean }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // The tab stays mounted while hidden (a clone keeps running): focus it when shown.
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);
  const [view, setView] = useState<View>({ kind: "idle" });
  const [inputError, setInputError] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      ctl.current?.abort();
    },
    [],
  );

  const go = async () => {
    const parsed = parseGitHubInput(text);
    if (parsed.kind === "empty") return;
    if (parsed.kind === "error") {
      setInputError(parsed.message);
      return;
    }
    setInputError(null);
    ctl.current?.abort();
    const ac = new AbortController();
    ctl.current = ac;
    try {
      if (parsed.kind === "repo") {
        const slug = `${parsed.owner}/${parsed.name}`;
        setView({ kind: "loading", what: `Looking up ${slug}…` });
        const repo = await lookupGitHub(parsed.owner, parsed.name, undefined, ac.signal);
        if (ac.signal.aborted) return;
        setView(repo ? { kind: "repo", repo, fromResults: null } : { kind: "message", text: `No repository ${slug} on GitHub, or you cannot see it.` });
      } else {
        setView({ kind: "loading", what: `Searching GitHub for “${parsed.query}”…` });
        const repos = await searchGitHub(parsed.query, undefined, ac.signal);
        if (ac.signal.aborted) return;
        setView({ kind: "results", query: parsed.query, repos });
      }
    } catch (err) {
      if (isAbort(err) || ac.signal.aborted) return;
      setView({ kind: "message", text: errorMessage(err) });
    }
  };

  const busy = view.kind === "loading";
  return (
    <div className="flex flex-col gap-3" data-testid="add-project-github">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border px-3 focus-within:ring-[3px] focus-within:ring-ring/50">
          <Search className="size-4 shrink-0 opacity-50" aria-hidden />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setInputError(null);
            }}
            placeholder="owner/repo, https://github.com/owner/repo, or search"
            aria-label="GitHub repository or search"
            className="h-full w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            spellCheck={false}
            autoComplete="off"
            data-testid="add-project-github-input"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={busy || text.trim() === ""} data-testid="add-project-github-go">
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {parseGitHubInput(text).kind === "repo" ? "Look up" : "Search"}
        </Button>
      </form>
      {inputError && (
        <p className="text-xs text-destructive" role="alert" data-testid="add-project-github-error">
          {inputError}
        </p>
      )}
      {view.kind === "idle" && !inputError && (
        <p className="text-xs text-muted-foreground">Press Enter to look up a repository or search GitHub. Clones go to ~/.code-foundry/projects/&lt;owner&gt;/&lt;repo&gt; with gh.</p>
      )}
      {view.kind === "loading" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="add-project-github-loading">
          <Loader2 className="size-3 animate-spin" aria-hidden /> {view.what}
        </p>
      )}
      {view.kind === "message" && (
        <p className="text-xs text-muted-foreground" data-testid="add-project-github-message">
          {view.text}
        </p>
      )}
      {view.kind === "results" &&
        (view.repos.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="add-project-github-message">
            No repositories match “{view.query}”.
          </p>
        ) : (
          <div className="-mx-1 flex max-h-72 flex-col overflow-y-auto" role="list" data-testid="add-project-github-results">
            {view.repos.map((r) => (
              <ResultRow
                key={r.slug}
                repo={r}
                onPick={() => {
                  setView({ kind: "repo", repo: r, fromResults: view });
                }}
              />
            ))}
          </div>
        ))}
      {view.kind === "repo" && (
        <RepoCard
          key={view.repo.slug}
          repo={view.repo}
          onBack={
            view.fromResults
              ? () => {
                  if (view.fromResults) setView(view.fromResults);
                }
              : null
          }
        />
      )}
    </div>
  );
}
