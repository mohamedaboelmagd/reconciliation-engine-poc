import { InjectionToken } from '@angular/core';
import type { AuditEntry, ImportResult, Invoice, Match, RunResult, Summary, Transaction } from './models';

/**
 * What the dashboard needs from "the server". Two implementations:
 * - HttpBackend: the real Fastify API (local / self-hosted)
 * - BrowserBackend: static demo, same matching engine running in the browser with localStorage
 */
export interface Backend {
  readonly mode: 'api' | 'browser';
  summary(): Promise<Summary>;
  matches(status?: string): Promise<Match[]>;
  transactions(status?: string): Promise<Transaction[]>;
  invoices(): Promise<Invoice[]>;
  audit(limit?: number): Promise<AuditEntry[]>;
  verifyAudit(): Promise<{ valid: boolean; entries: number; headHash?: string }>;
  run(): Promise<RunResult>;
  accept(id: string, note?: string): Promise<Match>;
  reject(id: string, note?: string): Promise<Match>;
  resetDemo(): Promise<unknown>;
  importCsv(csv: string, filename: string): Promise<ImportResult>;
  downloadReport(): Promise<void>;
}

export const BACKEND = new InjectionToken<Backend>('BACKEND');

export function saveFile(content: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(content);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
