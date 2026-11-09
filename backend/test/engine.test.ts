import { describe, expect, it } from 'vitest';
import {
  MockAssistant,
  nameSimilarity,
  normalizeRef,
  reconcile,
  referenceScore,
  runDeterministicStages,
  translateName,
  type EngineInvoice,
  type EngineTransaction,
  type MatchAssistant,
} from '../src/engine/index.js';

const inv = (p: Partial<EngineInvoice> & { id: string; number: string; amountMinor: number }): EngineInvoice => ({
  customerName: 'Nile Foods Co. S.A.E',
  currency: 'EGP',
  issueDate: '2026-10-01',
  dueDate: '2026-10-31',
  openAmountMinor: p.amountMinor,
  ...p,
});
const tx = (p: Partial<EngineTransaction> & { id: string; amountMinor: number }): EngineTransaction => ({
  bookingDate: '2026-10-20',
  currency: 'EGP',
  counterparty: 'NILE FOODS CO',
  reference: '',
  description: '',
  ...p,
});

describe('text helpers', () => {
  it('normalises references incl. Arabic-Indic digits', () => {
    expect(normalizeRef('inv-2026/0142')).toBe('INV20260142');
    expect(normalizeRef('INV-٢٠٢٦-٠١٤٢')).toBe('INV20260142');
  });
  it('scores English legal-form variants as the same company', () => {
    expect(nameSimilarity('NILE FOODS CO', 'Nile Foods Co. S.A.E')).toBeGreaterThan(0.9);
    expect(nameSimilarity('El Sewedy Electrik', 'Elsewedy Electric')).toBeGreaterThan(0.75);
    expect(nameSimilarity('Delta Pharma', 'Nile Foods Co.')).toBeLessThan(0.4);
  });
  it('normalises Arabic spelling variants', () => {
    expect(nameSimilarity('شركة الأهرام للتجارة', 'شركه الاهرام للتجاره')).toBe(1);
  });
  it('detects typo references', () => {
    const r = referenceScore(tx({ id: 't', amountMinor: 1, reference: 'PMT INV-2026-0124' }), 'INV-2026-0142');
    expect(r.score).toBeGreaterThanOrEqual(0.8);
    expect(referenceScore(tx({ id: 't', amountMinor: 1, reference: 'salary oct' }), 'INV-2026-0142').score).toBe(0);
  });
  it('translates Arabic counterparties for the mock assistant', () => {
    expect(translateName('شركة النيل للأغذية')).toBe('nile foods');
  });
});

describe('stage 1: exact', () => {
  it('matches reference + exact amount with confidence 1', () => {
    const { proposals } = runDeterministicStages(
      [inv({ id: 'i1', number: 'INV-2026-0101', amountMinor: 1_250_000 })],
      [tx({ id: 't1', amountMinor: 1_250_000, reference: 'Payment INV-2026-0101' })],
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ stage: 'exact', status: 'matched', confidence: 1, differenceMinor: 0 });
    expect(proposals[0].reason).toContain('INV-2026-0101');
  });
  it('matches one transfer quoting two invoice numbers whose sum is exact', () => {
    const { proposals } = runDeterministicStages(
      [inv({ id: 'i1', number: 'INV-1001', amountMinor: 100_000 }), inv({ id: 'i2', number: 'INV-1002', amountMinor: 50_000 })],
      [tx({ id: 't1', amountMinor: 150_000, reference: 'INV-1001 / INV-1002' })],
    );
    expect(proposals[0]).toMatchObject({ stage: 'exact', status: 'matched', invoiceIds: ['i1', 'i2'] });
  });
  it('does not match a different currency', () => {
    const r = runDeterministicStages(
      [inv({ id: 'i1', number: 'INV-1001', amountMinor: 100_000, currency: 'USD' })],
      [tx({ id: 't1', amountMinor: 100_000, reference: 'INV-1001', counterparty: 'Someone Else' })],
    );
    expect(r.proposals).toHaveLength(0);
  });
});

describe('stage 2: fuzzy', () => {
  it('auto-matches a typo reference with exact amount and same customer', () => {
    const { proposals } = runDeterministicStages(
      [inv({ id: 'i1', number: 'INV-2026-0142', amountMinor: 4_800_000 })],
      [tx({ id: 't1', amountMinor: 4_800_000, reference: 'INV-2026-0124' })],
    );
    expect(proposals[0]).toMatchObject({ stage: 'fuzzy', status: 'matched' });
    expect(proposals[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(proposals[0].reason).toMatch(/likely typo/);
  });
  it('suggests (not auto-matches) a fee-deducted payment without reference', () => {
    const { proposals } = runDeterministicStages(
      [inv({ id: 'i1', number: 'INV-2026-0150', amountMinor: 2_000_000 })],
      [tx({ id: 't1', amountMinor: 1_997_500 })], // 25 EGP transfer fee deducted
    );
    expect(proposals[0]).toMatchObject({ stage: 'fuzzy', status: 'suggested', differenceMinor: -2_500 });
    expect(proposals[0].reason).toMatch(/fee/);
  });
  it('rejects amounts outside tolerance and payments outside the date window', () => {
    const r1 = runDeterministicStages([inv({ id: 'i1', number: 'X-1', amountMinor: 2_000_000 })], [tx({ id: 't1', amountMinor: 1_900_000 })]);
    expect(r1.proposals.filter((p) => p.stage === 'fuzzy')).toHaveLength(0);
    const r2 = runDeterministicStages([inv({ id: 'i1', number: 'X-1', amountMinor: 2_000_000 })], [tx({ id: 't1', amountMinor: 2_000_000, bookingDate: '2027-03-01' })]);
    expect(r2.proposals).toHaveLength(0);
  });
  it('flags ambiguity when two invoices are equally plausible', () => {
    const { proposals } = runDeterministicStages(
      [inv({ id: 'i1', number: 'A-1', amountMinor: 500_000 }), inv({ id: 'i2', number: 'A-2', amountMinor: 500_000 })],
      [tx({ id: 't1', amountMinor: 500_000 })],
    );
    expect(proposals[0].status).toBe('suggested');
    expect(proposals[0].reason).toMatch(/ambiguous/);
  });
  it('never re-proposes a pair a human rejected', () => {
    const r = runDeterministicStages(
      [inv({ id: 'i1', number: 'INV-1', amountMinor: 500_000 })],
      [tx({ id: 't1', amountMinor: 500_000, reference: 'INV-1' })],
      { rejectedPairs: new Set(['t1|i1']) },
    );
    expect(r.proposals).toHaveLength(0);
  });
});

describe('stage 3: partial and split', () => {
  it('suggests a partial payment with remaining balance', () => {
    const { proposals, open } = runDeterministicStages(
      [inv({ id: 'i1', number: 'INV-2026-0200', amountMinor: 10_000_000 })],
      [tx({ id: 't1', amountMinor: 4_000_000, reference: 'دفعة أولى INV-2026-0200' })],
    );
    expect(proposals[0]).toMatchObject({ stage: 'partial', status: 'suggested' });
    expect(proposals[0].allocations[0].amountMinor).toBe(4_000_000);
    expect(open.get('i1')).toBe(6_000_000);
    expect(proposals[0].reason).toMatch(/remain outstanding/);
  });
  it('splits one transfer across several invoices of the same customer (subset sum)', () => {
    const { proposals } = runDeterministicStages(
      [
        inv({ id: 'i1', number: 'S-1', amountMinor: 300_000 }),
        inv({ id: 'i2', number: 'S-2', amountMinor: 450_000 }),
        inv({ id: 'i3', number: 'S-3', amountMinor: 999_900 }),
      ],
      [tx({ id: 't1', amountMinor: 750_000, reference: 'october invoices' })],
    );
    expect(proposals[0]).toMatchObject({ stage: 'split', status: 'suggested' });
    expect(proposals[0].invoiceIds.sort()).toEqual(['i1', 'i2']);
  });
  it('combines several transfers into one invoice (instalments)', () => {
    const { proposals } = runDeterministicStages(
      [inv({ id: 'i1', number: 'R-77', amountMinor: 900_000, customerName: 'Lotus Textiles' })],
      [
        tx({ id: 't1', amountMinor: 300_000, counterparty: 'LOTUS TEXTILES', bookingDate: '2026-10-05' }),
        tx({ id: 't2', amountMinor: 600_000, counterparty: 'Lotus Textiles Co', bookingDate: '2026-10-25' }),
      ],
    );
    expect(proposals[0]).toMatchObject({ stage: 'split', transactionIds: ['t1', 't2'] });
    expect(proposals[0].allocations.reduce((s, a) => s + a.amountMinor, 0)).toBe(900_000);
  });
});

describe('stage 4: assist + pipeline', () => {
  it('mock assistant matches Arabic counterparty to English customer, only as suggestion', async () => {
    const res = await reconcile(
      [inv({ id: 'i1', number: 'INV-9', amountMinor: 750_000 })],
      [tx({ id: 't1', amountMinor: 750_000, counterparty: 'شركة النيل للأغذية', reference: 'تحويل' })],
      {},
      new MockAssistant(),
    );
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]).toMatchObject({ stage: 'assist', status: 'suggested' });
    expect(res.proposals[0].confidence).toBeLessThanOrEqual(0.8);
  });
  it('guards against an assistant inventing ids or claiming auto-match', async () => {
    const rogue: MatchAssistant = {
      name: 'rogue',
      async suggest() {
        return [
          { stage: 'assist', status: 'matched', confidence: 1, reason: 'x', invoiceIds: ['nope'], transactionIds: ['t1'], allocations: [], differenceMinor: 0, currency: 'EGP' },
          { stage: 'assist', status: 'matched', confidence: 1, reason: 'y', invoiceIds: ['i1'], transactionIds: ['t1'], allocations: [{ invoiceId: 'i1', transactionId: 't1', amountMinor: 10 }], differenceMinor: 0, currency: 'EGP' },
        ];
      },
    };
    const res = await reconcile([inv({ id: 'i1', number: 'Q', amountMinor: 999, customerName: 'Zed' })], [tx({ id: 't1', amountMinor: 5 })], {}, rogue);
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]).toMatchObject({ status: 'suggested', invoiceIds: ['i1'] });
    expect(res.proposals[0].confidence).toBe(0.8);
  });
  it('is deterministic regardless of input order and reports leftovers', async () => {
    const invoices = [
      inv({ id: 'i1', number: 'INV-1', amountMinor: 100_000 }),
      inv({ id: 'i2', number: 'INV-2', amountMinor: 200_000, customerName: 'Cairo Logistics' }),
      inv({ id: 'i3', number: 'INV-3', amountMinor: 333_300, customerName: 'Unpaid Ltd' }),
    ];
    const txs = [
      tx({ id: 't1', amountMinor: 100_000, reference: 'INV-1' }),
      tx({ id: 't2', amountMinor: 199_000, counterparty: 'CAIRO LOGISTICS' }),
      tx({ id: 't3', amountMinor: 12_345, counterparty: 'Random Person' }),
    ];
    const a = await reconcile(invoices, txs);
    const b = await reconcile([...invoices].reverse(), [...txs].reverse());
    expect(b).toEqual(a);
    expect(a.unmatchedTransactionIds).toEqual(['t3']);
    expect(a.unmatchedInvoiceIds).toEqual(['i3']);
  });
});

describe('partial then final instalment', () => {
  it('links both instalments that quote the same invoice', () => {
    const { proposals, open } = runDeterministicStages(
      [inv({ id: 'i1', number: 'INV-2026-0105', amountMinor: 21_000_000 })],
      [
        tx({ id: 't1', amountMinor: 10_000_000, reference: 'دفعة أولى INV-2026-0105', bookingDate: '2026-10-10' }),
        tx({ id: 't2', amountMinor: 11_000_000, reference: 'INV-2026-0105 final', bookingDate: '2026-10-28' }),
      ],
    );
    expect(proposals.map((p) => p.stage)).toEqual(['partial', 'partial']);
    expect(proposals[1].reason).toMatch(/Final instalment/);
    expect(open.get('i1')).toBe(0);
  });
});
