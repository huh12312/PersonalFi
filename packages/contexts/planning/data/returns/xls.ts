// SPDX-License-Identifier: MIT
/**
 * A minimal reader for legacy Excel `.xls` (BIFF8 inside an OLE2 Compound File)
 * — just enough to read the numeric and shared-string cells of one worksheet.
 *
 * Why it exists: Robert Shiller publishes `ie_data.xls` and Aswath Damodaran
 * `histretSP.xls`, both BIFF8, and this repo has no spreadsheet library and may
 * not add one for this (D14; dispatch §4 item 10's rule against a dependency
 * for twenty lines of arithmetic applies with more force to a parser). It is
 * used only by `fetch.ts`, offline, by an operator — never at request time.
 *
 * Formats, from the published specifications:
 *
 *   * **[MS-CFB]** Compound File Binary: a 512-byte header, a FAT of sector
 *     chains, a directory of 128-byte entries. Streams under the 4,096-byte
 *     cutoff live in the mini stream; the workbook never is, but the reader
 *     handles both.
 *   * **[MS-XLS]** BIFF8 records `[type u16][length u16][data]`: `BOUNDSHEET`
 *     (0x0085) gives each sheet's offset, `SST` (0x00FC) + `CONTINUE` (0x003C)
 *     the shared strings, and the cell records `NUMBER` (0x0203), `RK` (0x027E),
 *     `MULRK` (0x00BD), `LABELSST` (0x00FD) and `FORMULA` (0x0006, whose cached
 *     result is read when it is a number).
 *
 * Anything else — styles, merged cells, charts, a formula's string result — is
 * skipped. A malformed file throws; nothing here guesses.
 */

export type XlsCell = number | string;

/** One worksheet: `cells[row][col]`, sparse. */
export interface XlsSheet {
  readonly name: string;
  readonly cells: ReadonlyMap<number, ReadonlyMap<number, XlsCell>>;
}

const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

function fail(message: string): never {
  throw new Error(`xls: ${message}`);
}

/** Read one named stream out of a Compound File. */
export function readCompoundStream(file: Uint8Array, streamName: string): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  signature.forEach((byte, i) => {
    if (file[i] !== byte) fail('not an OLE2 compound file');
  });
  const sectorSize = 1 << view.getUint16(0x1e, true);
  const miniSectorSize = 1 << view.getUint16(0x20, true);
  const fatSectors = view.getUint32(0x2c, true);
  const firstDirectorySector = view.getUint32(0x30, true);
  const miniCutoff = view.getUint32(0x38, true);
  const firstMiniFatSector = view.getUint32(0x3c, true);
  const firstDifatSector = view.getUint32(0x44, true);

  const sectorOffset = (sector: number) => (sector + 1) * sectorSize;

  // The DIFAT: 109 entries in the header, then chained DIFAT sectors.
  const fatSectorList: number[] = [];
  for (let i = 0; i < 109 && fatSectorList.length < fatSectors; i += 1) {
    const entry = view.getUint32(0x4c + 4 * i, true);
    if (entry !== FREE_SECTOR) fatSectorList.push(entry);
  }
  let difat = firstDifatSector;
  const perDifat = sectorSize / 4 - 1;
  while (fatSectorList.length < fatSectors && difat !== END_OF_CHAIN && difat !== FREE_SECTOR) {
    const base = sectorOffset(difat);
    for (let i = 0; i < perDifat && fatSectorList.length < fatSectors; i += 1) {
      fatSectorList.push(view.getUint32(base + 4 * i, true));
    }
    difat = view.getUint32(base + 4 * perDifat, true);
  }
  const fat: number[] = [];
  for (const sector of fatSectorList) {
    const base = sectorOffset(sector);
    for (let i = 0; i < sectorSize / 4; i += 1) fat.push(view.getUint32(base + 4 * i, true));
  }

  const chain = (start: number, table: readonly number[]): number[] => {
    const sectors: number[] = [];
    let sector = start;
    while (sector !== END_OF_CHAIN) {
      if (sector >= table.length || sectors.length > table.length) fail('broken sector chain');
      sectors.push(sector);
      sector = table[sector] ?? fail('broken sector chain');
    }
    return sectors;
  };
  const readChain = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let written = 0;
    for (const sector of chain(start, fat)) {
      const take = Math.min(sectorSize, size - written);
      if (take <= 0) break;
      out.set(file.subarray(sectorOffset(sector), sectorOffset(sector) + take), written);
      written += take;
    }
    if (written < size) fail('stream shorter than its directory entry');
    return out;
  };

  // The directory: 128-byte entries along the directory chain.
  const directorySectors = chain(firstDirectorySector, fat);
  interface Entry {
    readonly name: string;
    readonly kind: number;
    readonly start: number;
    readonly size: number;
  }
  const entries: Entry[] = [];
  for (const sector of directorySectors) {
    const base = sectorOffset(sector);
    for (let e = 0; e < sectorSize / 128; e += 1) {
      const at = base + e * 128;
      const nameBytes = view.getUint16(at + 0x40, true);
      let name = '';
      for (let c = 0; c + 2 < nameBytes; c += 2) {
        name += String.fromCharCode(view.getUint16(at + c, true));
      }
      entries.push({
        name,
        kind: view.getUint8(at + 0x42),
        start: view.getUint32(at + 0x74, true),
        size: view.getUint32(at + 0x78, true),
      });
    }
  }
  const root = entries.find((entry) => entry.kind === 5) ?? fail('no root entry');
  const wanted =
    entries.find((entry) => entry.kind === 2 && entry.name === streamName) ??
    fail(`no stream named ${streamName}`);
  if (wanted.size >= miniCutoff) return readChain(wanted.start, wanted.size);

  // Small stream: it lives in the mini stream, addressed by the mini FAT.
  const miniStream = readChain(root.start, root.size);
  const miniFat: number[] = [];
  if (firstMiniFatSector !== END_OF_CHAIN) {
    for (const sector of chain(firstMiniFatSector, fat)) {
      const base = sectorOffset(sector);
      for (let i = 0; i < sectorSize / 4; i += 1) miniFat.push(view.getUint32(base + 4 * i, true));
    }
  }
  const out = new Uint8Array(wanted.size);
  let written = 0;
  for (const mini of chain(wanted.start, miniFat)) {
    const take = Math.min(miniSectorSize, wanted.size - written);
    out.set(miniStream.subarray(mini * miniSectorSize, mini * miniSectorSize + take), written);
    written += take;
  }
  return out;
}

/** RK: a packed number (MS-XLS 2.5.217). */
function decodeRk(rk: number): number {
  const scaled = (rk & 0x01) !== 0;
  let decoded: number;
  if ((rk & 0x02) !== 0) {
    decoded = rk >> 2; // a signed 30-bit integer
  } else {
    const bytes = new DataView(new ArrayBuffer(8));
    bytes.setUint32(0, rk & 0xfffffffc, false);
    bytes.setUint32(4, 0, false);
    decoded = bytes.getFloat64(0, false);
  }
  return scaled ? decoded / 100 : decoded;
}

/**
 * BIFF8 records of one substream, with each record's CONTINUE records
 * concatenated onto it (only the SST needs them, and it gets them with their
 * boundaries preserved — see `readSharedStrings`).
 */
interface BiffRecord {
  readonly type: number;
  readonly offset: number;
  readonly data: Uint8Array;
  /** For SST: the byte boundaries inside `data` where a CONTINUE began. */
  readonly continues: readonly number[];
}

function records(stream: Uint8Array, from: number): BiffRecord[] {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const out: BiffRecord[] = [];
  let at = from;
  while (at + 4 <= stream.length) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    const offset = at;
    const parts: Uint8Array[] = [stream.subarray(at + 4, at + 4 + length)];
    const continues: number[] = [];
    let total = length;
    at += 4 + length;
    while (at + 4 <= stream.length && view.getUint16(at, true) === 0x003c) {
      const more = view.getUint16(at + 2, true);
      continues.push(total);
      parts.push(stream.subarray(at + 4, at + 4 + more));
      total += more;
      at += 4 + more;
    }
    const data = new Uint8Array(total);
    let written = 0;
    for (const part of parts) {
      data.set(part, written);
      written += part.length;
    }
    out.push({ type, offset, data, continues });
    if (type === 0x000a && out.length > 1) break; // EOF of this substream
  }
  return out;
}

/** The shared-string table, honouring CONTINUE boundaries (a string may switch width at one). */
function readSharedStrings(record: BiffRecord): string[] {
  const data = record.data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const unique = view.getUint32(4, true);
  const boundaries = new Set(record.continues);
  const strings: string[] = [];
  let at = 8;
  for (let n = 0; n < unique; n += 1) {
    const chars = view.getUint16(at, true);
    let flags = view.getUint8(at + 2);
    at += 3;
    const richRuns = (flags & 0x08) !== 0 ? view.getUint16(at, true) : 0;
    if ((flags & 0x08) !== 0) at += 2;
    const extSize = (flags & 0x04) !== 0 ? view.getUint32(at, true) : 0;
    if ((flags & 0x04) !== 0) at += 4;
    let text = '';
    let read = 0;
    while (read < chars) {
      if (boundaries.has(at) && read > 0) {
        // A CONTINUE split the characters: a fresh option byte says the new width.
        flags = view.getUint8(at);
        at += 1;
      }
      const wide = (flags & 0x01) !== 0;
      text += String.fromCharCode(wide ? view.getUint16(at, true) : view.getUint8(at));
      at += wide ? 2 : 1;
      read += 1;
    }
    at += richRuns * 4 + extSize;
    strings.push(text);
  }
  return strings;
}

/** Every worksheet's numeric and shared-string cells. */
export function readWorkbook(file: Uint8Array): readonly XlsSheet[] {
  const stream = (() => {
    try {
      return readCompoundStream(file, 'Workbook');
    } catch {
      return readCompoundStream(file, 'Book');
    }
  })();
  const globals = records(stream, 0);
  const sheets: { name: string; offset: number }[] = [];
  let shared: string[] = [];
  for (const record of globals) {
    if (record.type === 0x0085) {
      const view = new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength);
      const offset = view.getUint32(0, true);
      const chars = view.getUint8(6);
      const wide = (view.getUint8(7) & 0x01) !== 0;
      let name = '';
      for (let c = 0; c < chars; c += 1) {
        name += String.fromCharCode(wide ? view.getUint16(8 + 2 * c, true) : view.getUint8(8 + c));
      }
      sheets.push({ name, offset });
    } else if (record.type === 0x00fc) {
      shared = readSharedStrings(record);
    }
  }

  return sheets.map(({ name, offset }) => {
    const cells = new Map<number, Map<number, XlsCell>>();
    const put = (row: number, col: number, cell: XlsCell) => {
      let line = cells.get(row);
      if (line === undefined) {
        line = new Map();
        cells.set(row, line);
      }
      line.set(col, cell);
    };
    for (const record of records(stream, offset)) {
      const view = new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength);
      switch (record.type) {
        case 0x0203: // NUMBER
          put(view.getUint16(0, true), view.getUint16(2, true), view.getFloat64(6, true));
          break;
        case 0x027e: // RK
          put(view.getUint16(0, true), view.getUint16(2, true), decodeRk(view.getInt32(6, true)));
          break;
        case 0x00bd: {
          // MULRK
          const row = view.getUint16(0, true);
          const first = view.getUint16(2, true);
          const count = (record.data.length - 6) / 6;
          for (let i = 0; i < count; i += 1) {
            put(row, first + i, decodeRk(view.getInt32(4 + 6 * i + 2, true)));
          }
          break;
        }
        case 0x00fd: // LABELSST
          put(
            view.getUint16(0, true),
            view.getUint16(2, true),
            shared[view.getUint32(6, true)] ?? fail('LABELSST index out of range'),
          );
          break;
        case 0x0006: {
          // FORMULA: a cached number unless the top two bytes are 0xFFFF.
          if (view.getUint16(12, true) !== 0xffff) {
            put(view.getUint16(0, true), view.getUint16(2, true), view.getFloat64(6, true));
          }
          break;
        }
        default:
          break;
      }
    }
    return { name, cells };
  });
}
