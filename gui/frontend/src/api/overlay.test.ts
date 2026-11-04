import { describe, expect, it } from "vitest";
import { ownHostEndpoint } from "./overlay";

describe("ownHostEndpoint", () => {
  it.each([
    ["http://127.0.0.1:7788", "http://localhost:7788"],
    ["http://localhost:7788", "http://localhost:7788"],
  ])("%s", (baseUrl, want) => {
    expect(ownHostEndpoint({ baseUrl, token: "t" })).toEqual({ baseUrl: want, token: "t" });
  });
});
