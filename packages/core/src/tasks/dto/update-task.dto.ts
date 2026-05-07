import { IsOptional, IsString } from "class-validator";

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  repo?: string;

  @IsOptional()
  @IsString()
  branch?: string;

  @IsOptional()
  @IsString()
  instruction?: string;
}
