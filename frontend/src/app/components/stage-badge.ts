import { Component, computed, input } from '@angular/core';

const STYLES: Record<string, [string, string]> = {
  exact: ['Exact', 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'],
  fuzzy: ['Fuzzy', 'bg-sky-50 text-sky-700 ring-1 ring-sky-200'],
  partial: ['Partial', 'bg-violet-50 text-violet-700 ring-1 ring-violet-200'],
  split: ['Split', 'bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-200'],
  assist: ['AI assist', 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'],
};

@Component({
  selector: 'app-stage-badge',
  template: `<span class="pill" [class]="style()[1]">{{ style()[0] }}</span>`,
})
export class StageBadge {
  stage = input.required<string>();
  style = computed(() => STYLES[this.stage()] ?? [this.stage(), 'bg-slate-100 text-slate-700']);
}

@Component({
  selector: 'app-confidence',
  template: `
    <div class="flex items-center gap-2">
      <div class="h-1.5 w-16 rounded-full bg-slate-100">
        <div class="h-1.5 rounded-full" [class]="color()" [style.width.%]="value() * 100"></div>
      </div>
      <span class="tabular-nums text-xs text-slate-600">{{ (value() * 100).toFixed(0) }}%</span>
    </div>
  `,
})
export class Confidence {
  value = input.required<number>();
  color = computed(() => (this.value() >= 0.9 ? 'bg-emerald-500' : this.value() >= 0.7 ? 'bg-amber-500' : 'bg-rose-400'));
}
