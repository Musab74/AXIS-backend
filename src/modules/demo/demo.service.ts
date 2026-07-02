import { BadRequestException, Injectable } from '@nestjs/common';
import { CertLevel, CertType } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma.service';

const DEMO_QUESTION_COUNT = 5;
const DEMO_DURATION_MIN = 15;
const DEMO_CERT_VALIDITY_YEARS = 3;

export interface DemoChoice {
  key: string;
  text: string;
}

export interface DemoQuestion {
  id: string;
  stem: string;
  choices: DemoChoice[];
  subjectName: string;
  points: number;
}

export interface DemoPracticalTask {
  id: string;
  title: string;
  scenario: string;
  durationMin: number;
  points: number;
  /**
   * Canonical practice type for L3 실습형 stratified picking. One of
   * `현업적용형` / `지시설계형` / `분석검증형` / `리스크판단형`. `null` for
   * legacy L1/L2 tasks that predate the taxonomy.
   */
  taskType: string | null;
}

const L3_CANONICAL_TYPES = ['현업적용형', '지시설계형', '분석검증형', '리스크판단형'] as const;

/** CSV seeds store slugs like `l3_verify`; API returns canonical Korean labels. */
function normalizeL3TaskType(raw: string | null | undefined, title?: string): string | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  if ((L3_CANONICAL_TYPES as readonly string[]).includes(value)) return value;

  const slug = value.toLowerCase();
  if (slug === 'l3_apply' || slug.includes('apply') || slug.includes('work')) return '현업적용형';
  if (slug === 'l3_prompt' || slug.includes('prompt') || slug.includes('design')) return '지시설계형';
  if (slug === 'l3_verify' || slug.includes('verify') || slug.includes('analysis')) return '분석검증형';
  if (slug === 'l3_risk' || slug.includes('risk')) return '리스크판단형';

  if (title) {
    const compact = title.replace(/[·\s]/g, '');
    if (compact.includes('현업적용')) return '현업적용형';
    if (compact.includes('지시설계')) return '지시설계형';
    if (compact.includes('분석') || compact.includes('검증')) return '분석검증형';
    if (compact.includes('리스크')) return '리스크판단형';
  }

  return value;
}

function mapTaskToDemoPractical(t: {
  id: string;
  title: string;
  scenario: string;
  durationMin: number;
  points: number;
  taskType: string | null;
}): DemoPracticalTask {
  return {
    id: t.id,
    title: t.title,
    scenario: t.scenario,
    durationMin: t.durationMin,
    points: t.points,
    taskType: normalizeL3TaskType(t.taskType, t.title),
  };
}

@Injectable()
export class DemoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Public — picks a random subset of MCQs from the bank for the given cert+level.
   * Returns NO answer keys. The client posts back the chosen answers and we grade.
   */
  async getDemoPaper(certType: CertType, level: CertLevel) {
    const all = await this.prisma.questionBank.findMany({
      where: { certType, level, type: 'MCQ', active: true },
      select: {
        id: true,
        stem: true,
        choices: true,
        subjectName: true,
        points: true,
      },
    });
    if (all.length === 0) {
      throw new BadRequestException('No demo questions available for this exam.');
    }

    const shuffled = [...all].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(DEMO_QUESTION_COUNT, shuffled.length));

    const questions: DemoQuestion[] = picked.map((q) => ({
      id: q.id,
      stem: q.stem,
      choices: (q.choices as unknown as DemoChoice[]) ?? [],
      subjectName: q.subjectName,
      points: q.points,
    }));

    // 실습 — 채점하지 않고 "실제 시험과 동일한 형태"만 보여주기 위한 용도.
    // 모든 레벨(L3/L2/L1) 공통: 대표 실습 1개만 노출한다.
    const tasks = await this.prisma.taskTemplate.findMany({
      where: { certType, level },
      select: {
        id: true,
        title: true,
        scenario: true,
        durationMin: true,
        points: true,
        taskType: true,
      },
    });

    const practicalTasks: DemoPracticalTask[] = [];
    if (tasks.length > 0) {
      const t = tasks[Math.floor(Math.random() * tasks.length)];
      practicalTasks.push(mapTaskToDemoPractical(t));
    }

    // Deprecated single-task alias kept for one release so older shipped
    // frontends continue to render the first practical slot; new clients
    // should read `practicalTasks` (array).
    const practicalTask: DemoPracticalTask | null = practicalTasks[0] ?? null;

    return {
      certType,
      level,
      durationMin: DEMO_DURATION_MIN,
      questions,
      practicalTask,
      practicalTasks,
    };
  }

  /**
   * Stateless 데모 자격증 발급. DB 에 저장하지 않고, `DEMO-` 접두사로 시작하는
   * 자격증 번호와 보유자 정보만 반환. 공개 검증 엔드포인트는 이 접두사를
   * 보면 DB 조회 전에 'demo' 응답을 즉시 돌려줍니다.
   */
  async issueDemoCertificate(userId: string, certType: CertType, level: CertLevel) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    if (!user) {
      throw new BadRequestException('User not found.');
    }
    const issuedAt = new Date();
    const validUntil = new Date(issuedAt);
    validUntil.setFullYear(validUntil.getFullYear() + DEMO_CERT_VALIDITY_YEARS);
    const typePart = certType.replace('AXIS_', 'AXIS-');
    const year = issuedAt.getFullYear();
    const rand = randomBytes(3).toString('hex').toUpperCase();
    const certNumber = `DEMO-${typePart}-${level}-${year}-${rand}`;
    return {
      certNumber,
      certType,
      level,
      holderName: user.name,
      issuedAt: issuedAt.toISOString(),
      validUntil: validUntil.toISOString(),
    };
  }

  /**
   * Public — grades a demo submission against the question-bank correct answers.
   * No persistence. Returns score breakdown and per-question correctness so the
   * client can render a review screen.
   */
  async gradeDemo(input: {
    certType: CertType;
    level: CertLevel;
    answers: { questionId: string; selectedChoice: string | null }[];
  }) {
    const ids = input.answers.map((a) => a.questionId);
    const bank = await this.prisma.questionBank.findMany({
      where: { id: { in: ids }, certType: input.certType, level: input.level },
      select: {
        id: true,
        correctAnswer: true,
        subjectName: true,
        points: true,
        stem: true,
        choices: true,
      },
    });
    const bankById = new Map(bank.map((q) => [q.id, q]));

    let totalEarned = 0;
    let totalPossible = 0;
    const subjectAgg = new Map<string, { earned: number; total: number }>();

    const breakdown = input.answers.map((a) => {
      const q = bankById.get(a.questionId);
      if (!q) {
        return {
          questionId: a.questionId,
          stem: '(unknown question)',
          subjectName: '—',
          selectedChoice: a.selectedChoice,
          correctAnswer: null as string | null,
          isCorrect: false,
          earned: 0,
          points: 0,
          choices: [] as DemoChoice[],
        };
      }
      const isCorrect = a.selectedChoice != null && a.selectedChoice === q.correctAnswer;
      const earned = isCorrect ? q.points : 0;
      totalEarned += earned;
      totalPossible += q.points;
      const agg = subjectAgg.get(q.subjectName) ?? { earned: 0, total: 0 };
      agg.earned += earned;
      agg.total += q.points;
      subjectAgg.set(q.subjectName, agg);
      return {
        questionId: q.id,
        stem: q.stem,
        subjectName: q.subjectName,
        selectedChoice: a.selectedChoice,
        correctAnswer: q.correctAnswer,
        isCorrect,
        earned,
        points: q.points,
        choices: (q.choices as unknown as DemoChoice[]) ?? [],
      };
    });

    const totalPct = totalPossible > 0 ? Math.round((totalEarned / totalPossible) * 100) : 0;
    const subjectBreakdown = [...subjectAgg.entries()].map(([name, agg]) => ({
      subjectName: name,
      earned: agg.earned,
      total: agg.total,
      percentage: agg.total > 0 ? Math.round((agg.earned / agg.total) * 100) : 0,
    }));

    return {
      certType: input.certType,
      level: input.level,
      totalEarned,
      totalPossible,
      totalPct,
      subjectBreakdown,
      breakdown,
    };
  }
}
