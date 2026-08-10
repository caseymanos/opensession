import { afterEach, describe, expect, it, vi } from "vitest";

import {
  constantTimeEqual,
  createOpaqueToken,
  fingerprint,
  sha256Hex,
} from "../src/auth/crypto";

describe("authentication cryptography", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates independent 256-bit URL-safe opaque values", () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it("hashes secrets and namespaces privacy-preserving fingerprints", async () => {
    await expect(sha256Hex("OpenSession")).resolves.toMatch(/^[a-f0-9]{64}$/);
    const first = await fingerprint("same", "p".repeat(32), "email");
    const second = await fingerprint("same", "p".repeat(32), "ip");

    expect(first).not.toBe(second);
    expect(constantTimeEqual(first, first)).toBe(true);
    expect(constantTimeEqual(first, second)).toBe(false);
    expect(constantTimeEqual(first, `${first}0`)).toBe(false);
  });

  it("uses the runtime timing-safe primitive when available", () => {
    const timingSafeEqual = vi.fn(
      (left: ArrayBufferView, right: ArrayBufferView) =>
        Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
          Buffer.from(right.buffer, right.byteOffset, right.byteLength),
        ),
    );
    vi.stubGlobal("crypto", {
      ...globalThis.crypto,
      subtle: { ...globalThis.crypto.subtle, timingSafeEqual },
    });

    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different")).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });
});
