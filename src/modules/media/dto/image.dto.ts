import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
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
  MinLength,
  ValidateNested,
} from 'class-validator';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { ImageRole } from '../../../database/generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class AltTextDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'Red classic tee, front' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  alt: string;
}

export class UpdateImageDto {
  @ApiProperty({ type: [AltTextDto], description: 'Replaces all alt texts' })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AltTextDto)
  alts: AltTextDto[];
}

/** Text fields of the multipart upload; the file itself is handled by multer (see @ApiBody). */
export class UploadImageDto {
  @ApiPropertyOptional({ example: 'en-US' })
  @IsOptional()
  @Matches(LOCALE_PATTERN)
  localeCode?: string;
  @ApiPropertyOptional({ example: 'Red classic tee, front' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  alt?: string;
}

export class RenditionDto {
  @ApiProperty() width: number;
  @ApiProperty() height: number;
  @ApiProperty() key: string;
}

export class ImageDto {
  @ApiProperty() id: string;
  @ApiProperty() storageKey: string;
  @ApiProperty() checksum: string;
  @ApiProperty() mime: string;
  @ApiProperty() width: number;
  @ApiProperty() height: number;
  @ApiProperty() bytes: number;
  @ApiProperty({ nullable: true, type: String }) originalFilename:
    string | null;
  @ApiProperty({ type: [RenditionDto] }) renditions: RenditionDto[];
  @ApiProperty({ type: [AltTextDto] }) alts: AltTextDto[];
  @ApiProperty() linkCount: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty({
    description:
      'The original, from the CDN (MEDIA_PUBLIC_BASE_URL) or a short-lived signed link',
  })
  url: string;
  @ApiProperty({
    description:
      'Smallest rendition at least 320 px wide (the original until renditions exist)',
  })
  thumbnailUrl: string;
}

export class ImageListDto {
  @ApiProperty({ type: [ImageDto] }) data: ImageDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class ListImagesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Original file name contains' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class ImageLinkInputDto {
  @ApiProperty() @IsUUID() imageId: string;
  @ApiProperty({ enum: ImageRole, enumName: 'ImageRole' })
  @IsEnum(ImageRole)
  role: ImageRole;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
}

export class SetImageLinksDto {
  @ApiProperty({
    type: [ImageLinkInputDto],
    description: 'Replaces the images of the owner',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ImageLinkInputDto)
  images: ImageLinkInputDto[];
}

export class ImageLinkDto {
  @ApiProperty() imageId: string;
  @ApiProperty({ enum: ImageRole, enumName: 'ImageRole' }) role: ImageRole;
  @ApiProperty() position: number;
}

/** A link with the image itself, for admin screens that show thumbnails. */
export class ImageLinkViewDto extends ImageLinkDto {
  @ApiProperty({ type: ImageDto }) image: ImageDto;
}
