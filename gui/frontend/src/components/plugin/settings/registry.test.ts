import { describe, expect, it } from "vitest";
import { emptyBrowse, entryPill, progressWords, registryErrorWords, registryLine, shortSource, sizeWords } from "./registry";

describe("registry words", () => {
  it("says each install step", () => {
    const p = { ref: "x", name: "x", version: "1", message: "boom", bytes: 0 };
    expect(progressWords({ ...p, phase: "downloading", bytes: 3 * 1024 * 1024 })).toBe("Downloading… 3.0 MB");
    expect(progressWords({ ...p, phase: "downloading" })).toBe("Downloading…");
    expect(progressWords({ ...p, phase: "verifying" })).toBe("Checking the SHA-256…");
    expect(progressWords({ ...p, phase: "failed" })).toBe("boom");
    expect(sizeWords(10)).toBe("1 KB");
  });

  it("pills an entry by what is installed", () => {
    const e = { installedVersion: null, updateAvailable: false, installedDev: false, available: true };
    expect(entryPill(e)).toBeUndefined();
    expect(entryPill({ ...e, available: false })?.label).toBe("No build for this Mac");
    expect(entryPill({ ...e, installedVersion: "0.1.0" })).toEqual({ label: "Installed", tone: "ok" });
    expect(entryPill({ ...e, installedVersion: "0.0.9", updateAvailable: true })).toEqual({ label: "Update from 0.0.9", tone: "attention" });
    expect(entryPill({ ...e, installedVersion: "0.0.9", installedDev: true })?.label).toBe("Dev 0.0.9");
  });

  it("describes registries and their failures", () => {
    expect(shortSource("https://github.com/o/reg")).toBe("o/reg");
    expect(shortSource("http://127.0.0.1:8765/index.json")).toBe("127.0.0.1:8765/index.json");
    const r = { url: "u", fetchedAtMs: 0, cached: true, error: "", plugins: 1, issues: [] };
    expect(registryLine(r, 5 * 60_000)).toBe("1 plugin · read 5 min ago");
    expect(registryLine({ ...r, plugins: 0, fetchedAtMs: null })).toBe("0 plugins");
    expect(registryErrorWords("not found: no index.json in o/r (or no access with your gh login)")).toBe("Not found, or your gh login cannot read it.");
    expect(registryErrorWords("gh: executable not found on $PATH")).toContain("gh is not installed");
    expect(registryErrorWords("dial tcp: lookup x: no such host")).toBe("Could not reach it (offline?).");
    expect(registryErrorWords("weird")).toBe("weird");
  });
});

describe("emptyBrowse", () => {
  const reg = { url: "https://github.com/o/r" };
  it.each([
    ["not read yet", null, "", null],
    ["Browse failed", { entries: [], registries: [] }, "unavailable", null],
    ["entries listed", { entries: [{}], registries: [reg] }, "", null],
    ["no registry configured", { entries: [], registries: [] }, "", "no-registry"],
    ["a registry answered with none", { entries: [], registries: [reg] }, "", "none-listed"],
  ])("%s", (_name, b, error, want) => {
    expect(emptyBrowse(b, error)).toBe(want);
  });
});
