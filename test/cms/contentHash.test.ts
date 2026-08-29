/**
 * Build Prompt 38, part 5: the same workbook, recognised after a re-save.
 *
 * WHAT THESE PROVE, AND WHY THE MIDDLE ONE MATTERS MOST. The byte hash already
 * catches the same file uploaded twice. It does NOT catch the case that got
 * through: opening the workbook and saving it again rewrites the container's
 * directory and its summary stream, so the bytes differ while every cell still
 * says what it said. The second test below does exactly that — it re-writes
 * the real `SO-Ver1.xls` fixture through SheetJS and shows the refusal.
 *
 * Criteria 15, 16, 17 and 18 of the phase are each a named test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import { receiveUpload } from '../../src/lib/cms/import/uploadCentre.ts';
import {
  workbookContent,
  normaliseCell,
  canonicalNumber,
} from '../../src/lib/cms/import/contentHash.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SO_FILE = readFileSync(join(here, 'support', 'SO-Ver1.xls'));

const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: new Date('2026-08-29T10:00:00Z'),
};

const asClient = (db: TestClient) => db as never;

async function seeded(): Promise<TestClient> {
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  const db = await createTestDb();
  await seedHass(db);
  return db;
}

const upload = (db: TestClient, bytes: Uint8Array, filename: string) =>
  receiveUpload(
    asClient(db),
    {
      importType: 'SALES_ORDER',
      sourceSystemId: 'SRC-ORACLE',
      affiliateId: null,
      filename,
      reportingPeriodFrom: null,
      reportingPeriodTo: null,
      bytes,
    },
    CTX,
  );

/**
 * The same data, saved again.
 *
 * SheetJS reads the workbook and writes a fresh one from the parsed cells. The
 * container is rebuilt, so the bytes differ; not one cell is touched, so the
 * data does not. That is what Excel does when somebody opens a report and
 * presses save, and it is why the byte hash is not enough.
 *
 * `cellNF` AND `cellStyles` ARE NOT DECORATION HERE, AND THIS WAS MEASURED.
 * Without them SheetJS drops each cell's number format on the way out, and a
 * number format is the only thing that makes a date a date in this file
 * format: the round trip turned all fourteen date columns of row 1 into plain
 * numbers. Excel preserves those formats, so a re-save without them would be
 * simulating a corruption rather than a save, and the test would be proving
 * the wrong thing. The consequence for the product is worth stating: a tool
 * that DID strip the formats would produce a workbook this check reads as
 * different content and lets through — a missed duplicate, never a wrongly
 * refused one, which is the safe direction for the mistake to fall.
 */
function resave(bytes: Uint8Array): Uint8Array {
  const workbook = XLSX.read(bytes, {
    type: 'buffer',
    cellDates: true,
    cellNF: true,
    cellStyles: true,
  });
  return new Uint8Array(
    XLSX.write(workbook, { type: 'array', bookType: 'biff8', cellStyles: true }) as ArrayBuffer,
  );
}

test('criterion 15: the same file is refused by bytes, naming the earlier batch', async () => {
  const db = await seeded();
  const first = await upload(db, new Uint8Array(SO_FILE), 'SO-Ver1.xls');
  assert.equal(first.stage, 'READY', 'the first upload lands');

  const again = await upload(db, new Uint8Array(SO_FILE), 'a-different-name.xls');
  assert.equal(again.stage, 'DUPLICATE', 'the same bytes are refused as a duplicate');
  assert.equal(again.duplicate?.batchId, first.batchId, 'and the earlier batch is named');
  assert.ok((again.duplicate?.uploadedAt ?? '') !== '', 'with when it was uploaded');
  // The filename is not the rule and never was: the second upload carried a
  // different name and was still refused.
  assert.notEqual(again.duplicate?.filename, 'a-different-name.xls');
  db.close();
});

test('criterion 16: a re-saved copy with identical content is refused, and says so', async () => {
  const db = await seeded();
  const original = new Uint8Array(SO_FILE);
  const saved = resave(original);

  // THE BYTES REALLY DID CHANGE. If they had not, this test would prove
  // nothing: it would be criterion 15 again under a different name.
  const bytesDiffer =
    original.byteLength !== saved.byteLength ||
    original.some((byte, index) => byte !== saved[index]);
  assert.ok(bytesDiffer, 'the re-saved file must not be byte-identical');

  const before = await workbookContent(original);
  const after = await workbookContent(saved);
  console.log(`[hash] original content ${before.contentSha256}`);
  console.log(`[hash] re-saved  content ${after.contentSha256}`);
  assert.equal(after.contentSha256, before.contentSha256, 'the data is identical');

  const first = await upload(db, original, 'SO-Ver1.xls');
  assert.equal(first.stage, 'READY');
  const second = await upload(db, saved, 'SO-Ver1 (resaved).xls');

  // A DIFFERENT ANSWER FROM THE BYTE CASE, which is the whole point: an
  // operator who re-saved the workbook must be told that is what happened.
  assert.equal(second.stage, 'RESAVED');
  assert.notEqual(second.stage, 'DUPLICATE', 'and it is not reported as the same file');
  assert.equal(second.duplicate?.batchId, first.batchId, 'the earlier batch is named');
  assert.equal(second.contentSha256, before.contentSha256);
  assert.notEqual(second.fileSha256, first.fileSha256, 'the file hashes genuinely differ');
  console.log(`[hash] refused: RESAVED, earlier batch ${second.duplicate?.batchId}`);
  db.close();
});

test('criterion 17: a genuinely different file proceeds and reports the overlap', async () => {
  const db = await seeded();
  const first = await upload(db, new Uint8Array(SO_FILE), 'SO-Ver1.xls');
  assert.equal(first.stage, 'READY');

  // A real edit: one cell changed. Different bytes AND different data, so it
  // is neither of the two refusals.
  const workbook = XLSX.read(SO_FILE, { type: 'buffer', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]!]!;
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true });
  const headers = (grid[0] ?? []).map((h) => String(h ?? '').trim());
  const column = headers.indexOf('DOCUMENT_NUMBER');
  assert.ok(column >= 0, 'the fixture carries a document number column');
  const edited = grid.map((line, index) => {
    if (index !== 1 || !Array.isArray(line)) return line;
    const copy = [...line];
    copy[column] = 'BRAND-NEW-DOCUMENT';
    return copy;
  });
  const rebuilt = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(rebuilt, XLSX.utils.aoa_to_sheet(edited as unknown[][]), 'Sheet1');
  const changed = new Uint8Array(
    XLSX.write(rebuilt, { type: 'array', bookType: 'biff8' }) as ArrayBuffer,
  );

  const different = await workbookContent(changed);
  assert.notEqual(different.contentSha256, (await workbookContent(SO_FILE)).contentSha256);

  const second = await upload(db, changed, 'SO-Ver2.xls');
  assert.equal(second.stage, 'READY', 'a genuinely different file proceeds');
  // AND SAYS HOW MUCH OF IT IS ALREADY IN. The first upload was validated but
  // never committed, so nothing is canonical yet and the honest answer is
  // zero; the figure is present either way, which is what stops the number
  // being a surprise after the import rather than before it.
  assert.equal(typeof second.documentsAlreadyImported, 'number');
  console.log(
    `[overlap] ${second.documentsAlreadyImported} of ${second.summary?.uniqueDocuments ?? 0} documents already imported`,
  );
  db.close();
});

test('criterion 18: the normalisation rules, asserted one at a time', () => {
  // 3988 AND 3988.0 HASH IDENTICALLY. Named in the phase because a document
  // number that arrives as a float in one export and an integer in the next
  // would otherwise mint a second order for the same document.
  assert.equal(normaliseCell(3988), 'N:3988');
  assert.equal(normaliseCell(3988.0), 'N:3988');
  assert.equal(normaliseCell('3988.0'), 'N:3988');
  assert.equal(normaliseCell('3988'), 'N:3988');

  // A LEADING ZERO IS PART OF AN IDENTIFIER, not a number to be tidied. "007"
  // and 7 are different values and must never collide.
  assert.equal(normaliseCell('007'), 'T:007');
  assert.notEqual(normaliseCell('007'), normaliseCell(7));

  // ONE REPRESENTATION FOR AN EMPTY CELL: null, undefined, empty and blank are
  // the same fact, and that fact is "no value", which drops out of the hash.
  for (const empty of [null, undefined, '', '   ', '\t']) {
    assert.equal(normaliseCell(empty), null, `${JSON.stringify(empty)} is empty`);
  }

  // ONE SERIALISATION FOR A DATE, from the parsed value. The Excel serial
  // never reaches the hash.
  assert.equal(normaliseCell(new Date('2026-05-14T10:55:30Z')), 'D:2026-05-14T10:55:30.000Z');

  // STRINGS ARE TRIMMED, and case is NOT folded: a case change is a real edit.
  assert.equal(normaliseCell('  Nairobi  '), 'T:Nairobi');
  assert.notEqual(normaliseCell('Nairobi'), normaliseCell('NAIROBI'));

  // A TYPE TAG, so the number 3988 and the text "3988" cannot be told apart by
  // luck alone... except where the text IS the number, which is the rule
  // above and is deliberate.
  assert.equal(normaliseCell(true), 'B:1');

  // The numeric canonical form, at the edges.
  assert.equal(canonicalNumber(-0), '0');
  assert.equal(canonicalNumber(3988), '3988');
  assert.equal(canonicalNumber(3988.1), '3988.1');
});

test('column order and row order do not reach the digest', async () => {
  // TWO SHEETS, THE SAME DATA, ARRANGED DIFFERENTLY. Moving a column or
  // re-sorting a report changes the file and not the business.
  const forward = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    forward,
    XLSX.utils.aoa_to_sheet([
      ['A', 'B', 'C'],
      ['one', 1, 'x'],
      ['two', 2, 'y'],
    ]),
    'Sheet1',
  );
  const shuffled = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    shuffled,
    XLSX.utils.aoa_to_sheet([
      ['C', 'A', 'B'],
      ['y', 'two', 2],
      ['x', 'one', 1],
    ]),
    'Renamed',
  );
  const one = await workbookContent(
    new Uint8Array(XLSX.write(forward, { type: 'array', bookType: 'biff8' }) as ArrayBuffer),
  );
  const two = await workbookContent(
    new Uint8Array(XLSX.write(shuffled, { type: 'array', bookType: 'biff8' }) as ArrayBuffer),
  );
  assert.equal(two.contentSha256, one.contentSha256);

  // AND A REAL CHANGE STILL SHOWS. A hash that ignored everything would pass
  // the test above and be worthless.
  const edited = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    edited,
    XLSX.utils.aoa_to_sheet([
      ['A', 'B', 'C'],
      ['one', 1, 'x'],
      ['two', 3, 'y'],
    ]),
    'Sheet1',
  );
  const three = await workbookContent(
    new Uint8Array(XLSX.write(edited, { type: 'array', bookType: 'biff8' }) as ArrayBuffer),
  );
  assert.notEqual(three.contentSha256, one.contentSha256, 'one changed cell changes the digest');
});
