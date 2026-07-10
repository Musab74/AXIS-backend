import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { urlencoded, json, static as expressStatic } from 'express';
import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';

// Where multipart uploads land. Resolved once at bootstrap so the same path
// is used by main.ts (static serving) and inquiries/uploads.controller.ts
// (multer destination).
export const UPLOAD_ROOT = join(process.cwd(), 'uploads');

async function bootstrap() {
  // rawBody: required for PortOne webhook verification (any re-stringify breaks it).
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // The custom parsers below are registered BEFORE Nest's built-in ones (those
  // attach at init) and therefore consume the body stream first — without this
  // verify hook, Nest's own rawBody capture never runs, req.rawBody stays
  // undefined, and every PortOne webhook is rejected with "Missing raw body".
  const rawBodySaver = (
    req: IncomingMessage & { rawBody?: Buffer },
    _res: ServerResponse,
    buf: Buffer,
  ): void => {
    if (buf && buf.length) req.rawBody = buf;
  };
  // NICE CheckPlus / IPIN POST application/x-www-form-urlencoded to return URLs
  app.use(urlencoded({ extended: true, limit: '20mb', verify: rawBodySaver }));
  // Bump JSON parser past the 100 KB default so client-side base64 / large
  // payloads (inquiry attachments metadata, AI proctor frames, etc.) don't
  // get killed with PayloadTooLargeError.
  app.use(json({ limit: '20mb', verify: rawBodySaver }));

  // Static serving for user-uploaded files. Apache's catch-all ProxyPass
  // already forwards the public API host through to :3333,
  // so /uploads/inquiries/<file> is reachable from the public origin.
  mkdirSync(join(UPLOAD_ROOT, 'inquiries'), { recursive: true });
  mkdirSync(join(UPLOAD_ROOT, 'legal_documents'), { recursive: true });
  app.use(
    '/uploads',
    expressStatic(UPLOAD_ROOT, {
      maxAge: '7d',
      fallthrough: false,
      // Force a download for non-image content rather than letting the
      // browser try to render arbitrary files inline.
      setHeaders: (res, filePath) => {
        if (/legal_documents[/\\].*\.html$/i.test(filePath)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Content-Disposition', 'inline');
          return;
        }
        if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath)) {
          res.setHeader('Content-Disposition', 'attachment');
        }
      },
    }),
  );

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const corsOrigins = new Set<string>([frontendUrl]);
  try {
    const parsed = new URL(frontendUrl);
    const altHost = parsed.hostname.startsWith('www.')
      ? parsed.hostname.slice(4)
      : `www.${parsed.hostname}`;
    corsOrigins.add(`${parsed.protocol}//${altHost}`);
  } catch {
    /* keep single origin */
  }

  app.enableCors({
    origin: [...corsOrigins],
    credentials: true,
  });

  app.useGlobalFilters(new PrismaExceptionFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('AXIS API')
    .setDescription('AXIS Certification System API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, document);

  const port = process.env.APP_PORT || 3000;
  await app.listen(port);
  console.log(`AXIS Backend running on http://localhost:${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api-docs`);
}

bootstrap();
