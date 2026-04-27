import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'staging', 'production').default('development'),

  APP_PORT: Joi.number().port().default(3333),
  APP_URL: Joi.string().uri().required(),
  FRONTEND_URL: Joi.string().uri().required(),

  DATABASE_URL: Joi.string().required(),

  JWT_ACCESS_SECRET: Joi.string().min(16).required(),
  JWT_REFRESH_SECRET: Joi.string().min(16).required(),

  TOSS_CLIENT_KEY: Joi.string().pattern(/^(test|live)_(ck|gck)_/).required(),
  TOSS_SECRET_KEY: Joi.string().pattern(/^(test|live)_(sk|gsk)_/).required(),
  TOSS_WEBHOOK_SECRET: Joi.string().min(32).required(),
  TOSS_API_BASE_URL: Joi.string().uri().default('https://api.tosspayments.com'),
}).custom((value, helpers) => {
  const isProd = value.NODE_ENV === 'production';
  const usesTestKey =
    value.TOSS_SECRET_KEY?.startsWith('test_') || value.TOSS_CLIENT_KEY?.startsWith('test_');
  if (isProd && usesTestKey) {
    return helpers.error('any.invalid', {
      message: 'Refusing to boot: production environment is using Toss test_* keys.',
    });
  }
  return value;
}, 'toss-key-mode-guard').unknown(true);
