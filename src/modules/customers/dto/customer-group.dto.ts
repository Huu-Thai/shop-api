import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CODE_MESSAGE, CODE_PATTERN } from '../../../common/dto/codes.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CustomerGroupDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'wholesale' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Customer tax class; null = retail',
  })
  taxClassId: string | null;
  @ApiProperty() isSystem: boolean;
}

export class CreateCustomerGroupDto {
  @ApiProperty({ example: 'vip' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiProperty({ example: 'VIP' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  taxClassId?: string | null;
}

export class UpdateCustomerGroupDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  taxClassId?: string | null;
}
