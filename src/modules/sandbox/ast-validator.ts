import { BadRequestException } from '@nestjs/common';

/**
 * Patterns that indicate an attempt to perform dangerous operations inside
 * the Judge0 sandbox. Both a regex pre-check (fast, covers obvious cases) and
 * a line-by-line scan are applied. The server also enforces OS-level
 * restrictions (no network, read-only FS, seccomp/AppArmor) as the real
 * security boundary — this check is a developer-friendly early rejection.
 *
 * Reference: AGENTS.md §10 (Code sandbox security).
 */

/** Forbidden module names for Python `import` / `__import__` / `importlib`. */
const PYTHON_FORBIDDEN_MODULES = [
  'os',
  'subprocess',
  'socket',
  'urllib',
  'urllib2',
  'urllib3',
  'requests',
  'httpx',
  'http',
  'ftplib',
  'smtplib',
  'importlib',
  'ctypes',
  'mmap',
  'multiprocessing',
  'threading',
  'concurrent',
  'asyncio',
  'signal',
  'resource',
  'pty',
  'termios',
  'tty',
  'grp',
  'pwd',
  'spwd',
];

/** Forbidden builtins for Python. */
const PYTHON_FORBIDDEN_BUILTINS = ['eval', 'exec', '__import__', 'open', 'compile', 'globals', 'locals', '__builtins__'];

/** Forbidden patterns for JavaScript / TypeScript / Node.js. */
const JS_FORBIDDEN_PATTERNS = [
  /require\s*\(\s*['"]fs['"]/,
  /require\s*\(\s*['"]child_process['"]/,
  /require\s*\(\s*['"]net['"]/,
  /require\s*\(\s*['"]http['"]/,
  /require\s*\(\s*['"]https['"]/,
  /require\s*\(\s*['"]os['"]/,
  /require\s*\(\s*['"]cluster['"]/,
  /require\s*\(\s*['"]worker_threads['"]/,
  /import\s+.*\s+from\s+['"]fs['"]/,
  /import\s+.*\s+from\s+['"]child_process['"]/,
  /import\s+.*\s+from\s+['"]net['"]/,
  /import\s+.*\s+from\s+['"]http['"]/,
  /import\s+.*\s+from\s+['"]https['"]/,
  /process\.env/,
  /process\.exit/,
  /eval\s*\(/,
  /Function\s*\(/,
  /XMLHttpRequest/,
  /fetch\s*\(/,
];

interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Judge0 language IDs that this platform permits. */
const ALLOWED_LANGUAGE_IDS = new Set<number>([
  71,  // Python 3
  70,  // Python 2 (legacy)
  63,  // JavaScript (Node.js)
  74,  // TypeScript
  62,  // Java
  54,  // C++
  50,  // C
  72,  // Ruby
  73,  // Rust
  60,  // Go
]);

/** Validate language is on the allowlist. */
export function validateLanguageId(languageId: number): void {
  if (!ALLOWED_LANGUAGE_IDS.has(languageId)) {
    throw new BadRequestException(
      `Language ID ${languageId} is not permitted. Allowed IDs: ${[...ALLOWED_LANGUAGE_IDS].join(', ')}`,
    );
  }
}

function checkPython(code: string): ValidationResult {
  const lines = code.split('\n');
  for (const line of lines) {
    const stripped = line.replace(/#.*$/, '').trim();
    if (!stripped) continue;

    for (const mod of PYTHON_FORBIDDEN_MODULES) {
      // Match `import os`, `import os.path`, `from os import ...`, `from os.path ...`
      if (
        new RegExp(`^import\\s+${mod}(\\s|\\.|$|,)`).test(stripped) ||
        new RegExp(`^from\\s+${mod}(\\s|\\.)`).test(stripped)
      ) {
        return { ok: false, reason: `Forbidden import: "${mod}"` };
      }
    }

    for (const builtin of PYTHON_FORBIDDEN_BUILTINS) {
      if (new RegExp(`\\b${builtin}\\s*\\(`).test(stripped)) {
        return { ok: false, reason: `Forbidden builtin: "${builtin}()"` };
      }
    }

    // __import__ call syntax
    if (/__import__/.test(stripped)) {
      return { ok: false, reason: 'Forbidden: __import__' };
    }
  }
  return { ok: true };
}

function checkJavaScript(code: string): ValidationResult {
  for (const pattern of JS_FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      return { ok: false, reason: `Forbidden pattern detected: ${pattern.source}` };
    }
  }
  return { ok: true };
}

/**
 * Validate source code before submitting to Judge0.
 * Throws `BadRequestException` if a forbidden pattern is found.
 *
 * @param sourceCode - The raw source code string.
 * @param languageId - Judge0 language ID (71 = Python 3, 63 = Node.js, etc.).
 */
export function validateSourceCode(sourceCode: string, languageId: number): void {
  if (!sourceCode || !sourceCode.trim()) {
    throw new BadRequestException('Source code cannot be empty.');
  }
  if (sourceCode.length > 65_536) {
    throw new BadRequestException('Source code exceeds the 64 KB limit.');
  }

  validateLanguageId(languageId);

  const isPython = languageId === 71 || languageId === 70;
  const isJs = languageId === 63 || languageId === 74;

  let result: ValidationResult = { ok: true };
  if (isPython) result = checkPython(sourceCode);
  else if (isJs) result = checkJavaScript(sourceCode);

  if (!result.ok) {
    throw new BadRequestException(
      `Code rejected by security validator: ${result.reason}. ` +
        'File I/O, network access, and OS-level operations are not permitted.',
    );
  }
}
