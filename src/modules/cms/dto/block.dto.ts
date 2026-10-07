import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PublishingDto } from '../../../common/content/content.dto.js';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { BlockTargetType } from '../../../database/generated/prisma/enums.js';
import {
  IDENTIFIER_MESSAGE,
  IDENTIFIER_PATTERN,
  REGION_PATTERN,
  Trim,
} from './common.js';
import { ListContentQueryDto } from './page.dto.js';

export class BlockTranslationDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiPropertyOptional({ description: 'Optional heading' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Trim()
  title?: string;
  @ApiProperty({ description: 'HTML (sanitized on save); may embed blocks' })
  @IsString()
  @MaxLength(1_000_000)
  content: string;
}

export class CreateBlockDto {
  @ApiProperty({ example: 'footer-links' })
  @MaxLength(64)
  @Matches(IDENTIFIER_PATTERN, { message: `identifier ${IDENTIFIER_MESSAGE}` })
  identifier: string;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Omit for every store; a store block with the same identifier wins',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  storeId?: string | null;
  @ApiProperty({ type: [BlockTranslationDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BlockTranslationDto)
  translations: BlockTranslationDto[];
}

export class UpdateBlockDto {
  @ApiPropertyOptional({ type: [BlockTranslationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BlockTranslationDto)
  translations?: BlockTranslationDto[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @Matches(LOCALE_PATTERN, { each: true })
  removeLocales?: string[];
}

export class BlockTranslationViewDto {
  @ApiProperty() localeCode: string;
  @ApiProperty({ nullable: true, type: String }) title: string | null;
  @ApiProperty() content: string;
}

export class BlockDto extends PublishingDto {
  @ApiProperty() id: string;
  @ApiProperty() identifier: string;
  @ApiProperty({ nullable: true, type: String }) storeId: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ type: [BlockTranslationViewDto] })
  translations: BlockTranslationViewDto[];
}

export class BlockListDto {
  @ApiProperty({ type: [BlockDto] }) data: BlockDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export { ListContentQueryDto as ListBlocksQueryDto };

export class CreatePlacementDto {
  @ApiProperty({ enum: BlockTargetType, enumName: 'BlockTargetType' })
  @IsEnum(BlockTargetType)
  targetType: BlockTargetType;
  @ApiProperty() @IsUUID() targetId: string;
  @ApiProperty({
    example: 'sidebar',
    description: 'Region of the target’s layout',
  })
  @MaxLength(64)
  @Matches(REGION_PATTERN)
  region: string;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class PlacementDto {
  @ApiProperty() id: string;
  @ApiProperty() blockId: string;
  @ApiProperty({ enum: BlockTargetType, enumName: 'BlockTargetType' })
  targetType: BlockTargetType;
  @ApiProperty() targetId: string;
  @ApiProperty() region: string;
  @ApiProperty() position: number;
}
