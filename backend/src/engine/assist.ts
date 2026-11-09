/**
 * Stage 4 assistants. Selected with MATCH_ASSISTANT=mock|openai|none (default mock).
 *
 * - MockAssistant: deterministic, offline. Simulates what an LLM adds on the long tail:
 *   cross-script matching (Arabic counterparty vs English customer master data) using a
 *   small glossary + transliteration. No keys, no network, stable output for tests and demos.
 * - OpenAICompatibleAssistant: any OpenAI-compatible /chat/completions endpoint
 *   (OpenAI, Azure OpenAI, a local vLLM/Ollama gateway). Only leftover rows are sent,
 *   and only the fields needed; output is JSON-validated and re-checked by the engine.
 */
import { formatMinor, toleranceFor } from './money.js';
import { nameSimilarity, nameTokens, normalizeArabic } from './text.js';
import type { EngineInvoice, EngineOptions, EngineTransaction, MatchAssistant, MatchProposal } from './types.js';

const GLOSSARY: Record<string, string> = {
  نيل: 'nile', مصر: 'misr', مصريه: 'egyptian', دلتا: 'delta', قاهره: 'cairo', اسكندريه: 'alexandria',
  اغذيه: 'foods', تجاره: 'trading', مقاولات: 'contracting', عقاريه: 'real estate', تطوير: 'development',
  صناعات: 'industries', هندسيه: 'engineering', خدمات: 'services', لوجستيه: 'logistics', صيدليات: 'pharmacies',
  دواء: 'pharma', ادويه: 'pharma', اهرام: 'pyramids', شمس: 'shams', عين: 'ain', نور: 'nour', سلام: 'salam',
  مخبوزات: 'bakeries', الكترونيات: 'electronics', سويدي: 'sewedy', منصور: 'mansour', سيارات: 'motors',
  حلول: 'solutions', تقنيه: 'tech', برمجيات: 'software', زراعيه: 'agro', منتجات: 'products', ملابس: 'garments', فنادق: 'hotels', منتجعات: 'resorts',
  اتحاد: 'union', عالميه: 'international', دوليه: 'international', جديده: 'new', عاصمه: 'capital', اداريه: 'administrative',
};

const TRANSLIT: Record<string, string> = {
  ا: 'a', ب: 'b', ت: 't', ث: 'th', ج: 'g', ح: 'h', خ: 'kh', د: 'd', ذ: 'z', ر: 'r', ز: 'z', س: 's', ش: 'sh',
  ص: 's', ض: 'd', ط: 't', ظ: 'z', ع: 'a', غ: 'gh', ف: 'f', ق: 'k', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h',
  و: 'o', ي: 'y', ء: '',
};

/** Arabic name -> rough English rendering ("شركة النيل للأغذية" -> "nile foods"). */
export function translateName(s: string): string {
  if (!/[\u0600-\u06FF]/.test(s)) return s;
  return nameTokens(normalizeArabic(s))
    .map((t) => GLOSSARY[t] ?? [...t].map((c) => TRANSLIT[c] ?? c).join(''))
    .join(' ');
}

export class MockAssistant implements MatchAssistant {
  readonly name = 'AI assist (mock)';

  async suggest(txs: EngineTransaction[], invoices: EngineInvoice[], opts: EngineOptions): Promise<MatchProposal[]> {
    const out: MatchProposal[] = [];
    const usedInv = new Set<string>();
    for (const tx of txs) {
      const translated = translateName(tx.counterparty);
      if (translated === tx.counterparty) continue; // only adds value on cross-script cases
      let best: { inv: EngineInvoice; sim: number; diff: number } | null = null;
      for (const inv of invoices) {
        if (inv.currency !== tx.currency || usedInv.has(inv.id)) continue;
        const tol = toleranceFor(inv.openAmountMinor, opts.amountTolerancePct * 3, opts.amountToleranceAbsMinor);
        const diff = tx.amountMinor - inv.openAmountMinor;
        if (Math.abs(diff) > tol) continue;
        const sim = nameSimilarity(translated, inv.customerName);
        if (sim >= 0.6 && (!best || sim > best.sim)) best = { inv, sim, diff };
      }
      if (!best) continue;
      usedInv.add(best.inv.id);
      out.push({
        stage: 'assist',
        status: 'suggested',
        confidence: Math.min(0.8, 0.45 + 0.35 * best.sim),
        reason:
          `Counterparty '${tx.counterparty}' read as '${translated}', which matches customer '${best.inv.customerName}' ` +
          `(${Math.round(best.sim * 100)}%); amount ${formatMinor(tx.amountMinor, tx.currency)} vs ${formatMinor(best.inv.openAmountMinor, best.inv.currency)}.`,
        invoiceIds: [best.inv.id],
        transactionIds: [tx.id],
        allocations: [{ invoiceId: best.inv.id, transactionId: tx.id, amountMinor: best.inv.openAmountMinor }],
        differenceMinor: best.diff,
        currency: tx.currency,
      });
    }
    return out;
  }
}

interface LlmPick {
  transactionId: string;
  invoiceIds: string[];
  confidence: number;
  reason: string;
}

export class OpenAICompatibleAssistant implements MatchAssistant {
  readonly name: string;
  constructor(
    private readonly cfg: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number },
  ) {
    this.name = `AI assist (${cfg.model})`;
  }

  async suggest(txs: EngineTransaction[], invoices: EngineInvoice[]): Promise<MatchProposal[]> {
    const payload = {
      transactions: txs.slice(0, 50).map((t) => ({ id: t.id, date: t.bookingDate, amountMinor: t.amountMinor, currency: t.currency, counterparty: t.counterparty, reference: t.reference, description: t.description })),
      openInvoices: invoices.slice(0, 200).map((i) => ({ id: i.id, number: i.number, customer: i.customerName, openAmountMinor: i.openAmountMinor, currency: i.currency, dueDate: i.dueDate })),
    };
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You help an accounts-receivable team reconcile bank credits to open invoices (Egypt/MENA; names may be Arabic or English). ' +
              'Only propose a link when evidence is strong (same currency, compatible amount, same customer). ' +
              'Return JSON {"matches":[{"transactionId","invoiceIds":[...],"confidence":0..1,"reason":"one sentence"}]}. Never invent ids.',
          },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`assistant HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    let picks: LlmPick[] = [];
    try {
      picks = (JSON.parse(body.choices?.[0]?.message?.content ?? '{}').matches ?? []) as LlmPick[];
    } catch {
      return [];
    }
    const out: MatchProposal[] = [];
    for (const p of picks) {
      const tx = txs.find((t) => t.id === p.transactionId);
      const invs = (p.invoiceIds ?? []).map((id) => invoices.find((i) => i.id === id)).filter(Boolean) as EngineInvoice[];
      if (!tx || !invs.length || invs.length !== p.invoiceIds.length || invs.some((i) => i.currency !== tx.currency)) continue;
      let remaining = tx.amountMinor;
      const allocations = invs.map((inv) => {
        const amt = Math.min(inv.openAmountMinor, remaining);
        remaining -= amt;
        return { invoiceId: inv.id, transactionId: tx.id, amountMinor: amt };
      }).filter((a) => a.amountMinor > 0);
      out.push({
        stage: 'assist', status: 'suggested', confidence: Number(p.confidence) || 0.5, reason: String(p.reason ?? '').slice(0, 300),
        invoiceIds: invs.map((i) => i.id), transactionIds: [tx.id], allocations,
        differenceMinor: tx.amountMinor - invs.reduce((s, i) => s + i.openAmountMinor, 0), currency: tx.currency,
      });
    }
    return out;
  }
}

/** Environment-neutral (works in Node and in the browser demo build). Pass process.env on the server. */
export function assistantFromEnv(env: Record<string, string | undefined>): MatchAssistant | undefined {
  const kind = (env['MATCH_ASSISTANT'] ?? 'mock').toLowerCase();
  if (kind === 'none') return undefined;
  if (kind === 'openai') {
    if (!env['LLM_API_KEY']) throw new Error('MATCH_ASSISTANT=openai requires LLM_API_KEY');
    return new OpenAICompatibleAssistant({
      baseUrl: env['LLM_BASE_URL'] ?? 'https://api.openai.com/v1',
      apiKey: env['LLM_API_KEY'],
      model: env['LLM_MODEL'] ?? 'gpt-4o-mini',
    });
  }
  return new MockAssistant();
}
