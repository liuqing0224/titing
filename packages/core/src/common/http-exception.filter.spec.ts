import { BadRequestException } from "@nestjs/common";
import { HttpExceptionFilter } from "./http-exception.filter";

describe("HttpExceptionFilter", () => {
  it("serializes HTTP exceptions in the global error response format", () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status })
      })
    };
    const filter = new HttpExceptionFilter();

    filter.catch(new BadRequestException("Invalid transition"), host as never);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      code: 400,
      data: null,
      message: "Invalid transition"
    });
  });
});
