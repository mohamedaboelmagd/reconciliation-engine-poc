import { HttpClient, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { saveFile, type Backend } from './backend';
import type { AuditEntry, ImportResult, Invoice, Match, RunResult, Summary, Transaction } from './models';

/** Sample tenants shipped with the PoC (fictional). In production the key/token comes from login, never the bundle. */
export const DEMO_TENANTS = [
  { key: 'demo_nilefoods_key', id: 'ten_nilefoods', name: 'Nile Foods Distribution', kind: 'FMCG distributor' },
  { key: 'demo_lotustextiles_key', id: 'ten_lotustextiles', name: 'Lotus Textiles Export', kind: 'Textile exporter' },
];

export const currentApiKey = signal(DEMO_TENANTS[0].key);
export const REVIEWER = 'Mohamed (reviewer)';

export const apiKeyInterceptor: HttpInterceptorFn = (req, next) =>
  req.url.startsWith('/api/') ? next(req.clone({ setHeaders: { 'x-api-key': currentApiKey(), 'x-actor': REVIEWER } })) : next(req);

/** Real backend: the documented Fastify REST API. */
@Injectable({ providedIn: 'root' })
export class HttpBackend implements Backend {
  readonly mode = 'api' as const;
  private http = inject(HttpClient);
  private base = '/api/v1';

  summary() { return firstValueFrom(this.http.get<Summary>(`${this.base}/summary`)); }
  matches(status?: string) { return firstValueFrom(this.http.get<Match[]>(`${this.base}/matches`, { params: status ? { status } : {} })); }
  transactions(status?: string) { return firstValueFrom(this.http.get<Transaction[]>(`${this.base}/transactions`, { params: status ? { status } : {} })); }
  invoices() { return firstValueFrom(this.http.get<Invoice[]>(`${this.base}/invoices`)); }
  audit(limit = 200) { return firstValueFrom(this.http.get<AuditEntry[]>(`${this.base}/audit-log`, { params: { limit } })); }
  verifyAudit() { return firstValueFrom(this.http.get<{ valid: boolean; entries: number; headHash?: string }>(`${this.base}/audit-log/verify`)); }
  run() { return firstValueFrom(this.http.post<RunResult>(`${this.base}/reconciliation/runs`, {})); }
  accept(id: string, note?: string) { return firstValueFrom(this.http.post<Match>(`${this.base}/matches/${id}/accept`, { note })); }
  reject(id: string, note?: string) { return firstValueFrom(this.http.post<Match>(`${this.base}/matches/${id}/reject`, { note })); }
  resetDemo() { return firstValueFrom(this.http.post(`${this.base}/demo/reset`, {})); }
  importCsv(csv: string, filename: string) {
    return firstValueFrom(this.http.post<ImportResult>(`${this.base}/transactions/import`, csv, { headers: { 'content-type': 'text/csv' }, params: { filename } }));
  }
  async downloadReport() {
    const blob = await firstValueFrom(this.http.get(`${this.base}/reports/reconciliation.csv`, { responseType: 'blob' }));
    saveFile(blob, `reconciliation-${new Date().toISOString().slice(0, 10)}.csv`);
  }
}
