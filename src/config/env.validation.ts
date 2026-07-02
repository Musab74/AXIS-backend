import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'staging', 'production').default('development'),

  APP_PORT: Joi.number().port().default(3333),
  APP_URL: Joi.string().uri().required(),
  FRONTEND_URL: Joi.string().uri().required(),

  DATABASE_URL: Joi.string().required(),

  JWT_ACCESS_SECRET: Joi.string().min(16).required(),
  JWT_REFRESH_SECRET: Joi.string().min(16).required(),

  PORTONE_STORE_ID: Joi.string().allow('').optional(),
  PORTONE_CHANNEL_KEY: Joi.string().allow('').optional(),
  PORTONE_V2_API_SECRET: Joi.string().allow('').optional(),
  PORTONE_WEBHOOK_SECRET: Joi.string().allow('').optional(),
  PORTONE_WEBHOOK_SECRET_ARN: Joi.string().allow('').optional(),
  PORTONE_MODULE_VERSION: Joi.string().valid('v1', 'v2').default('v2'),
  PORTONE_V1_IMP_CODE: Joi.string().allow('').optional(),
  PORTONE_V1_IMP_KEY: Joi.string().allow('').optional(),
  PORTONE_V1_IMP_SECRET: Joi.string().allow('').optional(),
  PORTONE_V1_API_KEY: Joi.string().allow('').optional(),
  PORTONE_V1_API_SECRET: Joi.string().allow('').optional(),
  PORTONE_V1_PG: Joi.string().allow('').optional(),
  PORTONE_V1_PG_PROVIDER: Joi.string().allow('').optional(),
  PORTONE_V1_KCP_SITE_CODE: Joi.string().allow('').optional(),

  // AI proctoring — tier 1 (Gemini Flash-Lite) + tier 2 (Claude Sonnet 4.6).
  // Both are optional: missing keys degrade the AI screen to OK + warn, exam continues.
  // Canonical names below are checked first; legacy `GEMINI_API_KEY` /
  // `GOOGLE_API_KEY` / `CLAUDE_API_KEY` are accepted as fallbacks in
  // env.config.ts so a misnamed key in `.env` still wires up the AI.
  GOOGLE_GEMINI_API_KEY: Joi.string().allow('').optional(),
  GEMINI_API_KEY: Joi.string().allow('').optional(),
  GOOGLE_API_KEY: Joi.string().allow('').optional(),
  ANTHROPIC_API_KEY: Joi.string().allow('').optional(),
  CLAUDE_API_KEY: Joi.string().allow('').optional(),

  // Redis — used for AI cost cap (`proctor:claude:rl:{sessionId}` EX 30),
  // idempotency (`proctor:ai:dedupe:{sessionId}:{ts}`), and `admin:ai-alert` pub/sub.
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).default('redis://127.0.0.1:6379'),

  // Naver Cloud Object Storage — PIPA-compliant evidence bucket.
  NCP_ACCESS_KEY: Joi.string().allow('').optional(),
  NCP_SECRET_KEY: Joi.string().allow('').optional(),
  NCP_REGION: Joi.string().default('kr-standard'),
  NCP_ENDPOINT: Joi.string().uri().default('https://kr.object.ncloudstorage.com'),
  NCP_BUCKET_SNAPSHOTS: Joi.string().default('axis-snapshots'),
  NCP_BUCKET_DELIVERABLES: Joi.string().default('axis-deliverables'),

  // Judge0 self-hosted sandbox for AXIS-C coding exams. Both are optional so
  // the server starts without them; sandbox routes return 503 when unconfigured.
  JUDGE0_URL: Joi.string().uri().allow('').optional(),
  JUDGE0_AUTH_TOKEN: Joi.string().allow('').optional(),

  // Exam deadline — number of days user has to complete exam after payment.
  EXAM_DATE_AFTER_PAYMENT: Joi.number().integer().min(1).max(365).default(20),

  // Optional: when set with ADMIN_PORTAL_URL, /public/site-context exposes footerAdminLink
  // only for requests whose IP matches (default 121.168.121.86). Edge must send X-Forwarded-For.
  ADMIN_FOOTER_ALLOWED_IP: Joi.string().optional(),
  ADMIN_PORTAL_URL: Joi.string().uri().allow('').optional(),

  // Set to 'true' on staging/dev to expose POST /payment/test-confirm, which
  // bypasses PortOne and marks the registration as PAID. MUST stay unset on prod.
  TEST_PAYMENT_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // Set to 'true' on staging/dev to skip referenceFaceImage check at exam start.
  // MUST stay false on production.
  CBT_SKIP_IDENTITY_CHECK: Joi.string().valid('true', 'false').default('false'),

  // L3 실습형 4문항 wire-up. Default 'true': L3 runs 40+20 min, 60/40 weighted
  // scoring, pass 70, practical floor 60%. Requires seed-l3-practicals to have
  // inserted the L3 TaskTemplate rows; environments without them fall back to
  // legacy MCQ-only at session start. Set 'false' to force legacy MCQ-only.
  L3_PRACTICALS_ENABLED: Joi.string().valid('true', 'false').default('true'),
}).unknown(true);
