import { Module } from "@nestjs/common";
import { CodexRunner } from "./codex-runner";

@Module({
  providers: [CodexRunner],
  exports: [CodexRunner]
})
export class CodexExecutorModule {}
