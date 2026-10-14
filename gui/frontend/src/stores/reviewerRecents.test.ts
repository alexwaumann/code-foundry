import { beforeEach, describe, expect, it } from "vitest";
import { addRecentReviewer, RECENT_REVIEWERS_MAX, removeRecentReviewer, useReviewerRecentsStore, type RecentReviewer } from "./reviewerRecents";

const person = (login: string, name = ""): RecentReviewer => ({ login, name, avatarUrl: `https://a/${login}`, kind: "user" });
const logins = (slug: string) => (useReviewerRecentsStore.getState().bySlug[slug] ?? []).map((r) => r.login);

beforeEach(() => {
  useReviewerRecentsStore.setState({ bySlug: {} });
  localStorage.clear();
});

describe("reviewer recents", () => {
  it("adds newest first, moves a repeat to the front, and caps the list", () => {
    addRecentReviewer("o/r", person("ana"));
    addRecentReviewer("o/r", person("kim"));
    expect(logins("o/r")).toEqual(["kim", "ana"]);
    addRecentReviewer("o/r", person("ANA", "Ana")); // same login, any case: moved, updated
    expect(logins("o/r")).toEqual(["ANA", "kim"]);
    expect(useReviewerRecentsStore.getState().bySlug["o/r"]?.[0]?.name).toBe("Ana");
    for (let i = 0; i < 10; i++) addRecentReviewer("o/r", person(`p${String(i)}`));
    expect(logins("o/r")).toHaveLength(RECENT_REVIEWERS_MAX);
    expect(logins("o/r")[0]).toBe("p9");
    expect(logins("o/r")).not.toContain("kim");
  });

  it("keeps repositories apart (slugs in any case) and tells a team from a user", () => {
    addRecentReviewer("O/R", person("ana"));
    addRecentReviewer("o/other", person("kim"));
    addRecentReviewer("o/r", { login: "acme/core", name: "Core", avatarUrl: "", kind: "team" });
    expect(logins("o/r")).toEqual(["acme/core", "ana"]);
    expect(logins("o/other")).toEqual(["kim"]);
    removeRecentReviewer("o/r", "acme/core", "user"); // wrong kind: nothing
    expect(logins("o/r")).toEqual(["acme/core", "ana"]);
  });

  it("removes one entry and drops an emptied repository", () => {
    addRecentReviewer("o/r", person("ana"));
    addRecentReviewer("o/r", person("kim"));
    removeRecentReviewer("o/r", "Kim", "user");
    expect(logins("o/r")).toEqual(["ana"]);
    removeRecentReviewer("o/r", "ana", "user");
    expect(useReviewerRecentsStore.getState().bySlug).toEqual({});
    const before = useReviewerRecentsStore.getState();
    removeRecentReviewer("o/nope", "ana", "user");
    expect(useReviewerRecentsStore.getState()).toBe(before);
  });

  it("persists to localStorage and rehydrates", async () => {
    addRecentReviewer("o/r", person("ana", "Ana"));
    const raw = localStorage.getItem("code-foundry.reviewerRecents") ?? "{}";
    expect((JSON.parse(raw) as { state: unknown }).state).toEqual({ bySlug: { "o/r": [person("ana", "Ana")] } });
    useReviewerRecentsStore.setState({ bySlug: {} });
    localStorage.setItem("code-foundry.reviewerRecents", raw);
    await useReviewerRecentsStore.persist.rehydrate();
    expect(logins("o/r")).toEqual(["ana"]);
  });
});
