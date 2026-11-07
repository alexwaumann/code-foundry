import { describe, expect, it } from "vitest";
import { addressParts } from "./browserAddress";

describe("addressParts", () => {
  it.each([
    ["https://example.com/", "example.com", { lead: "https://", site: "example.com", rest: "" }],
    ["https://a.b.example.co.uk/x?y=1#z", "example.co.uk", { lead: "https://a.b.", site: "example.co.uk", rest: "/x?y=1#z" }],
    ["http://localhost:5173/app", "localhost", { lead: "http://", site: "localhost:5173", rest: "/app" }],
    ["http://127.0.0.1:8000/", "127.0.0.1", { lead: "http://", site: "127.0.0.1:8000", rest: "" }],
    ["https://login.bank.com.evil.co/path", "evil.co", { lead: "https://login.bank.com.", site: "evil.co", rest: "/path" }],
  ])("%s", (url, site, want) => {
    expect(addressParts(url, site)).toEqual(want);
  });

  it("does not take a suffix of a label for the domain", () => {
    expect(addressParts("https://notevil.co/", "evil.co")).toEqual({ lead: "https://", site: "notevil.co", rest: "" });
  });

  it.each([
    ["about:blank", ""],
    ["data:text/html,hi", ""],
    ["not a url", "example.com"],
  ])("has nothing to split in %s", (url, site) => {
    expect(addressParts(url, site)).toBeNull();
  });
});
