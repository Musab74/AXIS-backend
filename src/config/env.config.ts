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
      modulePath: process.env.NICE_CHECKPLUS_MODULE_PATH || '',
    },
    ipin: {
      sitecode: process.env.NICE_IPIN_SITECODE || '',
      sitepasswd: process.env.NICE_IPIN_SITEPASSWD || '',
      modulePath: process.env.NICE_IPIN_MODULE_PATH || '',
    },
  },

  upstage: {
    apiKey: process.env.UPSTAGE_API_KEY || process.env.UPSTAGEAI_SECRET_KEY || '',
  },

  toss: {
    clientKey: process.env.TOSS_CLIENT_KEY || '',
    secretKey: process.env.TOSS_SECRET_KEY || '',
    webhookSecret: process.env.TOSS_WEBHOOK_SECRET || '',
    apiBaseUrl: process.env.TOSS_API_BASE_URL || 'https://api.tosspayments.com',
    isTestMode: (process.env.TOSS_SECRET_KEY || '').startsWith('test_'),
  },

  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.AMAZON_KEY || '',
    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY || process.env.AMAZON_LIVE_CHECK_SECRET_KEY || '',
    region: process.env.AWS_REGION || 'ap-northeast-2',
  },
});
