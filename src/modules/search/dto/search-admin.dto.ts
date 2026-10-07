import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  SearchBuildStatus,
  SearchProviderKind,
} from '../../../database/generated/prisma/enums.js';

export class SearchConnectionDto {
  @ApiProperty({ example: 'https://search.internal:7700' })
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(255)
  url: string;
  @ApiPropertyOptional({
    description: 'Meilisearch key, or Elasticsearch/OpenSearch API key',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  apiKey?: string;
  @ApiPropertyOptional({ description: 'Basic auth (Elasticsearch/OpenSearch)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  password?: string;
}

export class UpdateSearchSettingsDto {
  @ApiProperty({ enum: SearchProviderKind, enumName: 'SearchProviderKind' })
  @IsEnum(SearchProviderKind)
  provider: SearchProviderKind;
  @ApiPropertyOptional({
    type: SearchConnectionDto,
    description:
      'Required for external engines (kept when omitted and the engine is unchanged)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SearchConnectionDto)
  connection?: SearchConnectionDto;
  @ApiPropertyOptional({ example: 'shop' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_]{0,31}$/)
  indexPrefix?: string;
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
    example: [['tee', 't-shirt']],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  synonyms?: string[][];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  stopwords?: string[];
}

export class SearchEngineStatusDto {
  @ApiProperty({ enum: SearchProviderKind, enumName: 'SearchProviderKind' })
  provider: SearchProviderKind;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Engine URL (credentials are never returned)',
  })
  url: string | null;
  @ApiProperty() generation: number;
}

export class SearchStatusDto {
  @ApiProperty() websiteId: string;
  @ApiProperty({ type: SearchEngineStatusDto }) active: SearchEngineStatusDto;
  @ApiProperty({
    type: SearchEngineStatusDto,
    nullable: true,
    description: 'Engine being built during a switch',
  })
  pending: SearchEngineStatusDto | null;
  @ApiProperty({ enum: SearchBuildStatus, enumName: 'SearchBuildStatus' })
  status: SearchBuildStatus;
  @ApiProperty({ nullable: true, type: String }) lastError: string | null;
  @ApiProperty({ nullable: true, type: Date }) lastBuiltAt: Date | null;
  @ApiProperty() indexPrefix: string;
  @ApiProperty({
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
  })
  synonyms: string[][];
  @ApiProperty({ type: [String] }) stopwords: string[];
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        storeCode: { type: 'string' },
        localeCode: { type: 'string' },
        documents: { type: 'integer' },
      },
    },
  })
  documents: { storeCode: string; localeCode: string; documents: number }[];
}
