/**
 * Assemble the .docx: encode the WordprocessingML parts and store them in a ZIP.
 * The XML building lives in wordml.ts and the ZIP in zip.ts; this is the small
 * glue that composes them, so the export runs on Cloudflare Workers with no
 * native or Node-only dependency.
 */
import type { ReportDocument } from '../reportTypes';
import { reportDocumentParts } from './wordml';
import { makeZip, type ZipEntry } from './zip';

export { reportFilename } from './wordml';

/** Render a report document to the bytes of a .docx file. */
export function renderReportDocx(doc: ReportDocument): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = reportDocumentParts(doc).map((p) => ({
    name: p.name,
    data: encoder.encode(p.xml),
  }));
  return makeZip(entries);
}
