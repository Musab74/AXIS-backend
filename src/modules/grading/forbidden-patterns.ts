/**
 * Static forbidden-pattern scan for AXIS-C code submissions (grading-time,
 * before/alongside the Judge0 run). A match never auto-fails the candidate —
 * it emits a `forbidden_pattern` risk flag, which routes the session to
 * mandatory expert review.
 */
import type { EssayGradeRiskFlag } from '../../integrations/anthropic/claude-essay-grader.service';

interface ForbiddenPattern {
  name: string;
  re: RegExp;
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  { name: 'os.system', re: /\bos\.system\b/ },
  { name: 'subprocess', re: /\bsubprocess\b/ },
  { name: 'socket', re: /\bsocket\b/ },
  { name: 'urllib', re: /\burllib\b/ },
  { name: 'requests', re: /\brequests\b/ },
  { name: 'fetch(', re: /\bfetch\s*\(/ },
  { name: 'eval(', re: /\beval\s*\(/ },
  { name: 'exec(', re: /\bexec\s*\(/ },
  { name: 'os.environ', re: /\bos\.environ\b/ },
  { name: '__import__', re: /__import__/ },
];

const OPEN_CALL_RE = /\bopen\s*\(([^)]*)\)/g;
/** A quoted mode string containing 'w' or 'a' (e.g. 'w', "a+", 'wb'). */
const WRITE_MODE_RE = /['"][rbx+]*[wa][rwabx+]*['"]/;

/** open(...) with a write/append mode whose arguments don't point into /tmp. */
function hasFileWriteOutsideTmp(code: string): boolean {
  for (const match of code.matchAll(OPEN_CALL_RE)) {
    const args = match[1];
    if (WRITE_MODE_RE.test(args) && !args.includes('/tmp')) return true;
  }
  return false;
}

/**
 * Scan a code submission for the forbidden-pattern table. Returns one
 * `forbidden_pattern` flag per matched pattern (HIGH severity — security).
 */
export function scanForbiddenPatterns(code: string | null | undefined): EssayGradeRiskFlag[] {
  const text = code ?? '';
  if (!text.trim()) return [];
  const flags: EssayGradeRiskFlag[] = FORBIDDEN_PATTERNS.filter((p) => p.re.test(text)).map(
    (p) => ({
      code: 'forbidden_pattern',
      severity: 'HIGH',
      detail: `금지 패턴 감지: ${p.name}`,
    }),
  );
  if (hasFileWriteOutsideTmp(text)) {
    flags.push({
      code: 'forbidden_pattern',
      severity: 'HIGH',
      detail: '금지 패턴 감지: open() 쓰기 모드 (/tmp 외부 파일 쓰기)',
    });
  }
  return flags;
}
