import { Component, computed, input } from '@angular/core';
import { formatMoney } from '../money.pipe';
import type { Bucket, Summary } from '../models';

@Component({
  selector: 'app-summary-cards',
  template: `
    @if (summary(); as s) {
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-5">
        @for (c of cards(); track c.label) {
          <div class="card p-4">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold uppercase tracking-wide text-slate-500">{{ c.label }}</span>
              <span class="h-2.5 w-2.5 rounded-full" [class]="c.dot"></span>
            </div>
            <div class="mt-2 text-3xl font-semibold text-slate-900">{{ c.count }}</div>
            <div class="mt-1 space-y-0.5 text-xs text-slate-500">
              @for (a of c.amounts; track a) { <div>{{ a }}</div> } @empty { <div>&nbsp;</div> }
            </div>
          </div>
        }
        <div class="card p-4">
          <span class="text-xs font-semibold uppercase tracking-wide text-slate-500">Bank lines reconciled</span>
          <div class="mt-2 text-3xl font-semibold text-slate-900">{{ s.autoMatchRate }}%</div>
          <div class="mt-2 h-2 rounded-full bg-slate-100">
            <div class="h-2 rounded-full bg-indigo-500" [style.width.%]="s.autoMatchRate"></div>
          </div>
          <div class="mt-1 text-xs text-slate-500">{{ s.totals.transactions }} lines · {{ s.totals.invoices }} invoices</div>
        </div>
      </div>
    }
  `,
})
export class SummaryCards {
  summary = input<Summary | null>(null);
  private fmt = (b: Bucket) => Object.entries(b.amountByCurrency).map(([c, v]) => formatMoney(v, c));
  cards = computed(() => {
    const s = this.summary();
    if (!s) return [];
    return [
      { label: 'Matched', count: s.matched.count, amounts: this.fmt(s.matched), dot: 'bg-emerald-500' },
      { label: 'Needs review', count: s.suggested.count, amounts: this.fmt(s.suggested), dot: 'bg-amber-500' },
      { label: 'Unmatched bank lines', count: s.unmatchedTransactions.count, amounts: this.fmt(s.unmatchedTransactions), dot: 'bg-rose-500' },
      { label: 'Open receivables', count: s.openInvoices.count, amounts: this.fmt(s.openInvoices), dot: 'bg-slate-400' },
    ];
  });
}
