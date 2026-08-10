const maximumEocdBytes = 65_557;
const maximumCentralDirectoryBytes = 2 * 1024 * 1024;
const maximumEntries = 10_000;
const eocdSignature = 0x06054b50;
const centralEntrySignature = 0x02014b50;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const requiredEntries = new Set([
  "[Content_Types].xml",
  "_rels/.rels",
  "ppt/_rels/presentation.xml.rels",
  "ppt/presentation.xml",
]);

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEocd(bytes: Uint8Array): number {
  const data = view(bytes);
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (data.getUint32(offset, true) === eocdSignature) {
      return offset;
    }
  }
  return -1;
}

function safeArchivePath(bytes: Uint8Array, utf8: boolean): string | null {
  let name: string;
  if (utf8) {
    try {
      name = utf8Decoder.decode(bytes);
    } catch {
      return null;
    }
  } else {
    name = "";
    for (const byte of bytes) {
      if (byte > 0x7f || byte === 0) {
        return null;
      }
      name += String.fromCharCode(byte);
    }
  }
  if (
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    [...name].some((character) => (character.codePointAt(0) ?? 0) < 32) ||
    name.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return name;
}

function directoryRepresentsPptx(
  bytes: Uint8Array,
  expectedEntries: number,
): boolean {
  const data = view(bytes);
  const found = new Set<string>();
  let offset = 0;

  for (let entry = 0; entry < expectedEntries; entry += 1) {
    if (
      offset + 46 > bytes.byteLength ||
      data.getUint32(offset, true) !== centralEntrySignature
    ) {
      return false;
    }
    const flags = data.getUint16(offset + 8, true);
    const method = data.getUint16(offset + 10, true);
    const filenameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const nextOffset =
      offset + 46 + filenameLength + extraLength + commentLength;
    if (
      flags & 1 ||
      (method !== 0 && method !== 8) ||
      nextOffset > bytes.byteLength
    ) {
      return false;
    }

    const name = safeArchivePath(
      bytes.subarray(offset + 46, offset + 46 + filenameLength),
      Boolean(flags & 0x0800),
    );
    if (!name) {
      return false;
    }
    const lowerName = name.toLowerCase();
    if (
      lowerName === "ppt/vbaproject.bin" ||
      lowerName.startsWith("ppt/activex/")
    ) {
      return false;
    }
    if (requiredEntries.has(name)) {
      found.add(name);
    }
    offset = nextOffset;
  }

  return offset === bytes.byteLength && found.size === requiredEntries.size;
}

export async function isPptxArchive(
  bucket: R2Bucket,
  key: string,
  size: number,
): Promise<boolean> {
  if (size < 22) {
    return false;
  }
  const tailLength = Math.min(size, maximumEocdBytes);
  const tailObject = await bucket.get(key, {
    range: { length: tailLength, offset: size - tailLength },
  });
  if (!tailObject) {
    return false;
  }
  const tail = new Uint8Array(await tailObject.arrayBuffer());
  const eocdOffsetInTail = findEocd(tail);
  if (eocdOffsetInTail < 0) {
    return false;
  }

  const eocd = view(tail);
  const diskNumber = eocd.getUint16(eocdOffsetInTail + 4, true);
  const directoryDisk = eocd.getUint16(eocdOffsetInTail + 6, true);
  const entriesOnDisk = eocd.getUint16(eocdOffsetInTail + 8, true);
  const entries = eocd.getUint16(eocdOffsetInTail + 10, true);
  const directorySize = eocd.getUint32(eocdOffsetInTail + 12, true);
  const directoryOffset = eocd.getUint32(eocdOffsetInTail + 16, true);
  const commentLength = eocd.getUint16(eocdOffsetInTail + 20, true);
  const absoluteEocdOffset = size - tailLength + eocdOffsetInTail;
  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    entries === 0 ||
    entries !== entriesOnDisk ||
    entries > maximumEntries ||
    directorySize === 0 ||
    directorySize > maximumCentralDirectoryBytes ||
    directoryOffset + directorySize !== absoluteEocdOffset ||
    eocdOffsetInTail + 22 + commentLength !== tail.byteLength
  ) {
    return false;
  }

  const directoryObject = await bucket.get(key, {
    range: { length: directorySize, offset: directoryOffset },
  });
  if (!directoryObject) {
    return false;
  }
  return directoryRepresentsPptx(
    new Uint8Array(await directoryObject.arrayBuffer()),
    entries,
  );
}
