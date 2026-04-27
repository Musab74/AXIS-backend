"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    console.log('Seeding certifications...');
    const axis = await prisma.certification.upsert({
        where: { type: client_1.CertType.AXIS },
        update: {},
        create: {
            type: client_1.CertType.AXIS,
            name: 'AXIS',
            nameKo: 'AXIS 일반',
            description: 'AI 실무 역량을 평가하는 일반 자격증입니다. 모든 직종의 전문가를 대상으로 AI를 활용하여 업무 결과물을 만들어낼 수 있는 역량을 검증합니다.',
            targetAudience: '모든 직종의 전문가 — "AI로 업무 결과물을 만들 수 있는가?"',
            subjects: ['AI 기초 이해', '프롬프트 엔지니어링', 'AI 도구 활용', '업무 적용 실무', '윤리와 보안'],
        },
    });
    await prisma.certificationLevel.upsert({
        where: { certId_level: { certId: axis.id, level: client_1.CertLevel.L3 } },
        update: {},
        create: {
            certId: axis.id,
            level: client_1.CertLevel.L3,
            format: 'CBT 객관식 (4지선다)',
            duration: 60,
            questionCount: 50,
            fee: 100000,
            passScore: 60,
            subjectBreakdown: { 'AI 기초 이해': 10, '프롬프트 엔지니어링': 10, 'AI 도구 활용': 15, '업무 적용 실무': 10, '윤리와 보안': 5 },
        },
    });
    await prisma.certificationLevel.upsert({
        where: { certId_level: { certId: axis.id, level: client_1.CertLevel.L2 } },
        update: {},
        create: {
            certId: axis.id,
            level: client_1.CertLevel.L2,
            format: 'CBT 객관식 + 실기 (AI 활용 과제)',
            duration: 120,
            questionCount: 40,
            fee: 150000,
            passScore: 60,
            subjectBreakdown: { '필기-AI 심화': 15, '필기-프롬프트 고급': 15, '필기-업무 적용': 10, '실기-AI 활용 과제': 1 },
        },
    });
    await prisma.certificationLevel.upsert({
        where: { certId_level: { certId: axis.id, level: client_1.CertLevel.L1 } },
        update: {},
        create: {
            certId: axis.id,
            level: client_1.CertLevel.L1,
            format: 'CBT 필기 + 실기 + 에세이',
            duration: 180,
            questionCount: 30,
            fee: 200000,
            passScore: 60,
            subjectBreakdown: { '필기-AI 전략': 10, '필기-조직 혁신': 10, '필기-윤리 거버넌스': 10, '실기-종합 프로젝트': 1, '에세이': 1 },
        },
    });
    const axisC = await prisma.certification.upsert({
        where: { type: client_1.CertType.AXIS_C },
        update: {},
        create: {
            type: client_1.CertType.AXIS_C,
            name: 'AXIS-C',
            nameKo: 'AXIS-C 코딩자동화',
            description: 'AI를 활용한 코딩 및 업무 자동화 역량을 평가합니다. AI 코딩 어시스턴트를 활용하여 동작하는 프로그램을 완성할 수 있는 능력을 검증합니다.',
            targetAudience: '개발자, 데이터 분석가, IT 직군 — "AI로 동작하는 프로그램을 완성할 수 있는가?"',
            subjects: ['프로그래밍 기초', 'AI 코딩 도구 활용', '코드 리뷰·디버깅', '자동화 설계', '보안·품질'],
        },
    });
    await prisma.certificationLevel.upsert({
        where: { certId_level: { certId: axisC.id, level: client_1.CertLevel.L3 } },
        update: {},
        create: {
            certId: axisC.id,
            level: client_1.CertLevel.L3,
            format: 'CBT 객관식 (4지선다)',
            duration: 60,
            questionCount: 50,
            fee: 100000,
            passScore: 60,
            subjectBreakdown: { '프로그래밍 기초': 10, 'AI 코딩 도구': 15, '코드 리뷰': 10, '자동화 설계': 10, '보안·품질': 5 },
        },
    });
    await prisma.certificationLevel.upsert({
        where: { certId_level: { certId: axisC.id, level: client_1.CertLevel.L2 } },
        update: {},
        create: {
            certId: axisC.id,
            level: client_1.CertLevel.L2,
            format: 'CBT 객관식 + 코드 실기 (Judge0 샌드박스)',
            duration: 120,
            questionCount: 40,
            fee: 150000,
            passScore: 60,
            subjectBreakdown: { '필기-AI 코딩 심화': 15, '필기-아키텍처': 15, '필기-자동화': 10, '실기-코드 과제': 1 },
        },
    });
    await prisma.certificationLevel.upsert({
        where: { certId_level: { certId: axisC.id, level: client_1.CertLevel.L1 } },
        update: {},
        create: {
            certId: axisC.id,
            level: client_1.CertLevel.L1,
            format: 'CBT 필기 + 코드 실기 + 에세이',
            duration: 180,
            questionCount: 30,
            fee: 200000,
            passScore: 60,
            subjectBreakdown: { '필기-시스템 설계': 10, '필기-AI 엔지니어링': 10, '필기-보안·거버넌스': 10, '실기-프로젝트': 1, '에세이': 1 },
        },
    });
    const axisH = await prisma.certification.upsert({
        where: { type: client_1.CertType.AXIS_H },
        update: {},
        create: {
            type: client_1.CertType.AXIS_H,
            name: 'AXIS-H',
            nameKo: 'AXIS-H 의료',
            description: '의료 분야에서 AI를 활용한 실무 혁신 역량을 평가합니다. 비임상 의료 직군을 대상으로 AI를 활용하여 병원 업무를 혁신할 수 있는 역량을 검증합니다.',
            targetAudience: '비임상 의료 직군 (행정, 원무, 간호관리, 데이터) — "AI로 병원 업무를 혁신할 수 있는가?"',
            subjects: ['의료 AI 기초', '의료 데이터 활용', 'AI 의료 도구', '의료 윤리·규제', '병원 업무 적용'],
        },
    });
    await prisma.certificationLevel.upsert({
        where: { certId_level: { certId: axisH.id, level: client_1.CertLevel.L3 } },
        update: {},
        create: {
            certId: axisH.id,
            level: client_1.CertLevel.L3,
            format: 'CBT 객관식 (4지선다)',
            duration: 60,
            questionCount: 50,
            fee: 100000,
            passScore: 60,
            subjectBreakdown: { '의료 AI 기초': 10, '의료 데이터': 10, 'AI 의료 도구': 15, '윤리·규제': 10, '병원 업무 적용': 5 },
        },
    });
    await prisma.certificationLevel.upsert({
        where: { certId_level: { certId: axisH.id, level: client_1.CertLevel.L2 } },
        update: {},
        create: {
            certId: axisH.id,
            level: client_1.CertLevel.L2,
            format: 'CBT 객관식 + 실기 (의료 AI 활용 과제)',
            duration: 120,
            questionCount: 40,
            fee: 150000,
            passScore: 60,
            subjectBreakdown: { '필기-의료 AI 심화': 15, '필기-데이터 분석': 15, '필기-규제·보안': 10, '실기-의료 AI 과제': 1 },
        },
    });
    await prisma.certificationLevel.upsert({
        where: { certId_level: { certId: axisH.id, level: client_1.CertLevel.L1 } },
        update: {},
        create: {
            certId: axisH.id,
            level: client_1.CertLevel.L1,
            format: 'CBT 필기 + 실기 + 에세이',
            duration: 180,
            questionCount: 30,
            fee: 200000,
            passScore: 60,
            subjectBreakdown: { '필기-의료 AI 전략': 10, '필기-병원 혁신': 10, '필기-거버넌스': 10, '실기-프로젝트': 1, '에세이': 1 },
        },
    });
    console.log('Seeded 3 certifications × 3 levels = 9 records');
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(() => prisma.$disconnect());
//# sourceMappingURL=seed.js.map