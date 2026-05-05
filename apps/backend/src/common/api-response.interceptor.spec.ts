import { of } from "rxjs";
import { ApiResponseInterceptor } from "./api-response.interceptor";

describe("ApiResponseInterceptor", () => {
  it("wraps successful controller results in the global response format", (done) => {
    const interceptor = new ApiResponseInterceptor();
    const next = {
      handle: () => of([{ id: "auto-1" }])
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ url: "/api/tasks" })
      })
    };

    interceptor.intercept(context as never, next).subscribe((payload: unknown) => {
      expect(payload).toEqual({
        code: 0,
        data: [{ id: "auto-1" }],
        message: "success"
      });
      done();
    });
  });

  it("does not wrap SSE event streams", (done) => {
    const interceptor = new ApiResponseInterceptor();
    const next = {
      handle: () => of({ type: "task.lifecycle", data: { taskId: "auto-1" } })
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ url: "/api/events" })
      })
    };

    interceptor.intercept(context as never, next).subscribe((payload: unknown) => {
      expect(payload).toEqual({ type: "task.lifecycle", data: { taskId: "auto-1" } });
      done();
    });
  });
});
