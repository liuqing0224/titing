import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger
} from "@nestjs/common";

type ErrorResponseBody = {
  code: number;
  data: null;
  message: string;
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request =
      "getRequest" in http && typeof http.getRequest === "function"
        ? http.getRequest<{ method?: string; url?: string }>()
        : undefined;
    const response = http.getResponse();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = this.getMessage(exception);

    this.logger.error(
      `${request?.method ?? "UNKNOWN"} ${request?.url ?? "unknown"} -> ${status} ${message}`,
      exception instanceof Error ? exception.stack : undefined
    );

    response.status(status).json({
      code: status,
      data: null,
      message
    } satisfies ErrorResponseBody);
  }

  private getMessage(exception: unknown): string {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === "string") {
        return response;
      }
      if (this.hasMessage(response)) {
        return Array.isArray(response.message) ? response.message.join(", ") : response.message;
      }
      return exception.message;
    }

    return "Internal server error";
  }

  private hasMessage(value: unknown): value is { message: string | string[] } {
    return typeof value === "object" && value !== null && "message" in value;
  }
}
