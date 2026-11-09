import { Component, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MoneyPipe } from '../money.pipe';
import type { Match } from '../models';
import { Confidence, StageBadge } from './stage-badge';

@Component({
  selector: 'app-match-table',
  imports: [MoneyPipe, StageBadge, Confidence, DatePipe],
  template: `
    <div class="overflow-x-auto">
      <table class="min-w-full divide-y divide-slate-100">
        <thead class="bg-slate-50">
          <tr>
            <th>Bank line(s)</th>
            <th>Invoice(s)</th>
            <th class="text-right">Amount</th>
            <th>Stage</th>
            <th>Confidence</th>
            <th class="w-[34%]">Why</th>
            <th class="text-right">{{ reviewMode() ? 'Decision' : 'Status' }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          @for (m of matches(); track m.id) {
            <tr class="hover:bg-slate-50/60">
              <td>
                @for (t of m.transactions; track t.id) {
                  <div class="mb-1">
                    <div class="font-medium text-slate-900" dir="auto">{{ t.counterparty }}</div>
                    <div class="text-xs text-slate-500">{{ t.bookingDate }} · {{ t.bankAccount }} · {{ t.amountMinor | money: m.currency }}</div>
                    @if (t.reference) { <div class="font-mono text-xs text-slate-500" dir="auto">ref: {{ t.reference }}</div> }
                  </div>
                }
              </td>
              <td>
                @for (i of m.invoices; track i.id) {
                  <div class="mb-1">
                    <div class="font-mono text-xs font-semibold text-slate-800">{{ i.number }}</div>
                    <div class="text-xs text-slate-500" dir="auto">{{ i.customerName }} · {{ i.amountMinor | money: m.currency }}</div>
                  </div>
                }
              </td>
              <td class="text-right tabular-nums">
                <div class="font-medium whitespace-nowrap">{{ m.amountMinor | money: m.currency }}</div>
                @if (m.differenceMinor !== 0) {
                  <div class="whitespace-nowrap text-xs" [class]="m.differenceMinor < 0 ? 'text-amber-700' : 'text-sky-700'">
                    {{ m.differenceMinor < 0 ? 'fee/short ' : 'over ' }}{{ (m.differenceMinor < 0 ? -m.differenceMinor : m.differenceMinor) | money: m.currency }}
                  </div>
                }
              </td>
              <td><app-stage-badge [stage]="m.stage" /></td>
              <td><app-confidence [value]="m.confidence" /></td>
              <td class="text-xs leading-relaxed text-slate-600" dir="auto">{{ m.reason }}</td>
              <td class="text-right whitespace-nowrap">
                @if (reviewMode() && m.status === 'suggested') {
                  <div class="flex justify-end gap-1.5">
                    <button class="btn-accept" [disabled]="busy()" (click)="accept.emit(m)">Accept</button>
                    <button class="btn-reject" [disabled]="busy()" (click)="reject.emit(m)">Reject</button>
                  </div>
                } @else {
                  <span class="pill" [class]="m.status === 'matched' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'">
                    {{ m.decision === 'auto' ? 'auto-matched' : m.decision }}
                  </span>
                  @if (m.decidedBy && m.decision !== 'auto') { <div class="mt-1 text-[11px] text-slate-400">{{ m.decidedBy }}<br />{{ m.decidedAt | date: 'MMM d, HH:mm' }}</div> }
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="7" class="py-10 text-center text-sm text-slate-400">{{ emptyText() }}</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class MatchTable {
  matches = input.required<Match[]>();
  reviewMode = input(false);
  busy = input(false);
  emptyText = input('Nothing here.');
  accept = output<Match>();
  reject = output<Match>();
}
