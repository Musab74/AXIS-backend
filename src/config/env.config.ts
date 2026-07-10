import { join } from 'path';

const bundledNiceBinary = (relativePath: string) =>
  join(process.cwd(), 'lib/nice', relativePath);

export const envConfig = () => ({
  port: parseInt(process.env.APP_PORT || '3000', 10),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'refresh-secret',
    accessExpiresIn: '15m',
    refreshExpiresIn: '14d',
  },

  nice: {
    checkplus: {
      sitecode: process.env.NICE_CHECKPLUS_SITECODE || '',
      sitepasswd: process.env.NICE_CHECKPLUS_SITEPASSWD || '',
      modulePath:
        process.env.NICE_CHECKPLUS_MODULE_PATH ||
        bundledNiceBinary('CheckPlusSafe/64bit/CPClient_64bit'),
    },
    ipin: {
      sitecode: process.env.NICE_IPIN_SITECODE || '',
      sitepasswd: process.env.NICE_IPIN_SITEPASSWD || '',
      modulePath:
        process.env.NICE_IPIN_MODULE_PATH ||
        bundledNiceBinary('NiceIPIN/64bit/IPIN2Client'),
    },
  },

  upstage: {
    apiKey: process.env.UPSTAGE_API_KEY || process.env.UPSTAGEAI_SECRET_KEY || '',
  },

  clovaOcr: {
    invokeUrl: process.env.CLOVA_OCR_INVOKE_URL || '',
    secret: process.env.CLOVA_OCR_SECRET || '',
  },

  portone: {
    storeId: process.env.PORTONE_STORE_ID || '',
    channelKey: process.env.PORTONE_CHANNEL_KEY || '',
    v2ApiSecret: process.env.PORTONE_V2_API_SECRET || '',
    webhookSecret: process.env.PORTONE_WEBHOOK_SECRET || '',
    webhookSecretArn: process.env.PORTONE_WEBHOOK_SECRET_ARN || '',
    // Comma-separated source-IP allowlist for /webhooks/portone (defence-in-
    // depth; empty = disabled). iamport V1 sends from 52.78.100.19,
    // 52.78.48.223, 52.78.5.241. Requires the edge to forward X-Forwarded-For.
    webhookAllowedIps: (process.env.PORTONE_WEBHOOK_ALLOWED_IPS || '').trim(),
    moduleVersion: (process.env.PORTONE_MODULE_VERSION || 'v2').toLowerCase(),
    v1ImpCode: process.env.PORTONE_V1_IMP_CODE || '',
    v1ImpKey: process.env.PORTONE_V1_IMP_KEY || process.env.PORTONE_V1_API_KEY || '',
    v1ImpSecret:
      process.env.PORTONE_V1_IMP_SECRET || process.env.PORTONE_V1_API_SECRET || '',
    v1Pg: (process.env.PORTONE_V1_PG || '').trim(),
    v1PgProvider: (process.env.PORTONE_V1_PG_PROVIDER || 'kcp').toLowerCase(),
    v1KcpSiteCode: (process.env.PORTONE_V1_KCP_SITE_CODE || '').trim(),
  },

  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.AMAZON_KEY || '',
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY || process.env.AMAZON_LIVE_CHECK_SECRET_KEY || '',
    region: process.env.AWS_REGION || 'ap-northeast-2',
  },

  ai: {
    geminiApiKey:
      process.env.GOOGLE_GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      '',
    anthropicApiKey:
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_API_KEY ||
      '',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  },

  ncp: {
    accessKey: process.env.NCP_ACCESS_KEY || '',
    secretKey: process.env.NCP_SECRET_KEY || '',
    region: process.env.NCP_REGION || 'kr-standard',
    endpoint: process.env.NCP_ENDPOINT || 'https://kr.object.ncloudstorage.com',
    bucketSnapshots: process.env.NCP_BUCKET_SNAPSHOTS || 'axis-snapshots',
    bucketDeliverables: process.env.NCP_BUCKET_DELIVERABLES || 'axis-deliverables',
  },

  judge0: {
    url: (process.env.JUDGE0_URL || '').trim(),
    authToken: (process.env.JUDGE0_AUTH_TOKEN || '').trim(),
  },

  exam: {
    daysAfterPayment: parseInt(process.env.EXAM_DATE_AFTER_PAYMENT || '20', 10),
  },

  /** Footer admin link: only returned from /public/site-context when client IP matches. */
  adminFooter: {
    allowedIp: (process.env.ADMIN_FOOTER_ALLOWED_IP || '121.168.121.86').trim(),
    portalUrl: (process.env.ADMIN_PORTAL_URL || '').trim(),
  },

  // Demo/staging convenience: POST /payment/test-confirm bypasses PortOne and
  // flips the registration to PAID with a synthetic pgPaymentId. Endpoint
  // returns 404 unless this is explicitly enabled — DO NOT enable in production.
  testPayment: {
    enabled: (process.env.TEST_PAYMENT_ENABLED || '').toLowerCase() === 'true',
  },

  cbt: {
    skipIdentityCheck: (process.env.CBT_SKIP_IDENTITY_CHECK || 'false').toLowerCase() === 'true',
    // L3 실습형 4문항(현업적용·지시설계·분석검증·리스크판단) wire-up. Default ON:
    // L3 adopts the new 운영기획서 — 40+20 min, 100점(60+40), 합격 70, 실습형 60% floor.
    // Environments without the seeded L3 practical pool fall back to legacy
    // MCQ-only automatically. Set 'false' to force the legacy MCQ-only spec.
    l3PracticalsEnabled: (process.env.L3_PRACTICALS_ENABLED || 'true').toLowerCase() === 'true',
    // POLICY FLAG: L3-with-practicals auto-finalize (AI-confident sessions are
    // GRADED + certified with no human touch). Default ON = current behavior;
    // set 'false' to force every L3 practical session through the expert queue.
    // Read at call time in L3AutoFinalizeService (this entry documents it).
    l3AutoFinalize: (process.env.L3_AUTO_FINALIZE || 'true').toLowerCase() === 'true',
  },

  grading: {
    // Per-expert cert-series competency allowlist:
    //   EXPERT_CERT_SCOPES="<userId>=AXIS,AXIS_H;<userId2>=AXIS_C"
    // Unset → every expert keeps full-series access (legacy behavior).
    expertCertScopes: (process.env.EXPERT_CERT_SCOPES || '').trim(),
  },
});
