import { Module } from "@nestjs/common";
import { LocalAgentRuntimeService } from "./local-agent-runtime.service";

@Module({
  providers: [LocalAgentRuntimeService],
  exports: [LocalAgentRuntimeService]
})
export class LocalRuntimeModule {}
