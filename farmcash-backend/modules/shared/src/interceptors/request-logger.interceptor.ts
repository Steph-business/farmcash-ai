import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class RequestLoggerInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const reqId = (req.headers['x-request-id'] as string | undefined) ?? '-';
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.log(req, res, started, reqId),
        error: () => this.log(req, res, started, reqId),
      }),
    );
  }

  private log(req: Request, res: Response, started: number, reqId: string): void {
    const duration = Date.now() - started;
    const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms rid=${reqId}`;
    if (res.statusCode >= 500) this.logger.error(line);
    else if (res.statusCode >= 400) this.logger.warn(line);
    else this.logger.log(line);
  }
}
