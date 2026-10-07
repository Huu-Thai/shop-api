import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';
import { ContentStatus } from '../../database/generated/prisma/enums.js';

/** Body of `POST …/publish` and `POST …/unpublish`. */
export class PublishContentDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2026-11-01T08:00:00Z',
    description: 'When to do it; omit (or a past time) for now',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  at?: string;
}

/** Publishing fields of every content row (admin views). */
export class PublishingDto {
  @ApiProperty({ enum: ContentStatus, enumName: 'ContentStatus' })
  status: ContentStatus;
  @ApiProperty({ nullable: true, type: Date }) publishedAt: Date | null;
  @ApiProperty({ nullable: true, type: Date }) unpublishedAt: Date | null;
  @ApiProperty({ description: 'Shown on the storefront right now' })
  visible: boolean;
}

export class StorefrontMediaRenditionDto {
  @ApiProperty() width: number;
  @ApiProperty() height: number;
  @ApiProperty() url: string;
}

/** An image of content (banner, slide, featured image). */
export class StorefrontMediaDto {
  @ApiProperty() url: string;
  @ApiProperty() width: number;
  @ApiProperty() height: number;
  @ApiProperty({ nullable: true, type: String }) alt: string | null;
  @ApiProperty({ type: [StorefrontMediaRenditionDto] })
  renditions: StorefrontMediaRenditionDto[];
}

/** Absolute http(s) URL or a site-relative path (`/sale`); rejects `//host` and other schemes. */
export const LINK_PATTERN = /^(?:\/(?!\/)[^\s]*|https?:\/\/[^\s]+)$/;
export const LINK_MESSAGE =
  'must be a site path starting with "/" or an http(s) URL';
