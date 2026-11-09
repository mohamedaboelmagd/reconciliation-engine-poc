/** Text normalisation & similarity helpers (Arabic + Latin aware). Pure functions. */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

export function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => {
    const i = ARABIC_INDIC.indexOf(d);
    return String(i >= 0 ? i : PERSIAN.indexOf(d));
  });
}

/** Normalise a payment reference / invoice number: "inv-2026/0142" -> "INV20260142". */
export function normalizeRef(s: string): string {
  return toLatinDigits(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Candidate reference tokens inside free text (anything alphanumeric containing a digit, length >= 4). */
export function refTokens(text: string): string[] {
  const raw = toLatinDigits(text ?? '')
    .toUpperCase()
    .split(/[\s,;:|()]+/)
    .map((t) => t.replace(/[^A-Z0-9]/g, ''))
    .filter((t) => t.length >= 4 && /\d/.test(t));
  return [...new Set(raw)];
}

export function normalizeArabic(s: string): string {
  return s
    .replace(/[\u064B-\u065F\u0670]/g, '') // tashkeel
    .replace(/\u0640/g, '') // tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

const STOPWORDS = new Set([
  'co', 'company', 'comp', 'llc', 'ltd', 'limited', 'sae', 'se', 'inc', 'corp', 'group', 'the', 'and', 'for', 'of',
  'شركه', 'مؤسسه', 'موسسه', 'ش', 'م', 'ذ', 'و', 'لل',
]);

/** Lowercase, strip punctuation, Arabic normalisation, drop legal-form stopwords and the Arabic article. */
export function nameTokens(s: string): string[] {
  const cleaned = normalizeArabic(toLatinDigits(s ?? ''))
    .toLowerCase()
    .replace(/s\.a\.e\.?/g, 'sae')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return cleaned
    .split(/\s+/)
    .map((t) => (t.length > 4 && (t.startsWith('ال') || t.startsWith('لل')) ? t.slice(2) : t))
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 - normalised edit distance, 0..1 */
export function editSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const counts = new Map<string, number>();
  for (const g of A) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of B) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      hits++;
      counts.set(g, c - 1);
    }
  }
  return (2 * hits) / (A.length + B.length);
}

/**
 * Counterparty similarity 0..1.
 * max( bigram-dice on the joined tokens , fuzzy token overlap ) so that both
 * "Nile Foods" vs "NILE FOODS CO S.A.E" and "Elsewedy Electrik" vs "El Sewedy Electric" score high.
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  const joinedA = ta.join('');
  const joinedB = tb.join('');
  const dice = diceSimilarity(joinedA, joinedB);
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  let overlap = 0;
  for (const t of small) {
    const best = Math.max(...big.map((u) => editSimilarity(t, u)));
    if (best >= 0.75) overlap += best;
  }
  const tokenScore = overlap / Math.max(small.length, Math.ceil(big.length * 0.75));
  return Math.min(1, Math.max(dice, tokenScore));
}
