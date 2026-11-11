import type { IndexEntryView, InstallProgressView, RegistryView, Tone } from "@/api/plugin";
import { readWords } from "@/components/settings/catalog/model";

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

/**
 * What an entry's pill says, from the daemon's relation: not installed (none), installed,
 * an update from its own source, a dev link, or where it was installed from when that is
 * another source (no update from here, however new).
 */
export function entryPill(e: Pick<IndexEntryView, "installedVersion" | "relation" | "installedFrom" | "available">): { label: string; tone: Tone } | undefined {
  switch (e.relation) {
    case "not-installed":
      return e.available ? undefined : { label: "No build for this Mac", tone: "muted" };
    case "dev":
      return { label: `Dev ${e.installedVersion ?? ""}`, tone: "muted" };
    case "update":
      return { label: `Update from ${e.installedVersion ?? ""}`, tone: "attention" };
    case "other-source":
      return { label: `Installed from ${e.installedFrom}`, tone: "muted" };
    case "installed":
      return { label: "Installed", tone: "ok" };
  }
}

/** The row's one action: Install when nothing of the name is installed, Update when its own source lists a newer version, else none. */
export function entryAction(e: Pick<IndexEntryView, "relation">): "install" | "update" | null {
  if (e.relation === "not-installed") return "install";
  if (e.relation === "update") return "update";
  return null;
}

/** "3 plugins · read 5m ago" ("3 plugins" before a first read); a failure shows on its own. */
export function registryLine(r: Pick<RegistryView, "plugins" | "fetchedAtMs">, now: number): string {
  const count = `${String(r.plugins)} ${r.plugins === 1 ? "plugin" : "plugins"}`;
  return [count, ...(r.fetchedAtMs !== null ? [readWords(r.fetchedAtMs, now)] : [])].join(" · ");
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

/** The setting Browse reads its registries from. */
export const REGISTRIES_SETTING = "plugins.registries";

/** What Browse lists nothing for: no registry configured, or the registries listed none. Null while it lists something. */
export function emptyBrowse(b: { entries: readonly unknown[]; registries: readonly unknown[] } | null, error: string): "no-registry" | "none-listed" | null {
  if (!b || error || b.entries.length > 0) return null;
  return b.registries.length === 0 ? "no-registry" : "none-listed";
}
