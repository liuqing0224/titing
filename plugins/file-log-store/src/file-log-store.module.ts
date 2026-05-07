import { Module } from "@nestjs/common";
import { FileExecutionLogStoreService } from "./file-execution-log-store.service";

@Module({
  providers: [FileExecutionLogStoreService],
  exports: [FileExecutionLogStoreService]
})
export class FileLogStoreModule {}
