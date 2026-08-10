const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function createOpaqueToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  const paddedLeft = new Uint8Array(length);
  const paddedRight = new Uint8Array(length);
  paddedLeft.set(leftBytes);
  paddedRight.set(rightBytes);

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (
      left: ArrayBufferView,
      right: ArrayBufferView,
    ) => boolean;
  };
  const timingSafeEqual = subtle.timingSafeEqual;
  if (typeof timingSafeEqual === "function") {
    return (
      timingSafeEqual.call(subtle, paddedLeft, paddedRight) &&
      leftBytes.length === rightBytes.length
    );
  }

  let difference = leftBytes.length ^ rightBytes.length;
  const leftView = new DataView(
    paddedLeft.buffer,
    paddedLeft.byteOffset,
    paddedLeft.byteLength,
  );
  const rightView = new DataView(
    paddedRight.buffer,
    paddedRight.byteOffset,
    paddedRight.byteLength,
  );
  for (let index = 0; index < paddedLeft.length; index += 1) {
    difference |= leftView.getUint8(index) ^ rightView.getUint8(index);
  }

  return difference === 0;
}

export function fingerprint(
  value: string,
  pepper: string,
  namespace: string,
): Promise<string> {
  return sha256Hex(`${namespace}\u0000${pepper}\u0000${value}`);
}
