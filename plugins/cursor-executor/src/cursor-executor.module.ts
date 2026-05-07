import { Module } from "@nestjs/common";
import { CursorRunner } from "./cursor-runner";

@Module({
  providers: [CursorRunner],
  exports: [CursorRunner]
})
export class CursorExecutorModule {}
