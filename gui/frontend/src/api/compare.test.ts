import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { CompareCommitSchema, CompareFileSchema, CompareWorktreeResponseSchema, DiffSourceKind, FileVersionSchema, GetWorktreeCompareFileResponseSchema, ListCompareCommitsResponseSchema, ResolvedDiffSourceSchema } from "@/gen/codefoundry/v1/project_pb";
import { toCompareLog, toCompareView, toSidesView } from "./compare";

const enc = new TextEncoder();

describe("toCompareLog", () => {
  it("maps each commit, a root's empty parent and a missing date included", () => {
    const v = toCompareLog(
      create(ListCompareCommitsResponseSchema, {
        commits: [
          create(CompareCommitSchema, { sha: "s", shortSha: "sh", parent: "p", subject: "sub", authoredAt: timestampFromMs(5000) }),
          create(CompareCommitSchema, { sha: "r", shortSha: "r", subject: "root", shallow: true }),
        ],
        total: 9,
      }),
    );
    expect(v).toEqual({
      commits: [
        { sha: "s", shortSha: "sh", parent: "p", subject: "sub", authoredAtMs: 5000, shallow: false },
        { sha: "r", shortSha: "r", parent: "", subject: "root", authoredAtMs: null, shallow: true },
      ],
      total: 9,
      error: "",
    });
  });
});

describe("toCompareView", () => {
  it("maps the list, the totals and each side, keeping the source as asked", () => {
    const v = toCompareView(
      create(CompareWorktreeResponseSchema, {
        files: [create(CompareFileSchema, { path: "b.ts", oldPath: "a.ts", status: "R", added: 2, deleted: 1, submodule: true })],
        truncated: true,
        totalFiles: 3,
        totalAdded: 4,
        totalDeleted: 5,
        base: create(ResolvedDiffSourceSchema, { kind: DiffSourceKind.MERGE_BASE, label: "origin/main", sha: "abc" }),
        head: create(ResolvedDiffSourceSchema, { kind: DiffSourceKind.WORKING_TREE, label: "Working tree" }),
        baseRef: "origin/main",
        skippedNames: 2,
      }),
      { kind: "merge-base" },
      { kind: "working" },
    );
    expect(v).toEqual({
      files: [{ path: "b.ts", oldPath: "a.ts", status: "R", added: 2, deleted: 1, binary: false, submodule: true }],
      truncated: true,
      totalFiles: 3,
      totalAdded: 4,
      totalDeleted: 5,
      base: { source: { kind: "merge-base" }, label: "origin/main", sha: "abc" },
      head: { source: { kind: "working" }, label: "Working tree", sha: "" },
      baseRef: "origin/main",
      error: "",
      skippedNames: 2,
    });
  });
});

describe("toSidesView", () => {
  it("decodes a text side; an absent one, a binary one and a submodule stay what they are", () => {
    const v = toSidesView(
      create(GetWorktreeCompareFileResponseSchema, {
        old: create(FileVersionSchema, { present: true, contents: enc.encode("héllo\n"), truncated: true }),
        new: create(FileVersionSchema, { present: true, binary: true, contents: new Uint8Array([0x89, 0]) }),
        status: "M",
      }),
    );
    expect(v.old).toEqual({ present: true, text: "héllo\n", truncated: true, binary: false, submodule: false });
    expect(v.new).toEqual({ present: true, text: "", truncated: false, binary: true, submodule: false });
    expect(toSidesView(create(GetWorktreeCompareFileResponseSchema, { error: "gone" }))).toMatchObject({ old: { present: false }, new: { present: false }, error: "gone" });
    const sub = toSidesView(create(GetWorktreeCompareFileResponseSchema, { new: create(FileVersionSchema, { present: true, submodule: true, contents: enc.encode("Subproject commit abc\n") }) }));
    expect(sub.new).toMatchObject({ submodule: true, text: "Subproject commit abc\n" });
  });
});
