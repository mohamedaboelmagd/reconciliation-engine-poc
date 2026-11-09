import { Component, input } from '@angular/core';
import { DatePipe, SlicePipe } from '@angular/common';
import type { AuditEntry } from '../models';

@Component({
  selector: 'app-audit-trail',
  imports: [DatePipe, SlicePipe],
  template: `
    <div class="mb-3 flex items-center gap-2 text-sm">
      @if (verified(); as v) {
        <span class="pill" [class]="v.valid ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-rose-50 text-rose-700'">
          {{ v.valid ? 'Hash chain verified' : 'Hash chain BROKEN' }} · {{ v.entries }} entries
        </span>
        <span class="text-xs text-slate-400">Append-only log; each entry hashes the previous one (tamper evident).</span>
      }
    </div>
    <div class="card overflow-hidden">
      <table class="min-w-full divide-y divide-slate-100">
        <thead class="bg-slate-50"><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th><th>Hash</th></tr></thead>
        <tbody class="divide-y divide-slate-100">
          @for (e of entries(); track e.id) {
            <tr>
              <td class="tabular-nums text-xs text-slate-400">{{ e.seq }}</td>
              <td class="whitespace-nowrap text-xs text-slate-500">{{ e.createdAt | date: 'MMM d, HH:mm:ss' }}</td>
              <td class="text-xs">{{ e.actor }}</td>
              <td><span class="pill" [class]="color(e.action)">{{ e.action }}</span></td>
              <td class="font-mono text-[11px] text-slate-500">{{ e.entityType }}<br />{{ e.entityId }}</td>
              <td class="max-w-md text-xs text-slate-600" dir="auto">{{ describe(e) }}</td>
              <td class="font-mono text-[11px] text-slate-400">{{ e.hash | slice: 0 : 10 }}…</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class AuditTrail {
  entries = input.required<AuditEntry[]>();
  verified = input<{ valid: boolean; entries: number } | null>(null);
  color(a: string) {
    if (a.includes('accepted') || a.includes('auto_matched')) return 'bg-emerald-50 text-emerald-700';
    if (a.includes('rejected')) return 'bg-rose-50 text-rose-700';
    if (a.includes('run')) return 'bg-indigo-50 text-indigo-700';
    return 'bg-slate-100 text-slate-700';
  }
  describe(e: AuditEntry): string {
    const d = e.details ?? {};
    if (d.reason) return d.note ? `${d.reason} Note: ${d.note}` : d.reason;
    if (e.action === 'reconciliation.run') return `auto-matched ${d.autoMatched}, suggested ${d.suggested}, kept ${d.kept}, unmatched lines ${d.unmatchedTransactions} (${d.assistant})`;
    if (e.action === 'transactions.imported') return `${d.filename ?? 'upload'}: ${d.inserted} new, ${d.duplicates} duplicate rows`;
    if (d.number) return `${d.number}`;
    return JSON.stringify(d).slice(0, 140);
  }
}
