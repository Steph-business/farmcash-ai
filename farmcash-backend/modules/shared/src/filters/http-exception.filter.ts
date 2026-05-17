import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

interface ErrorPayload {
  status: number;
  message: string | object;
  code?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message, code } = this.normalize(exception);

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url}`,
        (exception as Error)?.stack,
      );
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      error: typeof message === 'string' ? { message, code } : message,
    });
  }

  private normalize(exception: unknown): ErrorPayload {
    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        message: exception.getResponse(),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrismaKnown(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Invalid query parameters',
        code: 'PRISMA_VALIDATION',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }

  private mapPrismaKnown(
    err: Prisma.PrismaClientKnownRequestError,
  ): ErrorPayload {
    switch (err.code) {
      case 'P2002': {
        const target = (err.meta?.target as string[] | undefined)?.join(', ');
        return {
          status: HttpStatus.CONFLICT,
          message: target
            ? `Resource already exists (duplicate: ${target})`
            : 'Resource already exists',
          code: err.code,
        };
      }
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          message: 'Resource not found',
          code: err.code,
        };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          message: 'Foreign key constraint failed',
          code: err.code,
        };
      case 'P2000':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'Value too long for the target column',
          code: err.code,
        };
      case 'P2014':
        return {
          status: HttpStatus.CONFLICT,
          message: 'Operation would violate a required relation',
          code: err.code,
        };
      default:
        this.logger.warn(`Unmapped Prisma error ${err.code}: ${err.message}`);
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Database error',
          code: err.code,
        };
    }
  }
}
