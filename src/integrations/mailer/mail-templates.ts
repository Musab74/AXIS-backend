/**
 * Transactional email bodies.
 *
 * Korean-only by design: `User` has no locale column, the product is Korean-first,
 * and a wrong-language receipt is worse than a Korean one. If a per-user locale is
 * ever added, `render()` is the single place to branch.
 *
 * Every template returns BOTH `html` and `text`. The plaintext part is not
 * optional politeness — Naver/Daum score HTML-only mail as spam, and this mail
 * carries exam deadlines that candidates cannot afford to miss.
 *
 * No external assets (no remote images, no web fonts): inlined CSS only, because
 * mail clients block remote content by default and a broken layout on a payment
 * receipt reads as a phishing attempt.
 */
import { EmailTemplate } from '@prisma/client';
import { formatDateKst, formatDateTimeKst } from '../../common/utils/date-kst.util';

const BRAND = 'AXIS';
const ORG_KO = '㈜아이넥스';

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/** Escape untrusted interpolations — names come from user input and land in HTML. */
function esc(v: string | number | null | undefined): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function won(amount: number): string {
  return `${amount.toLocaleString('ko-KR')}원`;
}

type Row = [label: string, value: string];

/** Shared shell: header bar, intro copy, a key/value table, optional CTA, footer. */
function layout(opts: {
  title: string;
  preheader: string;
  intro: string;
  rows: Row[];
  cta?: { label: string; url: string };
  outro?: string;
  accent: string;
}): { html: string; text: string } {
  const rowsHtml = opts.rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 0;color:#6b7280;font-size:14px;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
          <td style="padding:10px 0 10px 20px;color:#111827;font-size:14px;font-weight:600;text-align:right;">${esc(value)}</td>
        </tr>`,
    )
    .join('');

  const ctaHtml = opts.cta
    ? `<tr><td style="padding:28px 0 4px;">
         <a href="${esc(opts.cta.url)}"
            style="display:inline-block;background:${opts.accent};color:#ffffff;text-decoration:none;
                   padding:13px 28px;border-radius:8px;font-size:15px;font-weight:700;">${esc(opts.cta.label)}</a>
       </td></tr>`
    : '';

  const outroHtml = opts.outro
    ? `<tr><td style="padding:22px 0 0;color:#4b5563;font-size:14px;line-height:1.7;">${esc(opts.outro)}</td></tr>`
    : '';

  const html = `<!-- ${esc(opts.preheader)} -->
<div style="background:#f3f4f6;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic','맑은 고딕',sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
    <tr><td style="background:${opts.accent};padding:20px 32px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-0.3px;">${BRAND}</td></tr>
    <tr><td style="padding:32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        <tr><td style="padding:0 0 8px;color:#111827;font-size:20px;font-weight:800;line-height:1.4;">${esc(opts.title)}</td></tr>
        <tr><td style="padding:0 0 24px;color:#4b5563;font-size:15px;line-height:1.7;">${esc(opts.intro)}</td></tr>
        <tr><td style="border-top:1px solid #e5e7eb;padding:8px 0 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rowsHtml}</table>
        </td></tr>
        ${ctaHtml}
        ${outroHtml}
      </table>
    </td></tr>
    <tr><td style="background:#f9fafb;padding:20px 32px;color:#9ca3af;font-size:12px;line-height:1.6;border-top:1px solid #e5e7eb;">
      본 메일은 발신 전용입니다. 문의는 ${BRAND} 사이트의 1:1 문의를 이용해주세요.<br/>${ORG_KO}
    </td></tr>
  </table>
</div>`;

  const text = [
    `[${BRAND}] ${opts.title}`,
    '',
    opts.intro,
    '',
    ...opts.rows.map(([label, value]) => `- ${label}: ${value}`),
    ...(opts.cta ? ['', `${opts.cta.label}: ${opts.cta.url}`] : []),
    ...(opts.outro ? ['', opts.outro] : []),
    '',
    '─'.repeat(40),
    `본 메일은 발신 전용입니다. 문의는 ${BRAND} 사이트의 1:1 문의를 이용해주세요.`,
    ORG_KO,
  ].join('\n');

  return { html, text };
}

const BLUE = '#2563eb';
const RED = '#dc2626';
const AMBER = '#d97706';
const GRAY = '#4b5563';

/** Payload per template. Keep these flat — the crons build them from raw rows. */
export interface MailVars {
  name: string;
  /** e.g. "AXIS L2" */
  course?: string;
  amount?: number;
  orderId?: string;
  paidAt?: Date | string;
  examDeadline?: Date | string;
  scheduleDate?: Date | string;
  daysLeft?: number;
  reason?: string;
  certNumber?: string;
  validUntil?: Date | string;
  /** Absolute link back into the app; built from config.frontendUrl. */
  url?: string;
}

export function render(template: EmailTemplate, v: MailVars): RenderedMail {
  switch (template) {
    case 'PAYMENT_SUCCESS': {
      const body = layout({
        accent: BLUE,
        title: '결제가 완료되었습니다',
        preheader: `${v.course ?? ''} 응시 접수가 확정되었습니다.`,
        intro: `${v.name}님, 결제가 정상적으로 처리되어 응시 접수가 확정되었습니다.`,
        rows: [
          ['응시 종목', v.course ?? '-'],
          ['결제 금액', v.amount != null ? won(v.amount) : '-'],
          ['주문번호', v.orderId ?? '-'],
          ['결제 일시', v.paidAt ? formatDateTimeKst(v.paidAt) : '-'],
          ['응시 기한', v.examDeadline ? formatDateKst(v.examDeadline) : '-'],
        ],
        cta: v.url ? { label: '시험 응시하러 가기', url: v.url } : undefined,
        outro: v.examDeadline
          ? `응시 기한(${formatDateKst(v.examDeadline)})이 지나면 시험에 응시하실 수 없으며 환불되지 않습니다. 기한 내에 반드시 응시해주세요.`
          : undefined,
      });
      return { subject: `[${BRAND}] 결제가 완료되었습니다 — ${v.course ?? '응시 접수'}`, ...body };
    }

    case 'PAYMENT_FAILED': {
      const body = layout({
        accent: RED,
        title: '결제가 완료되지 않았습니다',
        preheader: '결제에 실패하여 접수가 완료되지 않았습니다.',
        intro: `${v.name}님, 결제가 정상적으로 처리되지 않아 응시 접수가 완료되지 않았습니다. 요금은 청구되지 않습니다.`,
        rows: [
          ['응시 종목', v.course ?? '-'],
          ['결제 금액', v.amount != null ? won(v.amount) : '-'],
          ['주문번호', v.orderId ?? '-'],
          ['실패 사유', v.reason ?? '결제 승인 실패'],
        ],
        cta: v.url ? { label: '다시 결제하기', url: v.url } : undefined,
        outro:
          '좌석은 다른 응시자에게 배정될 수 있습니다. 응시를 원하시면 다시 접수해주세요. 결제 수단에 문제가 없는데도 반복 실패하는 경우 1:1 문의로 알려주세요.',
      });
      return { subject: `[${BRAND}] 결제가 완료되지 않았습니다`, ...body };
    }

    case 'SEAT_HOLD_EXPIRED': {
      const body = layout({
        accent: GRAY,
        title: '좌석 예약이 만료되었습니다',
        preheader: '결제 대기 시간이 지나 좌석 예약이 해제되었습니다.',
        intro: `${v.name}님, 결제 대기 시간(30분) 내에 결제가 완료되지 않아 임시 배정된 좌석이 해제되었습니다. 요금은 청구되지 않습니다.`,
        rows: [
          ['응시 종목', v.course ?? '-'],
          ['시험 일정', v.scheduleDate ? formatDateKst(v.scheduleDate) : '-'],
        ],
        cta: v.url ? { label: '다시 접수하기', url: v.url } : undefined,
        outro: '동일한 일정에 잔여 좌석이 있다면 다시 접수하실 수 있습니다.',
      });
      return { subject: `[${BRAND}] 좌석 예약이 만료되었습니다`, ...body };
    }

    case 'EXAM_DEADLINE_REMINDER': {
      const d = v.daysLeft ?? 0;
      const body = layout({
        accent: AMBER,
        title: `응시 기한이 ${d}일 남았습니다`,
        preheader: `응시 기한까지 ${d}일 남았습니다. 기한이 지나면 환불되지 않습니다.`,
        intro: `${v.name}님, 결제하신 시험의 응시 기한이 곧 만료됩니다. 기한이 지나면 응시하실 수 없고 환불도 되지 않으니 서둘러 응시해주세요.`,
        rows: [
          ['응시 종목', v.course ?? '-'],
          ['응시 기한', v.examDeadline ? formatDateKst(v.examDeadline) : '-'],
          ['남은 기간', `${d}일`],
        ],
        cta: v.url ? { label: '지금 응시하기', url: v.url } : undefined,
      });
      return { subject: `[${BRAND}] 응시 기한이 ${d}일 남았습니다 — ${v.course ?? ''}`.trim(), ...body };
    }

    case 'EXAM_DEADLINE_EXPIRED': {
      const body = layout({
        accent: RED,
        title: '응시 기한이 만료되었습니다',
        preheader: '응시 기한이 지나 시험에 응시하실 수 없습니다.',
        intro: `${v.name}님, 결제하신 시험의 응시 기한이 만료되어 더 이상 응시하실 수 없습니다.`,
        rows: [
          ['응시 종목', v.course ?? '-'],
          ['만료된 응시 기한', v.examDeadline ? formatDateKst(v.examDeadline) : '-'],
        ],
        cta: v.url ? { label: '1:1 문의하기', url: v.url } : undefined,
        outro:
          '부득이한 사유로 응시하지 못하셨다면 1:1 문의로 상황을 알려주세요. 재응시를 원하시면 새로 접수하셔야 합니다.',
      });
      return { subject: `[${BRAND}] 응시 기한이 만료되었습니다`, ...body };
    }

    case 'CERT_EXPIRY_REMINDER': {
      const d = v.daysLeft ?? 0;
      const body = layout({
        accent: AMBER,
        title: `자격 유효기간이 ${d}일 남았습니다`,
        preheader: `보유하신 ${BRAND} 자격의 유효기간이 곧 만료됩니다.`,
        intro: `${v.name}님, 보유하신 ${BRAND} 자격의 유효기간이 곧 만료됩니다. 자격을 유지하시려면 만료 전에 재응시해주세요.`,
        rows: [
          ['자격 종목', v.course ?? '-'],
          ['자격번호', v.certNumber ?? '-'],
          ['유효기간 만료일', v.validUntil ? formatDateKst(v.validUntil) : '-'],
          ['남은 기간', `${d}일`],
        ],
        cta: v.url ? { label: '재응시 접수하기', url: v.url } : undefined,
      });
      return { subject: `[${BRAND}] 자격 유효기간이 ${d}일 남았습니다`, ...body };
    }

    case 'EXAM_RESULT_RELEASED': {
      // NEUTRAL notice — released on BOTH CONFIRMED_PASS and CONFIRMED_FAIL, so it
      // must NEVER reveal the score or the pass/fail outcome. It only tells the
      // candidate the result is viewable after login.
      //
      // Bilingual (KO + EN in one message): `User` has no locale column (see the
      // file header), so per-user language switching isn't possible without a
      // schema change. A single bilingual mail guarantees both languages reach
      // every recipient. Korean is the primary block (intro); English is the
      // secondary block (outro) — layout() renders them as separate paragraphs.
      const body = layout({
        accent: BLUE,
        title: '시험 결과 발표 안내 · Exam Results Available',
        preheader: '응시하신 시험의 결과가 발표되었습니다. · Your exam results are now available.',
        intro: `${v.name}님, 응시하신 시험의 결과가 발표되었습니다. 아래 버튼을 누르거나 ${BRAND} 사이트에 로그인하시면 결과를 확인하실 수 있습니다.`,
        rows: [['응시 종목 · Exam', v.course ?? '-']],
        cta: v.url ? { label: '결과 확인하기 · View results', url: v.url } : undefined,
        outro:
          `Your ${BRAND} exam results are now available. ` +
          `Please log in to the ${BRAND} website (or use the button above) to view your results.`,
      });
      return { subject: `[${BRAND}] 시험 결과 발표 안내 · Your exam results are available`, ...body };
    }

    default: {
      // Exhaustiveness guard — a new EmailTemplate enum value without a case here
      // is a compile error, not a blank email in a candidate's inbox.
      const never: never = template;
      throw new Error(`Unhandled email template: ${String(never)}`);
    }
  }
}
