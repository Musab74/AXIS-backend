import type { KoreanIdCardData, KoreanIdType } from './clova-ocr.service';

/**
 * Parses raw CLOVA OCR fields into a Korean-ID-shaped record.
 *
 * Two real-world ID types must work in addition to the Korean Resident Card:
 *  - **Foreign Resident Card (외국인등록증)** — name is in Latin (ALL CAPS),
 *    RRN back-digit is 5/6/7/8.
 *  - **Driver's License / Passport** — falls through keyword detection.
 *
 * Priority order is important:
 *   1. RRN is the authoritative source for both birthDate and idType.
 *   2. Birthdate from OCR text is a fallback only when no RRN is present.
 *   3. Name extraction is script-aware and skips card-label words.
 */

interface ClovaField {
  name?: string;
  inferText: string;
  inferConfidence: number;
  valueType?: string;
}

const KOREAN_LABELS = new Set([
  '성명', '이름', '주민등록증', '주민등록번호', '외국인등록증',
  '외국인등록번호', '운전면허증', '운전면허', '면허번호', '국적',
  '발급일', '발급청', '등록', '자격', '한국어', '비고', '만료일',
  '주소', '본관', '대한민국', '주민등록', '발급', '등록일',
  '체류기간', '체류자격', '재발급일', '갱신일', '면허종별', '여권',
  '여권번호', '국가', '정부', '번호', '구분', '기간', '만료', '성별',
  '주소지', '본적', '한국어시험', '일반', '거주', '지역',
]);

const LATIN_LABELS = new Set([
  'NAME', 'FAMILY', 'SURNAME', 'GIVEN', 'FIRST', 'LAST',
  'FOREIGN', 'RESIDENT', 'CARD', 'ALIEN', 'REGISTRATION',
  'REPUBLIC', 'OF', 'KOREA', 'KOR', 'COUNTRY', 'NATIONALITY',
  'ISSUE', 'EXPIRY', 'EXPIRES', 'DATE', 'BIRTH',
  'NUMBER', 'NO', 'SEX', 'MALE', 'FEMALE', 'GENDER',
  'MASTER', 'OFFICE', 'IMMIGRATION', 'PASSPORT', 'TYPE',
  'AUTHORITY', 'SIGNATURE', 'STATUS', 'PERIOD', 'STAY',
  'FRN', 'RRN', 'KR', 'JUMIN', 'ID', 'CODE',
]);

const RRN_RE = /(\d{6})\s?-?\s?(\d)(\d{6})?/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ANY_DATE_RE = /(\d{4})[.\-/년 ]+(\d{1,2})[.\-/월 ]+(\d{1,2})/;
const ANY_DATE_RE_G = new RegExp(ANY_DATE_RE.source, 'g');
const KOREAN_NAME_RE = /^[가-힣]{2,5}$/;
const LATIN_TOKEN_RE = /^[A-Za-z][A-Za-z'-]+$/;

type ParsedCard = Omit<KoreanIdCardData, 'rrnMasked'>;

export function parseIdFields(fields: ClovaField[]): ParsedCard {
  const named = new Map<string, ClovaField>();
  for (const f of fields) if (f.name) named.set(f.name.toLowerCase(), f);
  const tokens = fields.map((f) => (f.inferText ?? '').trim()).filter(Boolean);
  const allText = tokens.join('\n');
  const avgConfidence =
    fields.length > 0
      ? fields.reduce((s, f) => s + (f.inferConfidence ?? 0), 0) / fields.length
      : 0;

  // 1) RRN — authoritative source for both birthDate and idType.
  const rrnText = pickRrnText(named, allText);
  const { rrnFront, rrnBackFirstDigit } = splitRrn(rrnText);

  // 2) BirthDate — derive from RRN first; fall back to OCR-extracted date.
  const birthFromRrn = deriveBirthDateFromRrn(rrnFront, rrnBackFirstDigit);
  const birthFromOcr = pickBirthDateFromText(named, tokens);
  const birthDate = birthFromRrn ?? birthFromOcr;

  // 3) Other named fields.
  const issueDate = normaliseDate(
    firstByKeys(named, ['issuedate', 'issue', '발급일']) ?? findIssueDateFallback(tokens),
  );
  const issuingAuthority = firstByKeys(named, ['issuer', 'authority', '발급청']);
  const licenseNumber = firstByKeys(named, ['licensenumber', 'license', '면허번호']);
  const passportNumber = firstByKeys(named, ['passportnumber', 'passport', '여권번호']);

  // 4) ID type — combines keyword evidence with RRN signal.
  const idType = guessIdType({
    allText,
    named,
    rrnBackFirstDigit,
    licenseNumber,
    passportNumber,
  });

  // 5) Name — script choice depends on idType, with cross-fallback.
  const name = pickName(named, tokens, idType === 'FOREIGN_RESIDENT_CARD');

  return {
    idType,
    name,
    birthDate,
    rrnFront,
    rrnBackFirstDigit,
    issueDate,
    issuingAuthority,
    licenseNumber,
    passportNumber,
    rawConfidence: avgConfidence,
  };
}

// ── RRN ─────────────────────────────────────────────────────────

function pickRrnText(named: Map<string, ClovaField>, allText: string): string | null {
  const named1 = firstByKeys(named, [
    'rrn',
    'residentregistrationnumber',
    '주민등록번호',
    'foreignregistrationnumber',
    '외국인등록번호',
  ]);
  if (named1) return named1;
  const m = allText.match(RRN_RE);
  if (!m) return null;
  return `${m[1]}-${m[2] ?? ''}${m[3] ?? ''}`;
}

function splitRrn(rrnText: string | null): {
  rrnFront: string | null;
  rrnBackFirstDigit: string | null;
} {
  if (!rrnText) return { rrnFront: null, rrnBackFirstDigit: null };
  const m = rrnText.match(/(\d{6})[\s-]?(\d)/);
  if (!m) return { rrnFront: null, rrnBackFirstDigit: null };
  return { rrnFront: m[1], rrnBackFirstDigit: m[2] };
}

function deriveBirthDateFromRrn(front: string | null, back1: string | null): string | null {
  if (!front || !back1) return null;
  const yy = front.slice(0, 2);
  const mm = front.slice(2, 4);
  const dd = front.slice(4, 6);
  const monthNum = Number(mm);
  const dayNum = Number(dd);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;
  let century: string;
  if (back1 === '1' || back1 === '2' || back1 === '5' || back1 === '6') century = '19';
  else if (back1 === '3' || back1 === '4' || back1 === '7' || back1 === '8') century = '20';
  else if (back1 === '9' || back1 === '0') century = '18';
  else return null;
  return `${century}${yy}-${mm}-${dd}`;
}

// ── Dates ───────────────────────────────────────────────────────

function pickBirthDateFromText(
  named: Map<string, ClovaField>,
  tokens: string[],
): string | null {
  const named1 = firstByKeys(named, ['birthdate', 'birth', 'dob', '생년월일']);
  if (named1) return normaliseDate(named1);
  const nearLabel = findDateNearLabel(tokens, ['생년월일', 'birth', 'dob', 'date of birth']);
  return normaliseDate(nearLabel);
}

function normaliseDate(s: string | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (ISO_DATE_RE.test(trimmed)) return trimmed;
  const m = s.match(ANY_DATE_RE);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  return null;
}

function findDateNearLabel(tokens: string[], labels: string[]): string | null {
  const lower = labels.map((l) => l.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (!lower.some((l) => t.includes(l))) continue;
    for (let j = i + 1; j < Math.min(tokens.length, i + 4); j++) {
      const m = tokens[j].match(ANY_DATE_RE);
      if (m) return tokens[j];
    }
  }
  return null;
}

function findIssueDateFallback(tokens: string[]): string | null {
  const all = tokens.join(' ').match(ANY_DATE_RE_G) ?? [];
  return all[1] ?? null;
}

function pad2(n: string): string {
  return n.length >= 2 ? n : `0${n}`;
}

// ── Type guess ──────────────────────────────────────────────────

function guessIdType(args: {
  allText: string;
  named: Map<string, ClovaField>;
  rrnBackFirstDigit: string | null;
  licenseNumber: string | null;
  passportNumber: string | null;
}): KoreanIdType {
  const { allText, named, rrnBackFirstDigit, licenseNumber, passportNumber } = args;

  if (passportNumber || /여권|passport/i.test(allText)) return 'PASSPORT';
  if (
    /외국인\s*등록\s*증|alien\s+registration|foreign\s+resident|residence\s+card/i.test(allText)
  ) {
    return 'FOREIGN_RESIDENT_CARD';
  }
  if (licenseNumber || /운전면허|driver\s*licen[cs]e/i.test(allText)) return 'DRIVER_LICENSE';
  if (/주민등록증|resident\s+registration/i.test(allText)) return 'RESIDENT_REGISTRATION';

  // RRN back-digit is decisive for resident-vs-foreign distinction.
  if (rrnBackFirstDigit) {
    const d = rrnBackFirstDigit;
    if (d === '5' || d === '6' || d === '7' || d === '8') return 'FOREIGN_RESIDENT_CARD';
    if (d === '1' || d === '2' || d === '3' || d === '4' || d === '9' || d === '0') {
      return 'RESIDENT_REGISTRATION';
    }
  }

  if (named.has('주민등록번호') || named.has('rrn')) return 'RESIDENT_REGISTRATION';
  if (named.has('외국인등록번호') || named.has('foreignregistrationnumber')) {
    return 'FOREIGN_RESIDENT_CARD';
  }
  return 'UNKNOWN';
}

// ── Name ────────────────────────────────────────────────────────

function pickName(
  named: Map<string, ClovaField>,
  tokens: string[],
  preferLatin: boolean,
): string | null {
  const named1 = sanitizeNamed(firstByKeys(named, ['name', 'fullname', '성명', '이름']));
  if (named1) return named1;
  const primary = preferLatin ? extractLatinName(tokens) : extractKoreanName(tokens);
  if (primary) return primary;
  return preferLatin ? extractKoreanName(tokens) : extractLatinName(tokens);
}

function sanitizeNamed(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (KOREAN_LABELS.has(cleaned)) return null;
  if (LATIN_LABELS.has(cleaned.toUpperCase())) return null;
  // If the named-field value is a long list of tokens, scrub labels word-by-word.
  if (/[A-Za-z]/.test(cleaned)) {
    const kept = cleaned
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !LATIN_LABELS.has(w.toUpperCase()) && LATIN_TOKEN_RE.test(w));
    if (kept.length > 0) return kept.join(' ');
  }
  return cleaned;
}

function extractKoreanName(tokens: string[]): string | null {
  for (const tok of tokens) {
    const cleaned = tok.replace(/[^가-힣]/g, '');
    if (cleaned.length < 2 || cleaned.length > 5) continue;
    if (KOREAN_LABELS.has(cleaned)) continue;
    if (!KOREAN_NAME_RE.test(cleaned)) continue;
    return cleaned;
  }
  return null;
}

interface LatinCand {
  text: string;
  allUpper: boolean;
  words: number;
  len: number;
}

function extractLatinName(tokens: string[]): string | null {
  const candidates: LatinCand[] = [];
  for (const tok of tokens) {
    const cleaned = tok.replace(/[^A-Za-z\s'-]/g, ' ').trim().replace(/\s+/g, ' ');
    if (!cleaned) continue;
    const words = cleaned
      .split(' ')
      .filter(
        (w) => w.length >= 2 && !LATIN_LABELS.has(w.toUpperCase()) && LATIN_TOKEN_RE.test(w),
      );
    if (words.length === 0) continue;
    const text = words.join(' ');
    candidates.push({
      text,
      allUpper: text === text.toUpperCase(),
      words: words.length,
      len: text.length,
    });
  }
  if (candidates.length === 0) return null;
  // Prefer ALL-CAPS multi-word strings (typical layout on Korean foreign resident cards).
  candidates.sort((a, b) => {
    if (a.allUpper !== b.allUpper) return a.allUpper ? -1 : 1;
    if (a.words !== b.words) return b.words - a.words;
    return b.len - a.len;
  });
  return candidates[0].text;
}

// ── Misc ────────────────────────────────────────────────────────

function firstByKeys(map: Map<string, ClovaField>, keys: string[]): string | null {
  for (const k of keys) {
    const f = map.get(k);
    if (f && f.inferText.trim()) return f.inferText.trim();
  }
  return null;
}
