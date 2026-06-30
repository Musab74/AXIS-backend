import { IsEnum, IsBoolean } from 'class-validator';
import { Role } from '@prisma/client';

export class UpdateRoleDto {
  @IsEnum(Role)
  role!: Role;

  @IsBoolean()
  grant!: boolean;
}
