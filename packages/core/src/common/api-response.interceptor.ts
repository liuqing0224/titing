import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, map } from "rxjs";

export type ApiResponse<T> = {
  code: number;
  data: T;
  message: string;
};

@Injectable()
export class ApiResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    const request = _context.switchToHttp().getRequest<{ url?: string }>();
    if (request.url?.endsWith("/events")) {
      return next.handle() as unknown as Observable<ApiResponse<T>>;
    }

    return next.handle().pipe(
      map((data) => ({
        code: 0,
        data,
        message: "success"
      }))
    );
  }
}
