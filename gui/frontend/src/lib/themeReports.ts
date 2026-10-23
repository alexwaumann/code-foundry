/**
 * Keeps the daemon's copy of the contrast report on each user theme current
 * (UiService.PublishThemeReport; docs/notes/theme-followups.md). The daemon derives no
 * colour, so `theme save` waits for this report on the file it wrote and prints it, and
 * `theme check` prints the latest. Each user theme the daemon's list carries (with its
 * file version) is resolved and measured once per version; new reports go out after a
 * short debounce (a burst of saves sends once), and every report goes again on each
 * (re)connect, so a restarted daemon has them. The stale pins need what each pin was made
 * against: that basis is carried from version to version (carryPinBasis) and kept in
 * localStorage, so it survives a relaunch and every window computes the same.
 */
import { isOutdatedDaemon } from "@/api/errors";
import { isUnreachable } from "@/api/stream";
import { publishThemeReports, type ThemeReportView } from "@/api/ui";
import { subscribeUserThemes, userThemes, type Theme } from "@/themes";
import { carryPinBasis, reportOn, type PinBasis } from "@/themes/report";
import { onDaemonConnect } from "./theme";

/** localStorage key of the pin bases, by theme id. */
export const PIN_BASIS_STORAGE_KEY = "cf.themes.pinBasis";

function loadBasis(): Map<string, PinBasis> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PIN_BASIS_STORAGE_KEY) ?? "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) return new Map();
    return new Map(Object.entries(v as Record<string, unknown>).filter((e): e is [string, PinBasis] => typeof e[1] === "object" && e[1] !== null));
  } catch {
    return new Map();
  }
}

function saveBasis(basis: ReadonlyMap<string, PinBasis>): void {
  try {
    localStorage.setItem(PIN_BASIS_STORAGE_KEY, JSON.stringify(Object.fromEntries(basis)));
  } catch {
    // No storage: the next launch measures every pin afresh (none stale).
  }
}

/** The report on one version of a user theme, moving its pin basis on. */
function reportFor(t: Theme, version: string, basis: Map<string, PinBasis>): ThemeReportView {
  const b = carryPinBasis(t, basis.get(t.id));
  basis.set(t.id, b);
  return { id: t.id, version, ...reportOn(t, b, t.slots) };
}

export function startThemeReports(
  publish: (r: readonly ThemeReportView[]) => Promise<void> = publishThemeReports,
  onConnect: (cb: () => void) => () => void = onDaemonConnect,
  debounceMs = 150,
): () => void {
  const reports = new Map<string, ThemeReportView>();
  const basis = loadBasis();
  const pending = new Set<string>();
  let all = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = () => {
    timer = undefined;
    const ids = all ? [...reports.keys()] : [...pending];
    all = false;
    pending.clear();
    const batch = ids.flatMap((id) => reports.get(id) ?? []);
    if (batch.length === 0) return;
    publish(batch).catch((err: unknown) => {
      // The next connect sends every report again.
      if (!isUnreachable(err) && !isOutdatedDaemon(err)) console.warn("theme report publish", err);
    });
  };
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(send, debounceMs);
  };

  const scan = () => {
    const known = new Set<string>();
    let changed = false;
    for (const t of userThemes()) {
      known.add(t.id);
      // Before the daemon's list arrives the themes are the last launch's, without versions.
      if (!t.version || reports.get(t.id)?.version === t.version) continue;
      try {
        reports.set(t.id, reportFor(t, t.version, basis));
      } catch (err) {
        console.warn("theme report", t.id, err);
        continue;
      }
      pending.add(t.id);
      changed = true;
    }
    for (const id of [...reports.keys()]) if (!known.has(id)) reports.delete(id);
    for (const id of [...basis.keys()]) {
      if (!known.has(id)) {
        basis.delete(id);
        changed = true;
      }
    }
    if (changed) saveBasis(basis);
    if (pending.size > 0) schedule();
  };

  scan();
  const stopThemes = subscribeUserThemes(scan);
  const stopConnect = onConnect(() => {
    all = true;
    schedule();
  });
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    stopThemes();
    stopConnect();
  };
}
