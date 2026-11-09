import { Component, input } from '@angular/core';
import { MoneyPipe } from '../money.pipe';
import type { Invoice, Transaction } from '../models';

@Component({
  selector: 'app-unmatched-panel',
  imports: [MoneyPipe],
  template: `
    <div class="grid gap-6 lg:grid-cols-2">
      <section>
        <h3 class="mb-2 text-sm font-semibold text-slate-700">Bank lines with no match <span class="text-slate-400">({{ transactions().length }})</span></h3>
        <div class="card overflow-hidden">
          <table class="min-w-full divide-y divide-slate-100">
            <thead class="bg-slate-50"><tr><th>Date</th><th>Counterparty / reference</th><th class="text-right">Amount</th></tr></thead>
            <tbody class="divide-y divide-slate-100">
              @for (t of transactions(); track t.id) {
                <tr>
                  <td class="whitespace-nowrap text-xs text-slate-500">{{ t.bookingDate }}<br />{{ t.bankAccount }}</td>
                  <td><div class="font-medium" dir="auto">{{ t.counterparty }}</div><div class="text-xs text-slate-500" dir="auto">{{ t.reference }} {{ t.description }}</div></td>
                  <td class="whitespace-nowrap text-right tabular-nums">{{ t.amountMinor | money: t.currency }}</td>
                </tr>
              } @empty { <tr><td colspan="3" class="py-8 text-center text-slate-400">All bank lines are matched.</td></tr> }
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3 class="mb-2 text-sm font-semibold text-slate-700">Open receivables <span class="text-slate-400">({{ invoices().length }})</span></h3>
        <div class="card overflow-hidden">
          <table class="min-w-full divide-y divide-slate-100">
            <thead class="bg-slate-50"><tr><th>Invoice</th><th>Customer</th><th>Due</th><th class="text-right">Open</th></tr></thead>
            <tbody class="divide-y divide-slate-100">
              @for (i of invoices(); track i.id) {
                <tr>
                  <td class="font-mono text-xs font-semibold">{{ i.number }}
                    @if (i.status === 'partially_paid') { <span class="pill ml-1 bg-violet-50 text-violet-700">partial</span> }
                  </td>
                  <td dir="auto">{{ i.customerName }}</td>
                  <td class="whitespace-nowrap text-xs text-slate-500">{{ i.dueDate }}</td>
                  <td class="whitespace-nowrap text-right tabular-nums">{{ i.openAmountMinor | money: i.currency }}</td>
                </tr>
              } @empty { <tr><td colspan="4" class="py-8 text-center text-slate-400">No open invoices.</td></tr> }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
})
export class UnmatchedPanel {
  transactions = input.required<Transaction[]>();
  invoices = input.required<Invoice[]>();
}
