import { describe, expect, it } from "vitest";

import { permissionsForAccess } from "../src/auth/authorization";

describe("event authorization policy", () => {
  it.each([
    [
      "owner",
      null,
      null,
      ["organization:manage", "event:manage", "review:submit"],
    ],
    ["organizer", null, null, ["event:manage", "review:submit"]],
    ["viewer", null, null, ["event:read", "session:read:any"]],
    [null, "organizer", null, ["event:manage", "review:submit"]],
    [null, "reviewer", null, ["review:read", "review:submit"]],
    [null, "viewer", null, ["event:read", "session:read:any"]],
    [null, null, "contact_one", ["portal:read:self", "session:read:self"]],
  ] as const)(
    "maps organization=%s event=%s speaker=%s without client trust",
    (organizationRole, eventRole, contactId, expected) => {
      expect(
        permissionsForAccess(organizationRole, eventRole, contactId),
      ).toEqual(expect.arrayContaining([...expected]));
    },
  );

  it("fails closed without a current membership or speaker relationship", () => {
    expect(permissionsForAccess(null, null, null)).toEqual([]);
  });
});
