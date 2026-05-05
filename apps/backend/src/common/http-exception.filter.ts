import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus
} from "@nestjs/common";

type ErrorResponseBody = {
  code: number;
  data: null;
  message: string;
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    response.status(status).json({
      code: status,
      data: null,
      message: this.getMessage(exception)
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
