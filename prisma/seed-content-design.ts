/**
 * Initial notices & FAQ from New_design/10_고객센터.html (design mock).
 * Stable IDs → safe to re-run (`upsert`).
 */
import {
  PrismaClient,
  NoticeStatus,
  NoticeTagType,
  FaqCategory,
} from '@prisma/client';

const NOTICE_ROWS: Array<{
  id: string;
  tag: string;
  tagType: NoticeTagType;
  title: string;
  content: string;
  pinned: boolean;
  createdAt: Date;
}> = [
  {
    id: 'seed-design-notice-001',
    tag: '중요',
    tagType: NoticeTagType.IMPORTANT,
    title: '제1회 AXIS L3 시험 접수 안내',
    content:
      '제1회 AXIS L3 시험 접수 일정 및 방법을 안내드립니다.\n\n' +
      '접수는 axisexam.com 시험접수 메뉴에서 진행되며, 회차별 마감 일시를 반드시 확인해 주세요.\n' +
      '문의: 고객센터 1:1 문의 또는 support@axisexam.com',
    pinned: true,
    createdAt: new Date('2026-07-01T09:00:00+09:00'),
  },
  {
    id: 'seed-design-notice-002',
    tag: '공지',
    tagType: NoticeTagType.NORMAL,
    title: 'AXIS 검정 운영규정 안내',
    content:
      'AXIS 검정의 응시 자격, 시험 운영, 부정행위 처리, 성적 및 자격 관리 등에 관한 사항은 검정운영규정에 따릅니다.\n\n' +
      '자세한 내용은 홈페이지 내 「검정운영규정」 페이지를 참고해 주세요.',
    pinned: false,
    createdAt: new Date('2026-06-15T09:00:00+09:00'),
  },
  {
    id: 'seed-design-notice-003',
    tag: '안내',
    tagType: NoticeTagType.NORMAL,
    title: 'axisexam.com 사이트 오픈 안내',
    content:
      'AXIS 검정 공식 사이트 axisexam.com이 오픈되었습니다.\n\n' +
      '시험 접수, 응시, 합격자 발표, 자격검증 및 고객센터 기능을 이용하실 수 있습니다.',
    pinned: false,
    createdAt: new Date('2026-06-01T09:00:00+09:00'),
  },
  {
    id: 'seed-design-notice-004',
    tag: '안내',
    tagType: NoticeTagType.NORMAL,
    title: 'AXIS 시리즈 자격검정 소개',
    content:
      'AXIS 시리즈는 범용 AI 실무역량(AXIS), 코딩·자동화(AXIS-C), 의료기관 특화(AXIS-H) 자격으로 구성되어 있습니다.\n\n' +
      '각 자격별 등급(L3·L2·L1)과 응시 형식은 자격안내 페이지에서 확인하실 수 있습니다.',
    pinned: false,
    createdAt: new Date('2026-05-20T09:00:00+09:00'),
  },
  {
    id: 'seed-design-notice-005',
    tag: '공지',
    tagType: NoticeTagType.NORMAL,
    title: '온라인 시험(CBT) 응시 환경 안내',
    content:
      '온라인 시험은 PC(데스크톱/노트북)와 안정적인 인터넷, 카메라·마이크, 최신 Chrome 브라우저 사용을 권장합니다.\n\n' +
      '듀얼 모니터 및 모바일 응시는 지원되지 않을 수 있으니 사전에 환경 점검을 해 주세요.',
    pinned: false,
    createdAt: new Date('2026-05-15T09:00:00+09:00'),
  },
  {
    id: 'seed-design-notice-006',
    tag: '안내',
    tagType: NoticeTagType.NORMAL,
    title: 'AXIS 자격 유효기간 및 갱신 안내',
    content:
      'AXIS 자격은 취득일로부터 3년간 유효합니다.\n\n' +
      '갱신은 상위 등급 취득 또는 무상 보수교육 이수 등의 절차에 따라 가능합니다. 세부 사항은 FAQ를 참고해 주세요.',
    pinned: false,
    createdAt: new Date('2026-05-10T09:00:00+09:00'),
  },
];

const FAQ_ROWS: Array<{
  id: string;
  category: FaqCategory;
  question: string;
  answer: string;
  sortOrder: number;
}> = [
  {
    id: 'seed-design-faq-001',
    category: FaqCategory.REGISTRATION,
    question: '코딩을 못해도 AXIS에 응시할 수 있나요?',
    answer:
      '네. AXIS는 코딩이 필요 없는 범용 자격입니다. 코딩 기반 시험은 AXIS-C입니다.',
    sortOrder: 1,
  },
  {
    id: 'seed-design-faq-002',
    category: FaqCategory.REGISTRATION,
    question: 'L3부터 순서대로 취득해야 하나요?',
    answer: '아닙니다. 등급별 독립 응시가 가능합니다. (L1은 L2 취득 후 권장)',
    sortOrder: 2,
  },
  {
    id: 'seed-design-faq-003',
    category: FaqCategory.EXAM,
    question: '모바일에서 시험을 볼 수 있나요?',
    answer:
      '아닙니다. PC(데스크톱/노트북) 환경에서만 응시할 수 있습니다. 카메라와 마이크가 필요합니다.',
    sortOrder: 10,
  },
  {
    id: 'seed-design-faq-004',
    category: FaqCategory.EXAM,
    question: '시험 중 인터넷이 끊기면 어떻게 되나요?',
    answer:
      '일시적 끊김 시 자동 저장 및 재접속이 지원됩니다. 장시간 끊김은 시험에 영향을 줄 수 있으므로 안정적인 네트워크 환경을 준비해 주세요.',
    sortOrder: 11,
  },
  {
    id: 'seed-design-faq-005',
    category: FaqCategory.EXAM,
    question: '본인인증에 실패하면 어떻게 하나요?',
    answer:
      '본인 명의 휴대폰으로 NICE 인증을 진행해야 합니다. 인증이 반복 실패하는 경우 고객센터로 문의해 주세요.',
    sortOrder: 12,
  },
  {
    id: 'seed-design-faq-006',
    category: FaqCategory.EXAM,
    question: '신분증 OCR 인식이 되지 않으면 어떻게 하나요?',
    answer:
      '빛 반사, 흐림, 일부 가림이 있는 경우 인식이 제한될 수 있습니다. 신분증 전체가 선명하게 보이도록 촬영해 주세요.',
    sortOrder: 13,
  },
  {
    id: 'seed-design-faq-007',
    category: FaqCategory.EXAM,
    question: '카메라 또는 마이크 권한이 차단되었습니다.',
    answer:
      '브라우저 주소창의 권한 설정에서 카메라와 마이크 접근을 허용한 뒤 다시 입장해 주세요. Chrome 최신 버전 사용을 권장합니다.',
    sortOrder: 14,
  },
  {
    id: 'seed-design-faq-008',
    category: FaqCategory.EXAM,
    question: '화면을 벗어나면 바로 무효 처리되나요?',
    answer:
      'AXIS는 3스트라이크 가중치 시스템을 적용합니다. 위반 유형별 가중치(×1 또는 ×2)가 부여되며, 총 가중치 합이 3에 도달하면 시험이 종료됩니다. 일시적 이탈 1회(×1)만으로는 즉시 종료되지 않지만, 반복되면 종료될 수 있습니다. 마이크 연결 해제, 얼굴 불일치 등은 별도로 즉시 종료됩니다.',
    sortOrder: 15,
  },
  {
    id: 'seed-design-faq-009',
    category: FaqCategory.EXAM,
    question: '듀얼 모니터를 사용해도 되나요?',
    answer:
      '아닙니다. 외부 디스플레이(듀얼 모니터)가 연결되어 있으면 시험 UI가 차단됩니다. 시험 전에 추가 모니터를 분리해 주세요.',
    sortOrder: 16,
  },
  {
    id: 'seed-design-faq-010',
    category: FaqCategory.EXAM,
    question: '화면 공유는 꼭 해야 하나요?',
    answer:
      '네. 시험 시작 시 전체 모니터 화면 공유가 필수입니다. 단일 앱이나 탭만 공유하는 것은 허용되지 않으며, 화면 공유를 거부하면 시험에 진입할 수 없습니다.',
    sortOrder: 17,
  },
  {
    id: 'seed-design-faq-011',
    category: FaqCategory.REGISTRATION,
    question: '몇 번까지 응시할 수 있나요?',
    answer:
      '동일 (사용자·자격 유형·등급) 조합 기준으로 최초 응시 1회와 재응시 2회까지 가능합니다. 이후에는 새로운 접수가 필요합니다.',
    sortOrder: 3,
  },
  {
    id: 'seed-design-faq-012',
    category: FaqCategory.PASS,
    question: '성적은 언제 발표되나요?',
    answer:
      '시험 종료 후 L3는 1시간 이내, L2는 3일 이내, L1은 7일 이내에 공개됩니다. (L3 자동채점 / L2·L1 전문가 검수)',
    sortOrder: 20,
  },
  {
    id: 'seed-design-faq-013',
    category: FaqCategory.PASS,
    question: '자격증 유효기간이 있나요?',
    answer:
      '취득일로부터 3년입니다. 갱신은 상위 등급 취득 또는 무상 보수교육 이수로 가능합니다.',
    sortOrder: 21,
  },
  {
    id: 'seed-design-faq-014',
    category: FaqCategory.REFUND,
    question: '접수 취소 후 환불은 어떻게 되나요?',
    answer:
      '접수 마감 전: 전액 환불. 접수 마감 후~시험 7일 전: 50% 환불. 시험 6일 전 이후 또는 미응시: 환불 불가.',
    sortOrder: 30,
  },
];

export async function seedDesignContent(prisma: PrismaClient): Promise<void> {
  console.log('Seeding design notices & FAQ (New_design/10_고객센터.html)...');

  for (const n of NOTICE_ROWS) {
    await prisma.notice.upsert({
      where: { id: n.id },
      create: {
        id: n.id,
        tag: n.tag,
        tagType: n.tagType,
        title: n.title,
        content: n.content,
        status: NoticeStatus.PUBLISHED,
        pinned: n.pinned,
        views: 0,
        createdAt: n.createdAt,
      },
      update: {
        tag: n.tag,
        tagType: n.tagType,
        title: n.title,
        content: n.content,
        status: NoticeStatus.PUBLISHED,
        pinned: n.pinned,
        createdAt: n.createdAt,
      },
    });
  }

  for (const f of FAQ_ROWS) {
    await prisma.faq.upsert({
      where: { id: f.id },
      create: {
        id: f.id,
        category: f.category,
        question: f.question,
        answer: f.answer,
        sortOrder: f.sortOrder,
        pinned: false,
        published: true,
      },
      update: {
        category: f.category,
        question: f.question,
        answer: f.answer,
        sortOrder: f.sortOrder,
        published: true,
      },
    });
  }

  console.log(
    `  → ${NOTICE_ROWS.length} notices, ${FAQ_ROWS.length} FAQs (PUBLISHED / published)`,
  );
}

/** Standalone: `npm run db:seed:content` */
async function runStandalone(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seedDesignContent(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runStandalone().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
