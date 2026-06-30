import { Injectable } from '@nestjs/common';
import { CertType, ExamPart, ExamSessionStatus, Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../../common/prisma.service';

export interface ReportFilter {
  certType?: CertType;
  level?: 'L1' | 'L2' | 'L3';
  year?: number;
  roundNumber?: number;
  from?: string;
  to?: string;
}

export interface GeneratedFile {
  buffer: Buffer;
  fileName: string;
  contentType: string;
}

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_MIME = 'application/pdf';

@Injectable()
export class AdminReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────────────────
  // Round dropdown source — distinct (year, round) combos that
  // actually have schedules, newest first.
  // ──────────────────────────────────────────────────────────
  async rounds() {
    const schedules = await this.prisma.examSchedule.findMany({
      select: { year: true, roundNumber: true },
      orderBy: [{ year: 'desc' }, { roundNumber: 'desc' }],
    });
    const seen = new Set<string>();
    const out: { value: string; label: string; year: number; roundNumber: number }[] = [];
    for (const s of schedules) {
      const key = `${s.year}-${s.roundNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        value: key,
        label: `${s.year} · Round ${s.roundNumber}`,
        year: s.year,
        roundNumber: s.roundNumber,
      });
    }
    return out;
  }

  // ──────────────────────────────────────────────────────────
  // Pass List (Excel) — graded sessions that passed.
  // ──────────────────────────────────────────────────────────
  async passList(filter: ReportFilter): Promise<GeneratedFile> {
    const where = await this.sessionWhere(filter);
    const sessions = await this.prisma.examSession.findMany({
      where: { ...where, status: ExamSessionStatus.GRADED, passed: true },
      orderBy: { submittedAt: 'desc' },
      include: { user: { select: { name: true, userId: true } } },
    });
    const regMap = await this.regNumberMap(sessions.map((s) => s.registrationId));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pass List');
    ws.columns = [
      { header: 'Reg. No', key: 'reg', width: 18 },
      { header: 'User ID', key: 'uid', width: 18 },
      { header: 'Name', key: 'name', width: 16 },
      { header: 'Cert', key: 'cert', width: 10 },
      { header: 'Level', key: 'level', width: 8 },
      { header: 'Written', key: 'written', width: 10 },
      { header: 'Practical', key: 'practical', width: 10 },
      { header: 'Total', key: 'total', width: 10 },
      { header: 'Result', key: 'result', width: 10 },
      { header: 'Submitted', key: 'submitted', width: 20 },
    ];
    this.styleHeader(ws);

    for (const s of sessions) {
      ws.addRow({
        reg: regMap.get(s.registrationId ?? '') ?? '—',
        uid: s.user.userId,
        name: s.user.name,
        cert: this.certLabel(s.certType),
        level: s.level,
        written: s.writtenScore ?? '—',
        practical: s.practicalScore ?? '—',
        total: s.totalScore ?? '—',
        result: 'PASS',
        submitted: this.fmtDate(s.submittedAt),
      });
    }
    this.addSummaryFooter(ws, `Total passed: ${sessions.length}`);

    return this.xlsx(wb, this.fileName('pass-list', filter));
  }

  // ──────────────────────────────────────────────────────────
  // Grading Status (Excel) — every session + where it sits.
  // ──────────────────────────────────────────────────────────
  async gradingStatus(filter: ReportFilter): Promise<GeneratedFile> {
    const where = await this.sessionWhere(filter);
    const sessions = await this.prisma.examSession.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true, userId: true } } },
    });
    const regMap = await this.regNumberMap(sessions.map((s) => s.registrationId));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Grading Status');
    ws.columns = [
      { header: 'Reg. No', key: 'reg', width: 18 },
      { header: 'User ID', key: 'uid', width: 18 },
      { header: 'Name', key: 'name', width: 16 },
      { header: 'Cert', key: 'cert', width: 10 },
      { header: 'Level', key: 'level', width: 8 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Written', key: 'written', width: 10 },
      { header: 'Practical', key: 'practical', width: 10 },
      { header: 'Total', key: 'total', width: 10 },
      { header: 'Passed', key: 'passed', width: 10 },
      { header: 'Submitted', key: 'submitted', width: 20 },
    ];
    this.styleHeader(ws);

    const counts: Record<string, number> = {};
    for (const s of sessions) {
      counts[s.status] = (counts[s.status] ?? 0) + 1;
      ws.addRow({
        reg: regMap.get(s.registrationId ?? '') ?? '—',
        uid: s.user.userId,
        name: s.user.name,
        cert: this.certLabel(s.certType),
        level: s.level,
        status: s.status,
        written: s.writtenScore ?? '—',
        practical: s.practicalScore ?? '—',
        total: s.totalScore ?? '—',
        passed: s.passed == null ? '—' : s.passed ? 'PASS' : 'FAIL',
        submitted: this.fmtDate(s.submittedAt),
      });
    }
    const breakdown = Object.entries(counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join('   ');
    this.addSummaryFooter(ws, `Total: ${sessions.length}    ${breakdown}`);

    return this.xlsx(wb, this.fileName('grading-status', filter));
  }

  // ──────────────────────────────────────────────────────────
  // Item Analysis (Excel) — subject averages + practical tasks.
  // ──────────────────────────────────────────────────────────
  async itemAnalysis(filter: ReportFilter): Promise<GeneratedFile> {
    const where = await this.sessionWhere(filter);
    const sessionIds = (
      await this.prisma.examSession.findMany({
        where: { ...where, status: ExamSessionStatus.GRADED },
        select: { id: true },
      })
    ).map((s) => s.id);

    type ResultRow = { subjectName: string; part: ExamPart; percentage: number; subjectFailed: boolean };
    type EssayRow = { taskId: string; earnedPoints: number | null; aiPreScore: number | null; expertScore: number | null };

    const [results, essays] = await Promise.all([
      sessionIds.length
        ? this.prisma.gradingResult.findMany({
            where: { sessionId: { in: sessionIds } },
            select: { subjectName: true, part: true, percentage: true, subjectFailed: true },
          })
        : Promise.resolve([] as ResultRow[]),
      sessionIds.length
        ? this.prisma.essayAnswer.findMany({
            where: { sessionId: { in: sessionIds } },
            select: { taskId: true, earnedPoints: true, aiPreScore: true, expertScore: true },
          })
        : Promise.resolve([] as EssayRow[]),
    ]);

    const wb = new ExcelJS.Workbook();

    // Sheet 1 — written subjects
    const ws1 = wb.addWorksheet('Subjects');
    ws1.columns = [
      { header: 'Subject', key: 'subject', width: 32 },
      { header: 'Graded count', key: 'n', width: 14 },
      { header: 'Avg %', key: 'avg', width: 10 },
      { header: 'Fail count', key: 'fail', width: 12 },
      { header: 'Fail rate %', key: 'failRate', width: 12 },
    ];
    this.styleHeader(ws1);

    const subj = new Map<string, { sum: number; n: number; fail: number }>();
    for (const r of results.filter((x) => x.part === ExamPart.WRITTEN)) {
      const a = subj.get(r.subjectName) ?? { sum: 0, n: 0, fail: 0 };
      a.sum += r.percentage;
      a.n += 1;
      if (r.subjectFailed) a.fail += 1;
      subj.set(r.subjectName, a);
    }
    for (const [name, a] of subj) {
      ws1.addRow({
        subject: name,
        n: a.n,
        avg: a.n ? Math.round((a.sum / a.n) * 10) / 10 : 0,
        fail: a.fail,
        failRate: a.n ? Math.round((a.fail / a.n) * 1000) / 10 : 0,
      });
    }

    // Sheet 2 — practical tasks (AI vs expert)
    const ws2 = wb.addWorksheet('Practical Tasks');
    ws2.columns = [
      { header: 'Task', key: 'task', width: 36 },
      { header: 'Answered', key: 'n', width: 12 },
      { header: 'Avg earned', key: 'avg', width: 12 },
      { header: 'Avg AI score', key: 'ai', width: 14 },
      { header: 'Avg expert score', key: 'expert', width: 16 },
    ];
    this.styleHeader(ws2);

    const taskIds = [...new Set(essays.map((e) => e.taskId))];
    const templates = taskIds.length
      ? await this.prisma.taskTemplate.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, title: true },
        })
      : [];
    const titleById = new Map(templates.map((t) => [t.id, t.title]));

    const task = new Map<
      string,
      { earnedSum: number; aiSum: number; aiN: number; expSum: number; expN: number; n: number }
    >();
    for (const e of essays) {
      const a =
        task.get(e.taskId) ?? { earnedSum: 0, aiSum: 0, aiN: 0, expSum: 0, expN: 0, n: 0 };
      if (e.earnedPoints != null) {
        a.earnedSum += e.earnedPoints;
        a.n += 1;
      }
      if (e.aiPreScore != null) {
        a.aiSum += e.aiPreScore;
        a.aiN += 1;
      }
      if (e.expertScore != null) {
        a.expSum += e.expertScore;
        a.expN += 1;
      }
      task.set(e.taskId, a);
    }
    for (const [id, a] of task) {
      ws2.addRow({
        task: titleById.get(id) ?? id,
        n: a.n,
        avg: a.n ? Math.round((a.earnedSum / a.n) * 10) / 10 : 0,
        ai: a.aiN ? Math.round((a.aiSum / a.aiN) * 10) / 10 : '—',
        expert: a.expN ? Math.round((a.expSum / a.expN) * 10) / 10 : '—',
      });
    }

    return this.xlsx(wb, this.fileName('item-analysis', filter));
  }

  // ──────────────────────────────────────────────────────────
  // Custom Report (Excel) — field-driven examinee export.
  // ──────────────────────────────────────────────────────────
  async custom(filter: ReportFilter, fields: string[]): Promise<GeneratedFile> {
    const want = new Set(
      (fields.length ? fields : ['examinees', 'scores', 'results']).map((f) => f.toLowerCase()),
    );

    const where = await this.sessionWhere(filter);
    const sessions = await this.prisma.examSession.findMany({
      where,
      orderBy: { submittedAt: 'desc' },
      include: { user: { select: { name: true, userId: true } } },
    });
    const regMap = await this.regNumberMap(sessions.map((s) => s.registrationId));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Custom Report');

    const cols: Partial<ExcelJS.Column>[] = [];
    if (want.has('examinees')) {
      cols.push(
        { header: 'Reg. No', key: 'reg', width: 18 },
        { header: 'User ID', key: 'uid', width: 18 },
        { header: 'Name', key: 'name', width: 16 },
        { header: 'Cert', key: 'cert', width: 10 },
        { header: 'Level', key: 'level', width: 8 },
      );
    }
    if (want.has('scores')) {
      cols.push(
        { header: 'Written', key: 'written', width: 10 },
        { header: 'Practical', key: 'practical', width: 10 },
        { header: 'Total', key: 'total', width: 10 },
      );
    }
    if (want.has('results')) {
      cols.push(
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Result', key: 'result', width: 10 },
        { header: 'Submitted', key: 'submitted', width: 20 },
      );
    }
    // Guarantee at least an identifier column.
    if (!cols.length) cols.push({ header: 'User ID', key: 'uid', width: 18 });
    ws.columns = cols;
    this.styleHeader(ws);

    for (const s of sessions) {
      ws.addRow({
        reg: regMap.get(s.registrationId ?? '') ?? '—',
        uid: s.user.userId,
        name: s.user.name,
        cert: this.certLabel(s.certType),
        level: s.level,
        written: s.writtenScore ?? '—',
        practical: s.practicalScore ?? '—',
        total: s.totalScore ?? '—',
        status: s.status,
        result: s.passed == null ? '—' : s.passed ? 'PASS' : 'FAIL',
        submitted: this.fmtDate(s.submittedAt),
      });
    }
    this.addSummaryFooter(
      ws,
      `Rows: ${sessions.length}    Period: ${filter.from ?? '—'} ~ ${filter.to ?? '—'}`,
    );

    return this.xlsx(wb, this.fileName('custom-report', filter));
  }

  // ──────────────────────────────────────────────────────────
  // Round Comprehensive (PDF) — aggregate one-pager.
  // ──────────────────────────────────────────────────────────
  async roundComprehensive(filter: ReportFilter): Promise<GeneratedFile> {
    const where = await this.sessionWhere(filter);

    const [registered, sessions, gradingResults] = await Promise.all([
      this.prisma.registration.count({ where: this.registrationWhere(filter) }),
      this.prisma.examSession.findMany({
        where,
        select: { status: true, passed: true, certType: true },
      }),
      this.gradingResultsForFilter(filter, where),
    ]);

    const graded = sessions.filter((s) => s.status === ExamSessionStatus.GRADED);
    const passed = graded.filter((s) => s.passed).length;
    const passRate = graded.length ? Math.round((passed / graded.length) * 1000) / 10 : 0;

    const byCert: Record<string, { graded: number; passed: number }> = {};
    for (const c of [CertType.AXIS, CertType.AXIS_C, CertType.AXIS_H]) {
      byCert[c] = { graded: 0, passed: 0 };
    }
    for (const s of sessions) {
      const b = byCert[s.certType];
      if (!b) continue;
      if (s.status === ExamSessionStatus.GRADED) {
        b.graded += 1;
        if (s.passed) b.passed += 1;
      }
    }

    const subj = new Map<string, { sum: number; n: number }>();
    for (const r of gradingResults) {
      const a = subj.get(r.subjectName) ?? { sum: 0, n: 0 };
      a.sum += r.percentage;
      a.n += 1;
      subj.set(r.subjectName, a);
    }

    const buffer = await this.renderPdf((doc) => {
      doc.fontSize(20).fillColor('#0f172a').text('Round Comprehensive Report', { align: 'left' });
      doc.moveDown(0.3);
      doc
        .fontSize(10)
        .fillColor('#64748b')
        .text(this.scopeLine(filter))
        .text(`Generated: ${this.fmtDate(new Date())}`);
      doc.moveDown(1);

      this.pdfSection(doc, 'Summary');
      this.pdfKeyVals(doc, [
        ['Registered', String(registered)],
        ['Sessions started', String(sessions.length)],
        ['Graded', String(graded.length)],
        ['Passed', String(passed)],
        ['Pass rate', `${passRate}%`],
      ]);

      this.pdfSection(doc, 'By certification');
      this.pdfTable(
        doc,
        ['Cert', 'Graded', 'Passed', 'Pass rate'],
        Object.entries(byCert).map(([cert, b]) => [
          this.certLabel(cert as CertType),
          String(b.graded),
          String(b.passed),
          b.graded ? `${Math.round((b.passed / b.graded) * 1000) / 10}%` : '—',
        ]),
      );

      this.pdfSection(doc, 'Subject averages (written)');
      const subjRows = [...subj.entries()].map(([name, a]) => [
        name,
        `${a.n ? Math.round((a.sum / a.n) * 10) / 10 : 0}%`,
      ]);
      if (subjRows.length) {
        this.pdfTable(doc, ['Subject', 'Avg %'], subjRows);
      } else {
        doc.fontSize(10).fillColor('#94a3b8').text('No graded subject data yet.');
      }
    });

    return {
      buffer,
      fileName: this.fileName('round-comprehensive', filter, 'pdf'),
      contentType: PDF_MIME,
    };
  }

  // ──────────────────────────────────────────────────────────
  // shared query builders
  //
  // NOTE: ExamSession has no Prisma `registration` relation — only a loose
  // `registrationId`. Round/year scoping therefore resolves matching
  // registration ids first, then constrains sessions to that id set.
  // ──────────────────────────────────────────────────────────
  private async sessionWhere(f: ReportFilter): Promise<Prisma.ExamSessionWhereInput> {
    const where: Prisma.ExamSessionWhereInput = {};
    if (f.certType) where.certType = f.certType;
    if (f.level) where.level = f.level;
    if (f.from || f.to) {
      where.submittedAt = {};
      if (f.from) (where.submittedAt as Prisma.DateTimeFilter).gte = new Date(f.from);
      if (f.to) (where.submittedAt as Prisma.DateTimeFilter).lte = this.endOfDay(f.to);
    }
    if (f.year || f.roundNumber) {
      const regs = await this.prisma.registration.findMany({
        where: this.registrationWhere(f),
        select: { id: true },
      });
      where.registrationId = { in: regs.length ? regs.map((r) => r.id) : ['__none__'] };
    }
    return where;
  }

  private registrationWhere(f: ReportFilter): Prisma.RegistrationWhereInput {
    const where: Prisma.RegistrationWhereInput = {};
    if (f.certType) where.certType = f.certType;
    if (f.level) where.level = f.level;
    if (f.year || f.roundNumber) {
      where.schedule = {
        ...(f.year ? { year: f.year } : {}),
        ...(f.roundNumber ? { roundNumber: f.roundNumber } : {}),
      };
    }
    if (f.from || f.to) {
      where.createdAt = {};
      if (f.from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(f.from);
      if (f.to) (where.createdAt as Prisma.DateTimeFilter).lte = this.endOfDay(f.to);
    }
    return where;
  }

  private async gradingResultsForFilter(
    f: ReportFilter,
    where: Prisma.ExamSessionWhereInput,
  ) {
    const sessionIds = (
      await this.prisma.examSession.findMany({
        where: { ...where, status: ExamSessionStatus.GRADED },
        select: { id: true },
      })
    ).map((s) => s.id);
    if (!sessionIds.length) return [] as { subjectName: string; percentage: number }[];
    return this.prisma.gradingResult.findMany({
      where: { sessionId: { in: sessionIds }, part: ExamPart.WRITTEN },
      select: { subjectName: true, percentage: true },
    });
  }

  private async regNumberMap(ids: (string | null)[]): Promise<Map<string, string>> {
    const real = [...new Set(ids.filter((x): x is string => !!x))];
    if (!real.length) return new Map();
    const regs = await this.prisma.registration.findMany({
      where: { id: { in: real } },
      select: { id: true, registrationNumber: true },
    });
    return new Map(regs.map((r) => [r.id, r.registrationNumber ?? '—']));
  }

  // ──────────────────────────────────────────────────────────
  // excel / pdf plumbing
  // ──────────────────────────────────────────────────────────
  private async xlsx(wb: ExcelJS.Workbook, fileName: string): Promise<GeneratedFile> {
    const data = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(data), fileName, contentType: XLSX_MIME };
  }

  private styleHeader(ws: ExcelJS.Worksheet) {
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };
    header.alignment = { vertical: 'middle' };
    header.height = 20;
  }

  private addSummaryFooter(ws: ExcelJS.Worksheet, text: string) {
    ws.addRow([]);
    const row = ws.addRow([text]);
    row.font = { italic: true, color: { argb: 'FF64748B' } };
  }

  private renderPdf(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      try {
        draw(doc);
      } catch (err) {
        reject(err as Error);
        return;
      }
      doc.end();
    });
  }

  private pdfSection(doc: PDFKit.PDFDocument, title: string) {
    doc.moveDown(0.8);
    doc.fontSize(13).fillColor('#1e293b').text(title);
    const y = doc.y + 2;
    doc.moveTo(48, y).lineTo(547, y).strokeColor('#e2e8f0').lineWidth(1).stroke();
    doc.moveDown(0.5);
  }

  private pdfKeyVals(doc: PDFKit.PDFDocument, rows: [string, string][]) {
    doc.fontSize(10);
    for (const [k, v] of rows) {
      const y = doc.y;
      doc.fillColor('#64748b').text(k, 48, y, { width: 200, continued: false });
      doc.fillColor('#0f172a').text(v, 248, y);
    }
  }

  private pdfTable(doc: PDFKit.PDFDocument, headers: string[], rows: string[][]) {
    const startX = 48;
    const usable = 499;
    const colW = usable / headers.length;
    let y = doc.y;
    doc.fontSize(10).fillColor('#475569');
    headers.forEach((h, i) => doc.text(h, startX + i * colW, y, { width: colW - 6 }));
    y = doc.y + 2;
    doc.moveTo(startX, y).lineTo(startX + usable, y).strokeColor('#e2e8f0').stroke();
    doc.fillColor('#0f172a');
    for (const row of rows) {
      y = doc.y + 4;
      row.forEach((cell, i) => doc.text(cell, startX + i * colW, y, { width: colW - 6 }));
    }
    doc.moveDown(0.5);
  }

  // ──────────────────────────────────────────────────────────
  // small helpers
  // ──────────────────────────────────────────────────────────
  private scopeLine(f: ReportFilter): string {
    const parts: string[] = [];
    parts.push(f.certType ? this.certLabel(f.certType) : 'All certs');
    parts.push(f.level ?? 'All levels');
    if (f.year || f.roundNumber) {
      parts.push(`${f.year ?? ''}${f.roundNumber ? ` Round ${f.roundNumber}` : ''}`.trim());
    }
    if (f.from || f.to) parts.push(`${f.from ?? '…'} ~ ${f.to ?? '…'}`);
    return parts.join('  ·  ');
  }

  private fileName(base: string, f: ReportFilter, ext = 'xlsx'): string {
    const bits = [base];
    if (f.certType) bits.push(this.certLabel(f.certType));
    if (f.level) bits.push(f.level);
    if (f.roundNumber) bits.push(`R${f.roundNumber}`);
    return `${bits.join('_')}.${ext}`;
  }

  private certLabel(c: CertType): string {
    return c === CertType.AXIS ? 'AXIS' : c === CertType.AXIS_C ? 'AXIS-C' : 'AXIS-H';
  }

  private fmtDate(d: Date | null | undefined): string {
    if (!d) return '—';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  private endOfDay(s: string): Date {
    const d = new Date(s);
    // If the caller passed a bare date (YYYY-MM-DD), include the whole day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) d.setHours(23, 59, 59, 999);
    return d;
  }
}
