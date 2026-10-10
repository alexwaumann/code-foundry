import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { PublishOwnerKind, PublishOwnerSchema, RepositoryVisibility } from "@/gen/codefoundry/v1/repo_pb";
import { toPublishOwnerView } from "./publish";

describe("toPublishOwnerView", () => {
  it("maps kind, allowed visibilities and known", () => {
    expect(
      toPublishOwnerView(
        create(PublishOwnerSchema, {
          login: "octo-org",
          kind: PublishOwnerKind.ORGANIZATION,
          allowed: [RepositoryVisibility.PUBLIC, RepositoryVisibility.INTERNAL, RepositoryVisibility.UNSPECIFIED],
          known: true,
        }),
      ),
    ).toEqual({ login: "octo-org", kind: "org", allowed: ["public", "internal"], known: true });
    expect(toPublishOwnerView(create(PublishOwnerSchema, { login: "dev", kind: PublishOwnerKind.USER, allowed: [RepositoryVisibility.PRIVATE] }))).toEqual({
      login: "dev",
      kind: "user",
      allowed: ["private"],
      known: false,
    });
  });
});
