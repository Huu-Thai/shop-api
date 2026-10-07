import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  CODE_MESSAGE,
  CODE_PATTERN,
  LOCALE_PATTERN,
} from '../../../common/dto/codes.js';
import { AttributeType } from '../../../database/generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class LabelDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'Colour' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  label: string;
}

export class AttributeOptionInputDto {
  @ApiProperty({ example: 'red' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiPropertyOptional({ example: '#d32f2f' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  swatch?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiProperty({ type: [LabelDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LabelDto)
  labels: LabelDto[];
}

class AttributeFlags {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;
  @ApiPropertyOptional({
    default: false,
    description: 'Usable as a storefront filter (facet)',
  })
  @IsOptional()
  @IsBoolean()
  isFilterable?: boolean;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isSearchable?: boolean;
  @ApiPropertyOptional({
    default: true,
    description: 'Shown on the storefront product page',
  })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class CreateAttributeDto extends AttributeFlags {
  @ApiProperty({ example: 'color' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiProperty({ enum: AttributeType, enumName: 'AttributeType' })
  @IsEnum(AttributeType)
  type: AttributeType;
  @ApiPropertyOptional({
    default: false,
    description: 'Value differs per locale (stored with the translations)',
  })
  @IsOptional()
  @IsBoolean()
  isLocalizable?: boolean;
  @ApiProperty({ type: [LabelDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LabelDto)
  labels: LabelDto[];
  @ApiPropertyOptional({
    type: [AttributeOptionInputDto],
    description: 'SELECT / MULTISELECT only',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => AttributeOptionInputDto)
  options?: AttributeOptionInputDto[];
}

/** `type`, `code` and `isLocalizable` are fixed: stored values depend on them. */
export class UpdateAttributeDto extends AttributeFlags {
  @ApiPropertyOptional({ type: [LabelDto], description: 'Replaces all labels' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LabelDto)
  labels?: LabelDto[];
  @ApiPropertyOptional({
    type: [AttributeOptionInputDto],
    description:
      'Replaces the option list (matched by code); removing an option in use fails',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => AttributeOptionInputDto)
  options?: AttributeOptionInputDto[];
}

export class AttributeOptionDto {
  @ApiProperty() code: string;
  @ApiProperty({ nullable: true, type: String }) swatch: string | null;
  @ApiProperty() position: number;
  @ApiProperty({ type: [LabelDto] }) labels: LabelDto[];
}

export class AttributeDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty({ enum: AttributeType, enumName: 'AttributeType' })
  type: AttributeType;
  @ApiProperty() isRequired: boolean;
  @ApiProperty() isFilterable: boolean;
  @ApiProperty() isSearchable: boolean;
  @ApiProperty() isLocalizable: boolean;
  @ApiProperty() isVisible: boolean;
  @ApiProperty() position: number;
  @ApiProperty({ type: [LabelDto] }) labels: LabelDto[];
  @ApiProperty({ type: [AttributeOptionDto] }) options: AttributeOptionDto[];
}

export class AttributeSetMemberDto {
  @ApiProperty({ example: 'color' }) @Matches(CODE_PATTERN) code: string;
  @ApiPropertyOptional({ default: 'General' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  groupName?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
}

export class CreateAttributeSetDto {
  @ApiProperty({ example: 'apparel' })
  @Matches(CODE_PATTERN, { message: `code ${CODE_MESSAGE}` })
  code: string;
  @ApiProperty({ example: 'Apparel' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiProperty({ type: [AttributeSetMemberDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AttributeSetMemberDto)
  attributes: AttributeSetMemberDto[];
}

export class UpdateAttributeSetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
  @ApiPropertyOptional({
    type: [AttributeSetMemberDto],
    description: 'Replaces the member list',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AttributeSetMemberDto)
  attributes?: AttributeSetMemberDto[];
}

export class AttributeSetDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: [AttributeSetMemberDto] })
  attributes: AttributeSetMemberDto[];
}
