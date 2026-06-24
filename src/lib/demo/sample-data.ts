/**
 * Typed accessors for the shared demo sample data. The JSON file is the single
 * source of truth, used by the read-only Audit OS endpoints, the CRM and
 * extraction demos, and the Node seed script (db/seed.ts reads the same JSON).
 * Everything here is fictional and clearly marked "Sample".
 */
import raw from './sample-data.json';

export type Risk = 'High' | 'Medium' | 'Low';
export type FindingStatus = 'Open' | 'In progress' | 'Overdue' | 'Closed';
export type CrmStage = 'Lead' | 'Qualified' | 'Proposal' | 'Won' | 'Lost';

export interface Metric {
  key: string;
  label: string;
  value: string;
  tone: 'neutral' | 'high' | 'med' | 'low';
}

export interface Finding {
  ref: string;
  title: string;
  area: string;
  risk: Risk;
  status: FindingStatus;
  owner: string;
  dueDate: string;
  summary: string;
  actionPlan: string;
}

export interface Workpaper {
  findingRef: string;
  title: string;
  body: string;
}

export interface BoardItem {
  title: string;
  status: string;
  note: string;
}

export interface CrmContact {
  id: string;
  name: string;
  company: string;
  stage: CrmStage;
  value: number;
}

export interface InvoiceLineItem {
  description: string;
  qty: number;
  unitPrice: number;
  amount: number;
}

export interface Invoice {
  id: string;
  filename: string;
  supplier: string;
  number: string;
  date: string;
  currency: string;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  tax: number;
  total: number;
}

interface SampleData {
  metrics: Metric[];
  findings: Finding[];
  workpapers: Workpaper[];
  boardItems: BoardItem[];
  crmContacts: CrmContact[];
  invoices: Invoice[];
}

const data = raw as unknown as SampleData;

export const metrics: Metric[] = data.metrics;
export const findings: Finding[] = data.findings;
export const workpapers: Workpaper[] = data.workpapers;
export const boardItems: BoardItem[] = data.boardItems;
export const crmContacts: CrmContact[] = data.crmContacts;
export const invoices: Invoice[] = data.invoices;

export function findingByRef(ref: string): Finding | undefined {
  return findings.find((f) => f.ref === ref);
}

export function workpaperFor(ref: string): Workpaper | undefined {
  return workpapers.find((w) => w.findingRef === ref);
}

export function invoiceById(id: string): Invoice | undefined {
  return invoices.find((i) => i.id === id);
}
