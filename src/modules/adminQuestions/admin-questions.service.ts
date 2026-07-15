import { BadRequestException, Injectable } from '@nestjs/common';
import { CertLevel, CertType, ExamPart } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

export interface QuestionFilters {
  certType?: CertType;
  level?: CertLevel;
  subjectIndex?: number;
  search?: string;
  page?: number;
  limit?: number;
}

export interface TaskFilters {
  certType?: CertType;
  level?: CertLevel;
  part?: ExamPart;
  search?: string;
  page?: number;
  limit?: number;
}

export type CsvUploadKind = 'mcq' | 'task';

export interface CsvUploadResult {
  kind: CsvUploadKind;
  fileName: string;
  rowsParsed: number;
  rowsValid: number;
  errors: string[];
  warnings: string[];
  storedAt: string;
}

const MCQ_REQUIRED_HEADERS = [
  'no',
  'cert_type',
  'level',
  'subject',
  'q_type',
  'content',
  'option_a',
  'option_b',
  'option_c',
  'option_d',
  'correct_answer',
  'points',
];

const TASK_REQUIRED_HEADERS = [
  'set_no',
  'cert_type',
  'level',
  'task_type',
  'task_title',
  'time_limit',
  'scenario_content',
  'rubric',
  'max_score',
];

const VALID_CERT_TYPES = new Set(['AXIS', 'AXIS_C', 'AXISC', 'AXIS_H', 'AXISH']);
const VALID_CERT_LEVELS = new Set(['L1', 'L2', 'L3']);
const VALID_ANSWERS = new Set(['A', 'B', 'C', 'D']);

@Injectable()
export class AdminQuestionsService {
  private readonly questionsDir = path.resolve(process.cwd(), 'questions');
  private cache: {
    loadedAt: number;
    signature: string;
    questions: any[];
    tasks: any[];
  } | null = null;
  private readonly cacheTtlMs = 60_000;

  async getQuestions(filters: QuestionFilters) {
    const { questions } = this.loadFromFiles();
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(Math.max(1, filters.limit ?? 20), 100);
    const skip = (page - 1) * limit;

    const search = filters.search?.trim().toLowerCase();
    const filtered = questions.filter((q) => {
      if (filters.certType && q.certType !== filters.certType) return false;
      if (filters.level && q.level !== filters.level) return false;
      if (filters.subjectIndex !== undefined && q.subjectIndex !== filters.subjectIndex) return false;
      if (
        search &&
        !(`${q.stem}`.toLowerCase().includes(search) || `${q.subjectName}`.toLowerCase().includes(search))
      ) {
        return false;
      }
      return true;
    });

    const sorted = filtered.sort((a, b) => {
      if (a.certType !== b.certType) return `${a.certType}`.localeCompare(`${b.certType}`);
      if (a.level !== b.level) return `${a.level}`.localeCompare(`${b.level}`);
      if (a.subjectIndex !== b.subjectIndex) return a.subjectIndex - b.subjectIndex;
      return `${a.id}`.localeCompare(`${b.id}`);
    });

    const total = sorted.length;
    const paged = sorted.slice(skip, skip + limit);

    return {
      questions: paged,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getQuestionById(id: string) {
    const { questions } = this.loadFromFiles();
    return questions.find((q) => q.id === id) ?? null;
  }

  async getQuestionStats() {
    const { questions } = this.loadFromFiles();

    return {
      total: questions.length,
      byCertType: this.groupCount(questions, 'certType'),
      byLevel: this.groupCount(questions, 'level'),
      byType: this.groupCount(questions, 'type'),
    };
  }

  async getTasks(filters: TaskFilters) {
    const { tasks } = this.loadFromFiles();
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(Math.max(1, filters.limit ?? 20), 100);
    const skip = (page - 1) * limit;

    const search = filters.search?.trim().toLowerCase();
    const filtered = tasks.filter((t) => {
      if (filters.certType && t.certType !== filters.certType) return false;
      if (filters.level && t.level !== filters.level) return false;
      if (filters.part && t.part !== filters.part) return false;
      if (
        search &&
        !(`${t.title}`.toLowerCase().includes(search) || `${t.scenario}`.toLowerCase().includes(search))
      ) {
        return false;
      }
      return true;
    });

    const sorted = filtered.sort((a, b) => {
      if (a.certType !== b.certType) return `${a.certType}`.localeCompare(`${b.certType}`);
      if (a.level !== b.level) return `${a.level}`.localeCompare(`${b.level}`);
      if (a.part !== b.part) return `${a.part}`.localeCompare(`${b.part}`);
      if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
      return `${a.id}`.localeCompare(`${b.id}`);
    });

    const total = sorted.length;
    const paged = sorted.slice(skip, skip + limit);

    return {
      tasks: paged,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTaskById(id: string) {
    const { tasks } = this.loadFromFiles();
    return tasks.find((t) => t.id === id) ?? null;
  }

  async getTaskStats() {
    const { tasks } = this.loadFromFiles();

    return {
      total: tasks.length,
      byCertType: this.groupCount(tasks, 'certType'),
      byLevel: this.groupCount(tasks, 'level'),
      byPart: this.groupCount(tasks, 'part'),
    };
  }

  async getSubjects() {
    const { questions } = this.loadFromFiles();
    const subjectMap = new Map<string, { certType: CertType; level: CertLevel; subjectIndex: number; subjectName: string; questionCount: number }>();
    for (const q of questions) {
      const key = `${q.certType}|${q.level}|${q.subjectIndex}|${q.subjectName}`;
      const cur = subjectMap.get(key);
      if (cur) {
        cur.questionCount += 1;
      } else {
        subjectMap.set(key, {
          certType: q.certType,
          level: q.level,
          subjectIndex: q.subjectIndex,
          subjectName: q.subjectName,
          questionCount: 1,
        });
      }
    }
    return Array.from(subjectMap.values()).sort((a, b) => {
      if (a.certType !== b.certType) return `${a.certType}`.localeCompare(`${b.certType}`);
      if (a.level !== b.level) return `${a.level}`.localeCompare(`${b.level}`);
      if (a.subjectIndex !== b.subjectIndex) return a.subjectIndex - b.subjectIndex;
      return `${a.subjectName}`.localeCompare(`${b.subjectName}`);
    });
  }

  private loadFromFiles() {
    const files = this.getCsvFiles();
    const signature = files.map((f) => `${f.file}:${f.mtime}`).join('|');
    const now = Date.now();
    if (this.cache && this.cache.signature === signature && now - this.cache.loadedAt < this.cacheTtlMs) {
      return this.cache;
    }

    const questions: any[] = [];
    const tasks: any[] = [];

    for (const f of files) {
      const content = fs.readFileSync(f.absolutePath, 'utf-8').replace(/^\uFEFF/, '');
      const rows = this.parseCSV(content);
      if (!rows.length) continue;

      const headers = Object.keys(rows[0]).map((h) => h.trim().toLowerCase());
      const isPractical = headers.includes('set_no');
      if (isPractical) {
        tasks.push(...this.mapTaskRows(rows, f.file));
      } else {
        questions.push(...this.mapQuestionRows(rows, f.file));
      }
    }

    this.cache = { loadedAt: now, signature, questions, tasks };
    return this.cache;
  }

  private getCsvFiles() {
    if (!fs.existsSync(this.questionsDir)) return [];
    return fs
      .readdirSync(this.questionsDir)
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .map((file) => {
        const absolutePath = path.join(this.questionsDir, file);
        const stat = fs.statSync(absolutePath);
        return {
          file,
          absolutePath,
          mtime: stat.mtimeMs,
        };
      });
  }

  private parseCSV(content: string): Record<string, string>[] {
    const lines: string[] = [];
    let currentLine = '';
    let inQuotes = false;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      const nextChar = content[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          currentLine += '""';
          i++;
        } else {
          inQuotes = !inQuotes;
          currentLine += char;
        }
      } else if ((char === '\n' || (char === '\r' && nextChar === '\n')) && !inQuotes) {
        if (currentLine.trim()) lines.push(currentLine);
        currentLine = '';
        if (char === '\r') i++;
      } else {
        currentLine += char;
      }
    }

    if (currentLine.trim()) lines.push(currentLine);
    if (lines.length === 0) return [];

    const headers = this.parseCSVLine(lines[0]);
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);
      const row: Record<string, string> = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = values[j] ?? '';
      }
      rows.push(row);
    }
    return rows;
  }

  private parseCSVLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (!inQuotes) {
          inQuotes = true;
        } else if (nextChar === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  }

  private mapQuestionRows(rows: Record<string, string>[], fileName: string) {
    const subjectIndexByGroup = new Map<string, Map<string, number>>();
    const mapped: any[] = [];
    for (const r of rows) {
      const certType = this.mapCertType(r.cert_type);
      const level = this.mapCertLevel(r.level);
      const subjectName = (r.subject || '').trim() || 'Unknown';
      const groupKey = `${certType}|${level}`;
      if (!subjectIndexByGroup.has(groupKey)) subjectIndexByGroup.set(groupKey, new Map<string, number>());
      const subjectMap = subjectIndexByGroup.get(groupKey)!;
      if (!subjectMap.has(subjectName)) subjectMap.set(subjectName, subjectMap.size);
      const subjectIndex = subjectMap.get(subjectName)!;
      const no = this.toInt(r.no, 0);

      const choices = ['A', 'B', 'C', 'D']
        .map((label) => ({ label, text: (r[`option_${label.toLowerCase()}`] || '').trim() }))
        .filter((c) => c.text.length > 0);

      const stem = (r.content || '').trim();
      if (!stem) continue;

      mapped.push({
        id: `q:${fileName}:${no || mapped.length + 1}`,
        certType,
        level,
        subjectIndex,
        subjectName,
        type: (r.q_type || 'MCQ').trim().toUpperCase(),
        stem,
        choices: choices.length ? choices : null,
        correctAnswer: ((r.correct_answer || '').trim().toUpperCase() || null),
        points: this.toInt(r.points, 2),
        qVersion: this.toInt(r.version, 1),
        active: true,
        createdAt: this.toDate(r.created_date),
      });
    }
    return mapped;
  }

  private mapTaskRows(rows: Record<string, string>[], fileName: string) {
    const mapped: any[] = [];
    for (const r of rows) {
      const certType = this.mapCertType(r.cert_type);
      const level = this.mapCertLevel(r.level);
      const title = (r.task_title || '').trim() || (r.task_type || '').trim() || 'Task';
      const scenario = (r.scenario_content || '').trim();
      if (!scenario) continue;
      const taskType = (r.task_type || '').trim().toLowerCase();
      const setNo = this.toInt(r.set_no, mapped.length + 1);
      const orderIndex = this.toInt(r.set_no, setNo);
      const rubric = this.parseRubric(r.rubric || '');

      mapped.push({
        id: `t:${fileName}:${setNo}:${taskType || 'task'}`,
        certType,
        level,
        part: this.inferPart(taskType),
        title,
        scenario,
        rubric,
        durationMin: this.toInt(r.time_limit, 15),
        points: this.toInt(r.max_score, 20),
        orderIndex,
        createdAt: this.toDate(r.created_date),
      });
    }
    return mapped;
  }

  private inferPart(taskType: string): ExamPart {
    if (taskType.includes('part_a') || taskType.includes('task_a')) return ExamPart.DELIVERABLE;
    if (taskType.includes('part_b') || taskType.includes('task_b')) return ExamPart.ESSAY;
    return ExamPart.PRACTICAL;
  }

  private parseRubric(raw: string) {
    const text = raw.trim();
    if (!text) return {};
    const criteria = text
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((item) => {
        const m = item.match(/^(.*?)\((\d+)점\)\s*:\s*(.*)$/);
        if (m) {
          return { name: m[1].trim(), points: parseInt(m[2], 10), description: m[3].trim() };
        }
        return { name: item, points: 0, description: item };
      });
    return { raw: text, criteria };
  }

  private mapCertType(csvValue?: string): CertType {
    const v = (csvValue || '').trim().toUpperCase().replace('-', '_');
    if (v === 'AXIS_C' || v === 'AXISC') return CertType.AXIS_C;
    if (v === 'AXIS_H' || v === 'AXISH') return CertType.AXIS_H;
    return CertType.AXIS;
  }

  private mapCertLevel(csvValue?: string): CertLevel {
    const v = (csvValue || '').trim().toUpperCase();
    if (v === 'L1') return CertLevel.L1;
    if (v === 'L2') return CertLevel.L2;
    return CertLevel.L3;
  }

  private toInt(v: string | undefined, fallback: number) {
    const n = parseInt((v || '').trim(), 10);
    return Number.isNaN(n) ? fallback : n;
  }

  private toDate(v: string | undefined) {
    const s = (v || '').trim();
    if (!s) return new Date(0);
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? new Date(0) : d;
  }

  private groupCount(list: any[], key: string) {
    const m = new Map<string, number>();
    for (const item of list) {
      const k = String(item[key]);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Array.from(m.entries()).map(([k, count]) => ({ [key]: k, count }));
  }

  // ────────────────────────────────────────────────────────────────────────
  //  CSV upload + template
  //
  //  Uploads land in `axis-backend/questions/` (the same folder this service
  //  reads from). They become visible in the admin Question Bank view within
  //  the cache TTL (~60s) but DO NOT touch the live exam database. Live exam
  //  delivery uses the `questionBank` table, which is only updated by the ops
  //  step `npm run db:seed:questions`. This keeps production exams safe.
  // ────────────────────────────────────────────────────────────────────────

  async uploadCsv(file: Express.Multer.File): Promise<CsvUploadResult> {
    if (!file) throw new BadRequestException('CSV file is required');
    if (file.size === 0) throw new BadRequestException('Uploaded file is empty');
    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('File too large (max 5MB)');
    }

    const safeName = this.sanitizeFileName(file.originalname);
    if (!safeName.toLowerCase().endsWith('.csv')) {
      throw new BadRequestException('Only .csv files are supported');
    }

    const raw = file.buffer.toString('utf-8').replace(/^\uFEFF/, '');
    const rows = this.parseCSV(raw);
    if (rows.length === 0) {
      throw new BadRequestException('CSV is empty or could not be parsed');
    }

    const headers = Object.keys(rows[0]).map((h) => h.trim().toLowerCase());
    const isPractical = headers.includes('set_no');
    const kind: CsvUploadKind = isPractical ? 'task' : 'mcq';
    const required = isPractical ? TASK_REQUIRED_HEADERS : MCQ_REQUIRED_HEADERS;

    const missing = required.filter((h) => !headers.includes(h));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing required columns for ${kind === 'task' ? 'practical' : 'MCQ'} CSV: ${missing.join(', ')}`,
      );
    }

    const validation = isPractical ? this.validateTaskRows(rows) : this.validateQuestionRows(rows);
    if (validation.errors.length > 0 && validation.rowsValid === 0) {
      throw new BadRequestException(
        `CSV validation failed: ${validation.errors.slice(0, 5).join('; ')}` +
          (validation.errors.length > 5 ? ` (+${validation.errors.length - 5} more)` : ''),
      );
    }

    if (!fs.existsSync(this.questionsDir)) {
      fs.mkdirSync(this.questionsDir, { recursive: true });
    }

    const finalName = this.uniqueFileName(this.questionsDir, safeName);
    const targetPath = path.join(this.questionsDir, finalName);
    fs.writeFileSync(targetPath, raw, 'utf-8');

    // Invalidate cache so the new file is loaded on the next read.
    this.cache = null;

    return {
      kind,
      fileName: finalName,
      rowsParsed: rows.length,
      rowsValid: validation.rowsValid,
      errors: validation.errors,
      warnings: validation.warnings,
      storedAt: new Date().toISOString(),
    };
  }

  getCsvTemplate(kind: CsvUploadKind): { fileName: string; content: string } {
    if (kind === 'task') {
      const headers = [
        'set_no',
        'cert_type',
        'level',
        'task_type',
        'task_title',
        'time_limit',
        'scenario_content',
        'sample_data',
        'required_structure',
        'forbidden_rules',
        'ai_tool_allowed',
        'rubric',
        'max_score',
        'model_answer',
        'risk_criteria',
        'benchmark_excellent',
        'benchmark_normal',
        'benchmark_borderline',
        'benchmark_fail',
        'ai_prompt_version',
        'review_status',
        'review_comment',
        'version',
        'created_by',
        'created_date',
      ];
      const sample = [
        '1',
        'AXIS',
        'L1',
        'part_a',
        'AX 실행계획서',
        '40',
        '"당신은 직원 120명 규모의 ㈜가나테크 경영기획팀장입니다. 대표이사 지시에 따라 AI 도입 실행계획서를 작성하세요."',
        '"부서별 인원: 생산관리 40명·영업 30명·총무 15명 | 예산 5,000만원 | 기간 6개월"',
        '"1.도입 배경 2.As-Is 3.To-Be 4.ROI·KPI 5.로드맵 6.예산 7.리스크 8.성과 측정"',
        '"개인정보 입력 금지, 외부 AI 사용 금지(LMS만), 타인 답안 참조 금지"',
        'LMS 내장 AI',
        '"전략 논리성(15점): 도입 대상·우선순위 근거가 논리적인가? | ROI·KPI 설계(12점): 정량화·측정가능 KPI를 설계했는가? | 실행 계획(10점): 단계·담당·산출물이 구체적인가? | AI 활용(8점): AI를 효율적으로 활용했는가? | 리스크·변화관리(8점): 리스크 식별·대응이 포함되었는가? | 검증·완성도(7점): 수치 검증·문서 완성도"',
        '60',
        '"[핵심] 우선순위·ROI·KPI·로드맵·리스크·변화관리"',
        '"허위 수치, 비현실적 ROI, 개인정보 포함"',
        '"전 조건 반영, 정량 ROI+로드맵+리스크 (85~100점)"',
        '"주요 조건 반영, 기본 ROI+로드맵 (65~80점)"',
        '"조건 일부 누락, ROI 모호 (55~65점)"',
        '"조건 무시, ROI 없음 (55점 미만)"',
        '',
        'approved',
        '샘플',
        '1',
        '',
        '',
      ];
      return {
        fileName: 'AXIS_template_practical.csv',
        content: '\uFEFF' + headers.join(',') + '\n' + sample.join(',') + '\n',
      };
    }

    const headers = [
      'no',
      'cert_type',
      'level',
      'subject',
      'domain_area',
      'q_type',
      'item_purpose',
      'difficulty',
      'content',
      'option_a',
      'option_b',
      'option_c',
      'option_d',
      'correct_answer',
      'points',
      'explanation',
      'source_ref',
      'shuffle_exempt',
      'review_status',
      'review_comment',
      'version',
      'created_by',
      'created_date',
    ];
    const sample = [
      '1',
      'AXIS',
      'L3',
      'AI 기본 이해',
      '생성형 AI 개념',
      'multiple_choice',
      'concept',
      'easy',
      '"다음 중 생성형 AI의 특징으로 가장 적절한 것은?"',
      '"텍스트, 이미지, 코드 등 새로운 형태의 결과물을 생성할 수 있다."',
      '"정해진 보기 중 하나만 반복적으로 선택하는 시스템이다."',
      '"항상 사실만을 출력하므로 검증이 필요 없다."',
      '"인터넷 검색 결과를 그대로 복사해 보여주는 도구이다."',
      'A',
      '2',
      '"정답은 A입니다. 생성형 AI는 학습한 패턴을 바탕으로 새로운 산출물을 생성합니다."',
      'AXIS L3 과목1 AI 기본 이해',
      'False',
      'approved',
      '샘플',
      '1',
      '',
      '',
    ];
    return {
      fileName: 'AXIS_template_mcq.csv',
      content: '\uFEFF' + headers.join(',') + '\n' + sample.join(',') + '\n',
    };
  }

  private validateQuestionRows(rows: Record<string, string>[]) {
    const errors: string[] = [];
    const warnings: string[] = [];
    let rowsValid = 0;

    rows.forEach((r, idx) => {
      const rowNo = idx + 2; // header is row 1
      const certType = (r.cert_type || '').trim().toUpperCase().replace('-', '_');
      const level = (r.level || '').trim().toUpperCase();
      const stem = (r.content || '').trim();
      const answer = (r.correct_answer || '').trim().toUpperCase();
      const points = (r.points || '').trim();
      const subject = (r.subject || '').trim();

      if (!VALID_CERT_TYPES.has(certType)) {
        errors.push(`Row ${rowNo}: invalid cert_type "${r.cert_type}" (expected AXIS / AXIS_C / AXIS_H)`);
        return;
      }
      if (!VALID_CERT_LEVELS.has(level)) {
        errors.push(`Row ${rowNo}: invalid level "${r.level}" (expected L1 / L2 / L3)`);
        return;
      }
      if (!stem) {
        errors.push(`Row ${rowNo}: content (stem) is empty`);
        return;
      }
      if (!subject) {
        warnings.push(`Row ${rowNo}: subject is empty`);
      }
      if (!VALID_ANSWERS.has(answer)) {
        errors.push(`Row ${rowNo}: correct_answer must be A/B/C/D (got "${r.correct_answer}")`);
        return;
      }
      const choices = ['a', 'b', 'c', 'd'].map((k) => (r[`option_${k}`] || '').trim());
      const filled = choices.filter(Boolean).length;
      if (filled < 2) {
        errors.push(`Row ${rowNo}: at least 2 options required`);
        return;
      }
      const answerIdx = answer.charCodeAt(0) - 65;
      if (!choices[answerIdx]) {
        errors.push(`Row ${rowNo}: correct_answer "${answer}" has no option text`);
        return;
      }
      const pts = parseInt(points, 10);
      if (Number.isNaN(pts) || pts <= 0) {
        warnings.push(`Row ${rowNo}: points "${points}" not a positive integer (will default to 2)`);
      }
      rowsValid += 1;
    });

    return { errors, warnings, rowsValid };
  }

  private validateTaskRows(rows: Record<string, string>[]) {
    const errors: string[] = [];
    const warnings: string[] = [];
    let rowsValid = 0;

    rows.forEach((r, idx) => {
      const rowNo = idx + 2;
      const certType = (r.cert_type || '').trim().toUpperCase().replace('-', '_');
      const level = (r.level || '').trim().toUpperCase();
      const scenario = (r.scenario_content || '').trim();
      const title = (r.task_title || '').trim();
      const rubric = (r.rubric || '').trim();
      const maxScore = parseInt((r.max_score || '').trim(), 10);
      const timeLimit = parseInt((r.time_limit || '').trim(), 10);

      if (!VALID_CERT_TYPES.has(certType)) {
        errors.push(`Row ${rowNo}: invalid cert_type "${r.cert_type}"`);
        return;
      }
      if (!VALID_CERT_LEVELS.has(level)) {
        errors.push(`Row ${rowNo}: invalid level "${r.level}"`);
        return;
      }
      if (!scenario) {
        errors.push(`Row ${rowNo}: scenario_content is empty`);
        return;
      }
      if (!title) warnings.push(`Row ${rowNo}: task_title is empty`);
      if (!rubric) warnings.push(`Row ${rowNo}: rubric is empty`);
      if (Number.isNaN(maxScore) || maxScore <= 0) {
        warnings.push(`Row ${rowNo}: max_score "${r.max_score}" not a positive integer`);
      }
      if (Number.isNaN(timeLimit) || timeLimit <= 0) {
        warnings.push(`Row ${rowNo}: time_limit "${r.time_limit}" not a positive integer`);
      }
      rowsValid += 1;
    });

    return { errors, warnings, rowsValid };
  }

  private sanitizeFileName(name: string): string {
    const base = path.basename(name).replace(/[^A-Za-z0-9._\-가-힣]/g, '_');
    return base.length > 0 ? base : `upload_${Date.now()}.csv`;
  }

  private uniqueFileName(dir: string, name: string): string {
    const ext = path.extname(name) || '.csv';
    const stem = path.basename(name, ext);
    let candidate = name;
    let i = 1;
    while (fs.existsSync(path.join(dir, candidate))) {
      candidate = `${stem}_${i}${ext}`;
      i += 1;
      if (i > 999) {
        candidate = `${stem}_${Date.now()}${ext}`;
        break;
      }
    }
    return candidate;
  }
}
