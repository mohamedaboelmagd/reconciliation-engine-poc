import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DEMO_TENANTS, currentApiKey } from './api.service';
import { BACKEND } from './backend';
import { environment } from '../environments/environment';
import { AuditTrail } from './components/audit-trail';
import { MatchTable } from './components/match-table';
import { SummaryCards } from './components/summary-cards';
import { UnmatchedPanel } from './components/unmatched-panel';
import type { AuditEntry, Invoice, Match, Summary, Transaction } from './models';

type Tab = 'review' | 'matched' | 'unmatched' | 'audit';

@Component({
  selector: 'app-root',
  imports: [SummaryCards, MatchTable, UnmatchedPanel, AuditTrail],
  templateUrl: './app.html',
})
export class App implements OnInit {
  private api = inject(BACKEND);
  demo = environment.demo;
  repoUrl = environment.repoUrl;
  tenants = DEMO_TENANTS;
  apiKey = currentApiKey;
  tenant = computed(() => DEMO_TENANTS.find((t) => t.key === this.apiKey())!);

  tab = signal<Tab>('review');
  busy = signal(false);
  toast = signal<{ kind: 'ok' | 'err'; text: string } | null>(null);

  summary = signal<Summary | null>(null);
  matches = signal<Match[]>([]);
  unmatchedTx = signal<Transaction[]>([]);
  openInvoices = signal<Invoice[]>([]);
  audit = signal<AuditEntry[]>([]);
  verified = signal<{ valid: boolean; entries: number } | null>(null);

  suggestions = computed(() => this.matches().filter((m) => m.status === 'suggested'));
  confirmed = computed(() => this.matches().filter((m) => m.status !== 'suggested'));

  tabs = computed(() => [
    { id: 'review' as Tab, label: 'Review queue', count: this.suggestions().length },
    { id: 'matched' as Tab, label: 'Matched & decided', count: this.confirmed().length },
    { id: 'unmatched' as Tab, label: 'Unmatched', count: this.unmatchedTx().length + this.openInvoices().length },
    { id: 'audit' as Tab, label: 'Audit trail', count: this.verified()?.entries ?? 0 },
  ]);

  ngOnInit() { void this.refresh(); }

  async refresh() {
    const [summary, matches, tx, inv, audit, verified] = await Promise.all([
      this.api.summary(), this.api.matches(), this.api.transactions('unmatched'), this.api.invoices(), this.api.audit(), this.api.verifyAudit(),
    ]);
    this.summary.set(summary);
    this.matches.set(matches);
    this.unmatchedTx.set(tx);
    this.openInvoices.set(inv.filter((i) => i.openAmountMinor > 0));
    this.audit.set(audit);
    this.verified.set(verified);
  }

  private async act(fn: () => Promise<string>) {
    this.busy.set(true);
    try {
      const msg = await fn();
      await this.refresh();
      this.flash('ok', msg);
    } catch (e: any) {
      this.flash('err', e?.error?.message ?? e?.message ?? 'Request failed');
    } finally {
      this.busy.set(false);
    }
  }

  private flash(kind: 'ok' | 'err', text: string) {
    this.toast.set({ kind, text });
    setTimeout(() => this.toast.set(null), 4000);
  }

  switchTenant(key: string) {
    this.apiKey.set(key);
    void this.refresh();
  }

  run() {
    return this.act(async () => {
      const r = await this.api.run();
      return `Run complete: ${r.autoMatched} auto-matched, ${r.suggested} new suggestions, ${r.kept} unchanged, ${r.unmatchedTransactions} bank lines left.`;
    });
  }
  accept(m: Match) { return this.act(async () => (await this.api.accept(m.id, 'Accepted from dashboard'), `Accepted ${m.invoices.map((i) => i.number).join(', ')}`)); }
  reject(m: Match) { return this.act(async () => (await this.api.reject(m.id, 'Rejected from dashboard'), `Rejected. This pairing will not be suggested again.`)); }
  reset() { return this.act(async () => (await this.api.resetDemo(), 'Sample data reloaded. Run reconciliation to start.')); }
  exportCsv() { return this.act(async () => (await this.api.downloadReport(), 'Report downloaded')); }

  onFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void this.act(async () => {
      const r = await this.api.importCsv(await file.text(), file.name);
      input.value = '';
      return r.replayed
        ? `${file.name} was already imported (idempotent replay, nothing changed).`
        : `Imported ${file.name}: ${r.inserted} new lines, ${r.duplicates} duplicates skipped.`;
    });
  }
}
