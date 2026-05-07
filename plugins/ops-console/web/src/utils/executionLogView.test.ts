import { describe, expect, it } from "vitest";
import {
  inferFailureHint,
  labelMetadataKey,
  normalizeStreamText,
  orderMetadataEntries,
  previewStream,
  shouldTruncateStream
} from "./executionLogView";

describe("executionLogView", () => {
  it("labels known metadata keys in Chinese", () => {
    expect(labelMetadataKey("executionEngine")).toBe("执行引擎");
    expect(labelMetadataKey("exitCode")).toBe("退出码");
    expect(labelMetadataKey("unknownKey")).toBe("unknownKey");
  });

  it("orders priority keys before alphabetical remainder", () => {
    const ordered = orderMetadataEntries({
      zebra: "z",
      repo: "r",
      stage: "execute",
      exitCode: 1
    });
    expect(ordered.map(([k]) => k)).toEqual(["stage", "exitCode", "repo", "zebra"]);
  });

  it("strips execute stderr prefix", () => {
    const raw = "execute stderr:\nError: boom\n";
    expect(normalizeStreamText(raw, "stderr")).toBe("Error: boom\n");
  });

  it("detects cursor auth failure hint", () => {
    const hint = inferFailureHint(
      "execute stderr:\nError: Authentication required. Please run 'cursor agent login' first.\n",
      "failed"
    );
    expect(hint).toContain("CURSOR_API_KEY");
  });

  it("truncates long streams for preview", () => {
    const long = "x".repeat(7000);
    expect(shouldTruncateStream(long)).toBe(true);
    expect(previewStream(long).length).toBe(6000);
  });
});
