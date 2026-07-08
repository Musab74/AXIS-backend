/**
 * Hybrid-grading thresholds — the config-table stand-in.
 *
 * The original AXIS L1 brief sourced these from a `공통설정` (common-settings)
 * YAML and spoke in absolute cut lines (70/100 pass, 39/33 Part-B cuts, 12
 * Part-C floor). That content does NOT exist in this repo: the live platform
 * grades on percentages via `LEVEL_TIMING` (written ≥60 AND practical ≥60,
 * per-subject ≥40). To honour the brief's "load thresholds, never hardcode in
 * scattered literals" rule without inventing a fictional cut scheme, every
 * tunable used by the AI scorer / calibration / review-trigger logic lives here
 * in one place. If a real settings table is added later, swap the reads — the
 * call sites already treat these as injected config, not magic numbers.
 */
export const GRADING_CONFIG = {
  /**
   * Minimum AI self-reported confidence for an AI pre-score to be considered
   * trustworthy. Below this, the session is forced to human adjudication and a
   * task cannot pass calibration. (Brief §5: "AI confidence < 0.75".)
   */
  CONFIDENCE_FLOOR: 0.75,

  /**
   * Gap between the expert's score and the AI pre-score — both normalized to a
   * 0–100 percentage of the task's max points — at or beyond which a task is
   * treated as disputed (drives the `expert_disputed` queue state).
   */
  DISPUTE_DELTA_POINTS: 15,

  /**
   * Pass-boundary band, in percentage points around a section's pass line,
   * within which a result is "borderline" and must be human-reviewed. Replaces
   * the brief's literal 65–74 total-score window (which assumed a 0–100 point
   * total this platform does not use). Default ±5pp around each pass cut.
   */
  BOUNDARY_BAND_PCT: 5,

  /**
   * Calibration tolerance: the AI's total on an anchor exemplar must fall
   * within `max(expertVariance, CALIBRATION_FLOOR_POINTS)` points of the expert
   * mean. The floor guards the case where experts agree perfectly (variance 0)
   * but we still allow the AI a small slack.
   */
  CALIBRATION_FLOOR_POINTS: 3,

  /** Minimum number of independent expert ratings required to calibrate a task. */
  CALIBRATION_MIN_EXPERTS: 2,

  /**
   * Per-task hard review floor (%): any practical/essay task scored below this
   * percentage goes to mandatory expert review regardless of the AI's
   * band/confidence self-report. Applies at every level.
   */
  TASK_REVIEW_FLOOR_PCT: 40,
} as const;

/**
 * CRITICAL is reserved for the AXIS-H medical ruleset (치료·처방·환자정보 —
 * 불합격 검토 대상) and, since v2.0, the controlled-vocabulary critical tags
 * (개인정보/내부기밀 input). Any HIGH or CRITICAL flag escalates finalize to a
 * GRADING_ADMIN (see review-triggers.ts).
 */
export type RiskSeverity = 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';

export type GradingBand = 'excellent' | 'normal' | 'borderline' | 'fail';

// ─── 시험 표준 v2.0 controlled risk vocabulary + critical-fail enums (WP6) ───
// Enum strings are verbatim from the session-aggregate schemas
// (AXIS_L*_채점_세션집계_JSON스키마_v1_0.json) and the AI-grading prompt
// packages (AXIS_L*_AI채점_프롬프트_v1_0.yaml). Do NOT reword.

/** L1/L2 통제어휘 11종 (risk_flags enum). */
export const RISK_VOCAB_L1_L2: readonly string[] = [
  '개인정보', '내부기밀', '저작권', '출처불명', '허위정보', '수치오류',
  '과장표현', '편향', '책임소재', '보안(외부도구)', '최신성한계',
] as const;

/** L3 통제어휘 10종 — the L3 schema uses its own phrasing (개발자 명세서 §12). */
export const RISK_VOCAB_L3: readonly string[] = [
  '개인정보 입력', '기밀정보 입력', '검증 생략', '허위정보 신뢰',
  '출처불명 수치 방치', '저작권 위험', '보안 위험', '과장표현 방치',
  '책임소재 불명확', '사람 검토 생략',
] as const;

/**
 * 치명 실패 패턴 (critical-fail patterns). Detection → expert review + fail
 * consideration; the AI only nominates candidates, a human confirms. L3 has no
 * critical-fail enum in its schema — its critical control is the
 * critical-severity risk tags (개인정보/기밀정보 입력 → critical_risk_detected).
 */
export const CRITICAL_FAIL_PATTERNS: Record<'L1' | 'L2' | 'L3', readonly string[]> = {
  L1: ['법규 위반 전제 계획', '시나리오 밖 사실 창작', '리스크 통제 섹션 백지·형식 기재'],
  L2: ['개인정보 AI 입력·산출물 잔존', '허위·출처불명 수치 무검증 제출', '제공 자료 밖 사실 창작'],
  L3: [],
};

/** v2.0 per-level gate rule names (AI grading contract `gate.rule`). */
export const GATE_RULES = {
  L1: '계획-리스크 정합 게이트',
  L2: '산출물-검증 게이트',
  L3: '선택-근거 일치 게이트',
} as const;

/**
 * System-side severity mapping for the controlled vocabulary (개발자 명세서
 * §12 — "severity는 시스템이 산정한다, AI는 플래그만 출력한다"):
 *   critical → 개인정보/내부기밀 input: always human review + possible fail
 *              regardless of score (확정은 전문가·관리자).
 *   high     → 검증생략/출처불명 수치/저작권/보안(외부도구)/수치오류: mandatory review.
 *   medium   → 허위정보/과장표현/책임소재 (+편향/최신성한계): review queue.
 * AXIS-H medical codes keep their own ladder (claude-essay-grader AXIS_H_GUIDANCE).
 * Unknown/off-vocabulary tags default to MED so they still reach the queue.
 */
const RISK_TAG_SEVERITY: Record<string, RiskSeverity> = {
  // L1/L2 vocabulary
  개인정보: 'CRITICAL',
  내부기밀: 'CRITICAL',
  출처불명: 'HIGH',
  저작권: 'HIGH',
  '보안(외부도구)': 'HIGH',
  수치오류: 'HIGH',
  허위정보: 'MED',
  과장표현: 'MED',
  책임소재: 'MED',
  편향: 'MED',
  최신성한계: 'MED',
  // L3 vocabulary
  '개인정보 입력': 'CRITICAL',
  '기밀정보 입력': 'CRITICAL',
  '검증 생략': 'HIGH',
  '출처불명 수치 방치': 'HIGH',
  '저작권 위험': 'HIGH',
  '보안 위험': 'HIGH',
  '사람 검토 생략': 'HIGH',
  '허위정보 신뢰': 'MED',
  '과장표현 방치': 'MED',
  '책임소재 불명확': 'MED',
  // AXIS-H medical ruleset (system-side so the AI cannot understate them)
  diagnosis: 'HIGH',
  treatment: 'CRITICAL',
  prescription: 'CRITICAL',
  false_reassurance: 'HIGH',
  patient_privacy: 'CRITICAL',
  overclaim: 'MED',
};

export function severityForRiskTag(tag: string): RiskSeverity {
  return RISK_TAG_SEVERITY[tag] ?? 'MED';
}

/** True when a tag is critical-severity (총점 무관 전문가 필수 검수 + 불합격 검토). */
export function isCriticalRiskTag(tag: string): boolean {
  return severityForRiskTag(tag) === 'CRITICAL';
}

/**
 * Explicit AI-grading prompt version strings (WP8 audit: stored on every AI
 * result alongside the prompt hash; a version change requires re-baselining).
 */
export const AI_GRADING_PROMPT_VERSION: Record<'L1' | 'L2' | 'L3', string> = {
  L1: 'AXIS-L1-AI-SCORING-PROMPT-v1.0',
  L2: 'AXIS-L2-AI-SCORING-PROMPT-v1.0',
  L3: 'AXIS-L3-AI-SCORING-PROMPT-v1.0',
};
