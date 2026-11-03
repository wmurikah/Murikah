/** Human meaning for an import row whose storage status predates event rows. */
export const SO_ADDITIONAL_EVENT_MESSAGE =
  'A further event for an order line this file has already described.';

export interface ImportRowPresentation {
  readonly statusLabel: string;
  readonly recordLabel: string;
  readonly additionalEvent: boolean;
}

/**
 * A repeated (order, line) row can carry a new loading-authority or invoice
 * event. Keep the stored compatibility status while presenting that business
 * fact accurately, and distinguish a validated row from a rejected one before
 * either has been committed.
 */
export function importRowPresentation(input: {
  importType: string;
  rowStatus: string;
  errorMessage: string | null;
  entityId: string | null;
}): ImportRowPresentation {
  const additionalEvent =
    input.importType === 'SALES_ORDER' &&
    input.rowStatus === 'DUPLICATE' &&
    input.errorMessage === SO_ADDITIONAL_EVENT_MESSAGE;
  const awaitingCommit =
    input.entityId === null && ['NEW', 'CHANGED', 'DUPLICATE'].includes(input.rowStatus);

  return {
    statusLabel: additionalEvent ? 'additional event' : input.rowStatus.toLowerCase(),
    recordLabel:
      input.entityId !== null
        ? 'Linked to record'
        : awaitingCommit
          ? 'Awaiting commit'
          : 'Not imported',
    additionalEvent,
  };
}
