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
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  LINK_MESSAGE,
  LINK_PATTERN,
} from '../../../common/content/content.dto.js';
import { LOCALE_PATTERN } from '../../../common/dto/codes.js';
import { MenuLinkType } from '../../../database/generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const MENU_CODE_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export class CreateMenuDto {
  @ApiProperty({ example: 'main' })
  @MaxLength(64)
  @Matches(MENU_CODE_PATTERN, {
    message: 'code must be lower-case letters and digits joined by "-" or "_"',
  })
  code: string;
  @ApiProperty({ example: 'Main navigation' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name: string;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Omit for every store; a store menu with the same code wins',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  storeId?: string | null;
}

export class UpdateMenuDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name?: string;
}

export class MenuItemLabelDto {
  @ApiProperty({ example: 'en-US' })
  @Matches(LOCALE_PATTERN)
  localeCode: string;
  @ApiProperty({ example: 'Shipping' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  label: string;
}

export class CreateMenuItemDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentId?: string | null;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
  @ApiProperty({ enum: MenuLinkType, enumName: 'MenuLinkType' })
  @IsEnum(MenuLinkType)
  linkType: MenuLinkType;
  @ApiPropertyOptional({
    description: 'Page, post, category or product id (not for URL links)',
  })
  @ValidateIf((o: CreateMenuItemDto) => o.linkType !== 'URL')
  @IsUUID()
  targetId?: string;
  @ApiPropertyOptional({ example: '/sale', description: 'URL links only' })
  @ValidateIf((o: CreateMenuItemDto) => o.linkType === 'URL')
  @MaxLength(512)
  @Matches(LINK_PATTERN, { message: `url ${LINK_MESSAGE}` })
  url?: string;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  openInNewTab?: boolean;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
  @ApiPropertyOptional({
    type: [MenuItemLabelDto],
    description:
      'Labels per locale; without one, page/post/category/product links use the target’s title',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MenuItemLabelDto)
  labels?: MenuItemLabelDto[];
}

export class UpdateMenuItemDto {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Move under another item of the same menu (null = top level)',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  parentId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
  @ApiPropertyOptional({ enum: MenuLinkType, enumName: 'MenuLinkType' })
  @IsOptional()
  @IsEnum(MenuLinkType)
  linkType?: MenuLinkType;
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  targetId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(512)
  @Matches(LINK_PATTERN, { message: `url ${LINK_MESSAGE}` })
  url?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() openInNewTab?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({
    type: [MenuItemLabelDto],
    description: 'Upserted by locale',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MenuItemLabelDto)
  labels?: MenuItemLabelDto[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @Matches(LOCALE_PATTERN, { each: true })
  removeLocales?: string[];
}

export class MenuItemDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true, type: String }) parentId: string | null;
  @ApiProperty() position: number;
  @ApiProperty({ enum: MenuLinkType, enumName: 'MenuLinkType' })
  linkType: MenuLinkType;
  @ApiProperty({ nullable: true, type: String }) targetId: string | null;
  @ApiProperty({ nullable: true, type: String }) url: string | null;
  @ApiProperty() openInNewTab: boolean;
  @ApiProperty() isActive: boolean;
  @ApiProperty({ type: [MenuItemLabelDto] }) labels: MenuItemLabelDto[];
}

export class MenuDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true, type: String }) storeId: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class MenuDetailDto extends MenuDto {
  @ApiProperty({ type: [MenuItemDto], description: 'Flat, in tree order' })
  items: MenuItemDto[];
}

export class StorefrontMenuItemDto {
  @ApiProperty() id: string;
  @ApiProperty() label: string;
  @ApiProperty({
    example: '/help/shipping',
    description: 'Site path or absolute URL',
  })
  url: string;
  @ApiProperty({ enum: MenuLinkType, enumName: 'MenuLinkType' })
  linkType: MenuLinkType;
  @ApiProperty({ nullable: true, type: String }) targetId: string | null;
  @ApiProperty() openInNewTab: boolean;
  @ApiProperty({
    type: () => [StorefrontMenuItemDto],
    description: 'Child items',
  })
  children: StorefrontMenuItemDto[];
}

export class StorefrontMenuDto {
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: [StorefrontMenuItemDto] })
  items: StorefrontMenuItemDto[];
}
