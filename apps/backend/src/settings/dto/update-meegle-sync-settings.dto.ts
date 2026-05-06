import { Type } from "class-transformer";
import { IsBoolean, IsInt, Max, Min } from "class-validator";

export class UpdateMeegleSyncSettingsDto {
  @IsBoolean()
  enabled: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  intervalMinutes: number;
}
