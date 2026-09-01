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
  SOURCE_SYSTEM_FOR_IMPORT,
} from '../../../../../lib/cms/import/uploadCentre.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { throttle, PORTAL_THROTTLES } from '../../../../../lib/cms/portal/throttle.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireImportsView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    return ok({ batches: await listBatches(connection.db) });
  } catch (error) {
    return serverError('data.imports.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  // Ahead of the multipart read, because reading the body is the expensive
  // part and a limiter that runs after it has already paid the cost it
  // exists to avoid. The data-type guard cannot run first: it needs a field
  // out of the very form this is protecting.
  const limited = await throttle(
    context.request,
    PORTAL_THROTTLES.upload,
    context.locals.cms?.user.userId ?? 'anonymous',
  );
  if (limited) return limited;

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
  // TWO THINGS THE FORM STILL DOES NOT ASK FOR, BECAUSE THE FILE ANSWERS THEM.
  //
  // The source system follows from the data type: both extracts are Oracle
  // EBS reports, and the form's old default of CRM Web Form was wrong for
  // every upload it was applied to.
  //
  // The period is derived from the rows, in the importer, from the column each
  // extract dates its documents by; the filename's dates only cross-check it.
  //
  // The ENTITY is resolved in order of authority: the file's own AFFILIATE
  // column, then the filename token against affiliates.extract_code, then —
  // and only then — the operator. The optional affiliateId field below is
  // that third source: the fallback where nothing resolved, or a deliberate
  // override of what did. overrideBatchId re-reads a previewed batch with the
  // chosen entity; the importer proves the bytes match that batch first.
  const sourceSystemId = SOURCE_SYSTEM_FOR_IMPORT[importType as ImportType];
  const chosenAffiliate = String(form.get('affiliateId') ?? '').trim();
  const overrideBatch = String(form.get('overrideBatchId') ?? '').trim();
  if (overrideBatch !== '' && !/^IMP-[A-Za-z0-9-]+$/.test(overrideBatch)) {
    return invalid([{ field: 'overrideBatchId', message: 'That is not a batch id.' }]);
  }

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const outcome = await receiveUpload(
      connection.db,
      {
        importType: importType as ImportType,
        sourceSystemId,
        affiliateId: chosenAffiliate === '' ? null : chosenAffiliate,
        filename: file.name,
        reportingPeriodFrom: null,
        reportingPeriodTo: null,
        bytes: new Uint8Array(await file.arrayBuffer()),
        overrideBatchId: overrideBatch === '' ? null : overrideBatch,
      },
      writeContext(context.request, auth.principal),
    );
    return ok(outcome, outcome.stage === 'REJECTED' ? 422 : 200);
  } catch (error) {
    return serverError('data.imports.upload', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
