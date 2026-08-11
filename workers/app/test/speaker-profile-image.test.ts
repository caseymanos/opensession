import { describe, expect, it } from "vitest";

import { imageDimensions } from "../src/speaker-profile/service";

function webpContainer(
  chunk: "VP8 " | "VP8L" | "VP8X",
  length: number,
): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set(
    [...chunk].map((character) => character.charCodeAt(0)),
    12,
  );
  return bytes;
}

describe("speaker profile image dimensions", () => {
  it.each(["VP8X", "VP8L", "VP8"] as const)(
    "accepts %s WebP dimensions",
    (variant) => {
      const bytes = webpContainer(
        variant === "VP8" ? "VP8 " : variant,
        variant === "VP8L" ? 25 : 30,
      );
      if (variant === "VP8X") {
        bytes.set([0xaf, 0x04, 0x00], 24);
        bytes.set([0xaf, 0x04, 0x00], 27);
      } else if (variant === "VP8L") {
        bytes[20] = 0x2f;
        bytes[21] = 0xaf;
        bytes[22] = 0xc4;
        bytes[23] = 0x2b;
        bytes[24] = 0x01;
      } else {
        bytes.set([0x9d, 0x01, 0x2a], 23);
        bytes.set([0xb0, 0x04], 26);
        bytes.set([0xb0, 0x04], 28);
      }
      expect(imageDimensions(bytes, "image/webp")).toEqual({
        height: 1200,
        width: 1200,
      });
    },
  );

  it("fails closed for a malformed WebP container", () => {
    expect(imageDimensions(new Uint8Array(30), "image/webp")).toBeNull();
  });
});
