/**
 * A minimal, dependency-free ZIP writer producing stored (uncompressed) archives.
 * A .docx is a ZIP of a fixed set of XML parts, and a stored ZIP is a valid ZIP,
 * so this is all the export needs and it runs anywhere (Cloudflare Workers, Node)
 * without a native or Node-only dependency. Pure and unit-tested.
 *
 * Only what a Word package needs is implemented: local file headers, the central
 * directory and the end-of-central-directory record, little-endian throughout,
 * with UTF-8 file names flagged.
 */

export interface ZipEntry {
  /** The path inside the archive, e.g. word/document.xml. */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte array (the checksum ZIP records for each entry). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pushU16(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff);
}
function pushU32(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function pushBytes(out: number[], bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

// A fixed MS-DOS date and time keeps the output deterministic (Word ignores it).
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01

/** Build a stored (uncompressed) ZIP archive from the entries. */
export function makeZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const records = entries.map((e) => ({
    ...e,
    nameBytes: encoder.encode(e.name),
    crc: crc32(e.data),
    offset: 0,
  }));

  for (const r of records) {
    r.offset = local.length;
    // Local file header.
    pushU32(local, 0x04034b50);
    pushU16(local, 20); // version needed
    pushU16(local, 0x0800); // flags: UTF-8 names
    pushU16(local, 0); // method: stored
    pushU16(local, DOS_TIME);
    pushU16(local, DOS_DATE);
    pushU32(local, r.crc);
    pushU32(local, r.data.length); // compressed size
    pushU32(local, r.data.length); // uncompressed size
    pushU16(local, r.nameBytes.length);
    pushU16(local, 0); // extra length
    pushBytes(local, r.nameBytes);
    pushBytes(local, r.data);
  }

  for (const r of records) {
    pushU32(central, 0x02014b50);
    pushU16(central, 20); // version made by
    pushU16(central, 20); // version needed
    pushU16(central, 0x0800); // flags: UTF-8 names
    pushU16(central, 0); // method: stored
    pushU16(central, DOS_TIME);
    pushU16(central, DOS_DATE);
    pushU32(central, r.crc);
    pushU32(central, r.data.length);
    pushU32(central, r.data.length);
    pushU16(central, r.nameBytes.length);
    pushU16(central, 0); // extra length
    pushU16(central, 0); // comment length
    pushU16(central, 0); // disk number start
    pushU16(central, 0); // internal attributes
    pushU32(central, 0); // external attributes
    pushU32(central, r.offset);
    pushBytes(central, r.nameBytes);
  }

  const eocd: number[] = [];
  pushU32(eocd, 0x06054b50);
  pushU16(eocd, 0); // this disk
  pushU16(eocd, 0); // disk with central directory
  pushU16(eocd, records.length); // entries on this disk
  pushU16(eocd, records.length); // total entries
  pushU32(eocd, central.length); // central directory size
  pushU32(eocd, local.length); // central directory offset
  pushU16(eocd, 0); // comment length

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out;
}
