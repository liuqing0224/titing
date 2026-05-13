import { assertValidTransition } from "./state-machine";

describe("state machine", () => {
  it("accepts legal transitions", () => {
    expect(() => assertValidTransition("queued", "running")).not.toThrow();
    expect(() => assertValidTransition("evaluating", "repairing")).not.toThrow();
    expect(() => assertValidTransition("running", "repairing")).not.toThrow();
    expect(() => assertValidTransition("running", "done")).not.toThrow();
    expect(() => assertValidTransition("repairing", "done")).not.toThrow();
    expect(() => assertValidTransition("failed", "queued")).not.toThrow();
  });

  it("rejects illegal transitions", () => {
    expect(() => assertValidTransition("queued", "done")).toThrow("Illegal task transition");
  });
});
