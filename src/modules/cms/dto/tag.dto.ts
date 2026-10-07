import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { IDENTIFIER_MESSAGE, IDENTIFIER_PATTERN, Trim } from './common.js';

export class TagTranslationDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'Lookbook' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Trim()
  name: string;
}

export class CreateTagDto {
  @ApiProperty({ example: 'lookbook' })
  @MaxLength(64)
  @Matches(IDENTIFIER_PATTERN, { message: `code ${IDENTIFIER_MESSAGE}` })
  code: string;
  @ApiProperty({ type: [TagTranslationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TagTranslationDto)
  translations: TagTranslationDto[];
}

export class UpdateTagDto {
  @ApiPropertyOptional({ type: [TagTranslationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TagTranslationDto)
  translations?: TagTranslationDto[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @Matches(LOCALE_PATTERN, { each: true })
  removeLocales?: string[];
}

export class TagDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty({ type: [TagTranslationDto] })
  translations: TagTranslationDto[];
}
