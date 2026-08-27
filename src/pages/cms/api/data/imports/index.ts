/**
 * GET and POST /api/data/imports on cms.murikah.com.
 *
 * GET lists the import history. POST is the one upload door: a multipart
 * form carrying the data type, the source system, the affiliate, the
 * reporting period and the file. It validates and reports, and it does NOT
 * commit. Committing is a separate call against the batch this one returns,
 * because a person has to be able to look at what arrived before it becomes
 * a sales order.
 */
import type { APIRoute } from 'astro';
import {
  requireImportsView,
  requireImportUpload,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import {
  listBatches,
  receiveUpload,
  IMPORT_TYPES,
  MAX_UPLOAD_BYTES,
  type ImportType,
} from '../../../../../lib/cms/import/uploadCentre.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireImportsView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    return ok({ batches: await listBatches(connection.db) });
  } catch (error) {
    return serverError('data.imports.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const form = await context.request.formData().catch(() => null);
  if (form === null) {
    return invalid([{ field: 'file', message: 'Send the upload as a multipart form.' }]);
  }
  const importType = String(form.get('importType') ?? '');
  if (!IMPORT_TYPES.includes(importType as ImportType)) {
    return invalid([{ field: 'importType', message: 'Choose a data type.' }]);
  }
  // Both the Upload Centre code and the data type's own upload code, checked
  // before the file is read rather than after.
  const auth = requireImportUpload(context, importType as ImportType);
  if (!auth.ok) return auth.response;

  const file = form.get('file');
  if (!(file instanceof File)) {
    return invalid([{ field: 'file', message: 'Choose a file to upload.' }]);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return invalid([
      {
        field: 'file',
        message: `The file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB limit.`,
      },
    ]);
  }
  const sourceSystemId = String(form.get('sourceSystemId') ?? '');
  if (sourceSystemId === '') {
    return invalid([{ field: 'sourceSystemId', message: 'Choose the source system.' }]);
  }
  const affiliateRaw = String(form.get('affiliateId') ?? '').trim();
  if (importType === 'PURCHASE_ORDER' && affiliateRaw === '') {
    return invalid([
      {
        field: 'affiliateId',
        message: 'The purchase order extract carries no affiliate column, so choose one here.',
      },
    ]);
  }

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const outcome = await receiveUpload(
      connection.db,
      {
        importType: importType as ImportType,
        sourceSystemId,
        affiliateId: affiliateRaw === '' ? null : affiliateRaw,
        filename: file.name,
        reportingPeriodFrom: nullableField(form.get('reportingPeriodFrom')),
        reportingPeriodTo: nullableField(form.get('reportingPeriodTo')),
        bytes: new Uint8Array(await file.arrayBuffer()),
      },
      writeContext(context.request, auth.principal),
    );
    return ok(outcome, outcome.stage === 'REJECTED' ? 422 : 200);
  } catch (error) {
    return serverError('data.imports.upload', error);
  }
};

function nullableField(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
