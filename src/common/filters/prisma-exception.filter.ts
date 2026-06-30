import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    switch (exception.code) {
      case 'P2002': {
        // Unique constraint violation — Prisma's meta.target can be string | string[]
        // depending on the database/driver; normalize before joining.
        const rawTarget = exception.meta?.target;
        const target = Array.isArray(rawTarget)
          ? rawTarget
          : rawTarget != null
            ? [String(rawTarget)]
            : [];
        response.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          message: `이미 존재하는 데이터입니다 (${target.join(', ')})`,
          error: 'Conflict',
        });
        break;
      }
      case 'P2025': {
        // Record not found
        response.status(HttpStatus.NOT_FOUND).json({
          statusCode: HttpStatus.NOT_FOUND,
          message: '데이터를 찾을 수 없습니다',
          error: 'Not Found',
        });
        break;
      }
      case 'P2021': {
        // Table missing — deploy `prisma migrate deploy` or `prisma db push` on this database
        const model = (exception.meta?.modelName as string) || (exception.meta?.table as string) || '';
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: `DB 테이블이 없습니다${model ? ` (${model})` : ''}. 서버에 Prisma 마이그레이션/db push를 적용해 주세요.`,
          error: 'Internal Server Error',
        });
        break;
      }
      default: {
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: '서버 내부 오류가 발생했습니다',
          error: 'Internal Server Error',
        });
      }
    }
  }
}
