import type { IndexEntryView, InstallProgressView, RegistryView, Tone } from "@/api/plugin";

/** An install step in words: "Downloading… 1.2 MB", "Checking the SHA-256…", or the failure. */
export function progressWords(p: InstallProgressView): string {
  switch (p.phase) {
    case "resolving":
      return "Finding it in the registries…";
    case "downloading":
      return p.bytes > 0 ? `Downloading… ${sizeWords(p.bytes)}` : "Downloading…";
    case "verifying":
      return "Checking the SHA-256…";
    case "extracting":
      return "Unpacking…";
    case "installing":
      return "Installing…";
    case "failed":
      return p.message || "The install failed";
    case "done":
      return "Installed";
    case "unknown":
      return p.message;
  }
}

/** Bytes as "512 KB" or "4.1 MB". */
export function sizeWords(n: number): string {
  if (n < 1024 * 1024) return `${String(Math.max(1, Math.round(n / 1024)))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A registry or repository URL without its scheme and github.com host: "alexwaumann/code-foundry-plugins". */
export function shortSource(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
}

/** What an entry's pill says: not installed (none), the installed version, or that an update is there. */
export function entryPill(e: Pick<IndexEntryView, "installedVersion" | "updateAvailable" | "installedDev" | "available">): { label: string; tone: Tone } | undefined {
  if (e.installedVersion === null) return e.available ? undefined : { label: "No build for this Mac", tone: "muted" };
  if (e.installedDev) return { label: `Dev ${e.installedVersion}`, tone: "muted" };
  if (e.updateAvailable) return { label: `Update from ${e.installedVersion}`, tone: "attention" };
  return { label: "Installed", tone: "ok" };
}

/** "3 plugins · fetched 10:42 (cached)" for a registry that answered; its failure shows on its own. */
export function registryLine(r: RegistryView, now: number = Date.now()): string {
  const parts = [`${String(r.plugins)} ${r.plugins === 1 ? "plugin" : "plugins"}`];
  if (r.fetchedAtMs !== null) {
    const mins = Math.round((now - r.fetchedAtMs) / 60_000);
    parts.push(mins < 1 ? "read just now" : mins < 60 ? `read ${String(mins)} min ago` : `read ${String(Math.round(mins / 60))} h ago`);
  }
  return parts.join(" · ");
}

/** A registry error in words a user can act on (gh's 404 and auth failures, being offline). */
export function registryErrorWords(err: string): string {
  const e = err.toLowerCase();
  if (e.includes("no access with your gh login") || e.includes("http 404")) return "Not found, or your gh login cannot read it.";
  if (e.includes("gh auth login") || e.includes("authentication") || e.includes("http 401")) return "gh is not logged in: run gh auth login.";
  if (e.includes("executable not found")) return "gh is not installed (or set Advanced › gh executable).";
  if (e.includes("no such host") || e.includes("connection refused") || e.includes("network is unreachable") || e.includes("timeout") || e.includes("deadline")) return "Could not reach it (offline?).";
  return err;
}
