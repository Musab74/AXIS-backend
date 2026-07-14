/**
 * L3 client-view contract, verified against the REAL v3 practical bank (all 40
 * items, all 4 types). Guards the two things that silently ruin an exam:
 *
 *   1. the candidate must actually SEE the options (with their grading codes) —
 *      the pre-v3 client view degraded every field to a free-text chip box;
 *   2. no answer key may ever reach the client.
 *
 * The rubric wrapper is built here exactly as `prisma/import-new-questions.ts`
 * writes it, so this fails if the importer and the client view drift apart.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { l3ClientView } from './cbt-exams.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml: { load: (s: string) => any } = require('js-yaml');

const BANK = join(
  __dirname, '..', '..', '..', '..',
  'new_version_v3', '3_AXIS L3', '1_시스템업로드·검토용_패키지', '3_실습형_40문항_은행',
);
const rec = (v: any) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** Rebuild the rubric wrapper the importer stores in TaskTemplate.rubric. */
function rubricOf(it: any) {
  const ak = rec(it.answer_key) ?? {};
  const required = rec(ak.required_choices) ?? {};
  const examplePrompt = ak.example_prompt ?? ak.example_revision_prompt ?? null;
  return {
    rubric: {
      practiceType: it.practice_type,
      responseFormat: it.response_format,
      answerKey: {
        ...required,
        ...(ak.key_reason ? { key_reason: ak.key_reason } : {}),
        ...(examplePrompt ? { example_prompt: examplePrompt } : {}),
      },
      mustNotChoose: ak.must_not_choose ?? [],
    },
    required,
  };
}

const ITEMS: any[] = [];
for (const f of readdirSync(BANK).filter((n) => n.endsWith('.yaml'))) {
  const doc = yaml.load(readFileSync(join(BANK, f), 'utf8'));
  ITEMS.push(...(doc.items ?? []));
}

describe('l3ClientView · v3 bank (40 real items)', () => {
  it('loads the whole practical bank', () => {
    expect(ITEMS).toHaveLength(40);
  });

  it.each(ITEMS.map((it) => [it.item_id as string, it]))(
    '%s renders structured fields the candidate can actually answer',
    (_id, it: any) => {
      const { rubric, required } = rubricOf(it);
      const view = l3ClientView(rubric);
      expect(view).not.toBeNull();

      const selects = view!.fields.filter((f) => f.kind === 'select');
      const generates = view!.fields.filter((f) => f.kind === 'generate');

      // Field keys must line up with the answer key, in order — otherwise the
      // candidate's `selects` never reach the grader.
      expect(selects.map((s) => s.key)).toEqual(Object.keys(required));

      for (const s of selects) {
        // Options must be present WITH codes (the grader scores on codes).
        expect(s.choices?.length).toBeGreaterThan(1);
        for (const c of s.choices!) {
          expect(c.code).toMatch(/^[A-Z]+\d+$/);
          expect(c.text.length).toBeGreaterThan(0);
        }
        // selectCount must match how many answers the key expects.
        const correct: string[] = ([] as string[]).concat((required as any)[s.key] ?? []);
        expect(s.selectCount).toBe(correct.length);
        // Every correct code must be among the rendered options.
        const codes = s.choices!.map((c) => c.code);
        for (const c of correct) expect(codes).toContain(c);
      }

      // The 요청문 box appears exactly when the bank declares a generation_field.
      const hasGen = rec(it.response_format?.generation_field) != null;
      expect(generates).toHaveLength(hasGen ? 1 : 0);
      if (hasGen) {
        expect(generates[0].key).toBe('writePrompt'); // grader reads it top-level
        expect([80, 250]).toContain(generates[0].maxLen);
      }

      expect(view!.reason).toEqual({ min: 80, max: 150 });

      // No answer key, ever.
      const wire = JSON.stringify(view);
      expect(wire).not.toContain('key_reason');
      expect(wire).not.toContain('example_prompt');
      expect(wire).not.toContain('must_not_choose');
      for (const correct of Object.values(required as Record<string, string[]>)) {
        // A correct code appearing as an OPTION is fine; what must never appear
        // is the answerKey structure itself (checked above). Sanity: options are
        // unmarked — no field flags which code is right.
        expect(wire).not.toContain(`"correct":"${correct[0]}"`);
      }
    },
  );

  it('legacy (v2) rubric shape still renders — regression', () => {
    const view = l3ClientView({
      practiceType: '현업적용형',
      responseFormat: { select: ['보고서 초안', '데이터 정리'], short_reason: '80~150자' },
      answerKey: { select: ['보고서 초안'], key_reason: '…' },
    });
    expect(view!.fields[0].kind).toBe('multi');
    expect(view!.fields[0].options).toEqual(['보고서 초안', '데이터 정리']);
  });
});
