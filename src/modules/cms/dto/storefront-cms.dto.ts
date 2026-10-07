import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { StorefrontMediaDto } from '../../../common/content/content.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { BlockTargetType } from '../../../database/generated/prisma/enums.js';
import { IDENTIFIER_PATTERN } from './common.js';

export class StorefrontBlockDto {
  @ApiProperty() identifier: string;
  @ApiProperty({ nullable: true, type: String }) title: string | null;
  @ApiProperty({ description: 'HTML with nested blocks rendered' })
  content: string;
}

export class StorefrontRegionDto {
  @ApiProperty({ example: 'sidebar' }) region: string;
  @ApiProperty({ type: [StorefrontBlockDto] }) blocks: StorefrontBlockDto[];
}

export class StorefrontPageDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() slug: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Canonical path in this store and locale',
  })
  urlPath: string | null;
  @ApiProperty() layout: string;
  @ApiProperty({ description: 'HTML with blocks rendered' }) content: string;
  @ApiProperty({ nullable: true, type: String }) metaTitle: string | null;
  @ApiProperty({ nullable: true, type: String })
  metaDescription: string | null;
  @ApiProperty({ nullable: true, type: Date }) publishedAt: Date | null;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ type: [StorefrontRegionDto] })
  regions: StorefrontRegionDto[];
}

export class StorefrontTagDto {
  @ApiProperty() code: string;
  @ApiProperty() name: string;
}

export class StorefrontPostCardDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() slug: string;
  @ApiProperty({ nullable: true, type: String }) urlPath: string | null;
  @ApiProperty({ nullable: true, type: String }) excerpt: string | null;
  @ApiProperty({ nullable: true, type: Date }) publishedAt: Date | null;
  @ApiProperty({ nullable: true, type: StorefrontMediaDto })
  featuredImage: StorefrontMediaDto | null;
  @ApiProperty({ type: [StorefrontTagDto] }) tags: StorefrontTagDto[];
}

export class StorefrontPostDto extends StorefrontPostCardDto {
  @ApiProperty({ description: 'HTML with blocks rendered' }) content: string;
  @ApiProperty({ nullable: true, type: String }) metaTitle: string | null;
  @ApiProperty({ nullable: true, type: String })
  metaDescription: string | null;
  @ApiProperty({ type: [StorefrontRegionDto] })
  regions: StorefrontRegionDto[];
}

export class StorefrontPostListDto {
  @ApiProperty({ type: [StorefrontPostCardDto] })
  data: StorefrontPostCardDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class StorefrontPostsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Tag code' })
  @IsOptional()
  @MaxLength(64)
  @Matches(IDENTIFIER_PATTERN)
  tag?: string;
}

export class PageByPathQueryDto {
  @ApiProperty({ example: 'help/shipping' })
  @IsString()
  @MaxLength(255)
  path: string;
}

export class PlacementsQueryDto {
  @ApiProperty({ enum: BlockTargetType, enumName: 'BlockTargetType' })
  @IsEnum(BlockTargetType)
  targetType: BlockTargetType;
  @ApiProperty() @IsUUID() targetId: string;
}
