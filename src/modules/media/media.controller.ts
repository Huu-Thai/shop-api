import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import {
  ImageDto,
  ImageLinkDto,
  ImageLinkViewDto,
  ImageListDto,
  ListImagesQueryDto,
  SetImageLinksDto,
  UpdateImageDto,
  UploadImageDto,
} from './dto/image.dto.js';
import {
  type ImageData,
  ImagesService,
  type UploadedFile as File,
} from './images.service.js';
import { MediaQuery } from './media.query.js';

/** Hard cap for multer; the configured MEDIA_MAX_UPLOAD_MB is enforced by the service. */
const MULTER_LIMIT = 100 * 1024 * 1024;

@ApiTags('admin · media')
@Controller('admin')
export class MediaController {
  constructor(
    private readonly images: ImagesService,
    private readonly media: MediaQuery,
  ) {}

  private async withUrls(i: ImageData): Promise<ImageDto> {
    const thumb = i.renditions.find((r) => r.width >= 320);
    const [url, thumbnailUrl] = await Promise.all([
      this.media.url(i.storageKey),
      thumb ? this.media.url(thumb.key) : this.media.url(i.storageKey),
    ]);
    return { ...i, url, thumbnailUrl };
  }

  private async withImages(links: ImageLinkDto[]): Promise<ImageLinkViewDto[]> {
    const images = await this.images.getMany([
      ...new Set(links.map((l) => l.imageId)),
    ]);
    const byId = new Map(
      await Promise.all(
        images.map(async (i) => [i.id, await this.withUrls(i)] as const),
      ),
    );
    return links.flatMap((l) => {
      const image = byId.get(l.imageId);
      return image ? [{ ...l, image }] : [];
    });
  }

  @Get('images')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: ImageListDto })
  async list(@Query() q: ListImagesQueryDto) {
    const page = await this.images.list(q);
    return {
      ...page,
      data: await Promise.all(page.data.map((i) => this.withUrls(i))),
    };
  }

  @Get('images/:id')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: ImageDto })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.withUrls(await this.images.get(id));
  }

  @Post('images')
  @RequirePermissions('catalog:write')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MULTER_LIMIT, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'JPEG, PNG, WebP, AVIF or GIF',
        },
        localeCode: { type: 'string', example: 'en-US' },
        alt: { type: 'string', example: 'Red classic tee, front' },
      },
    },
  })
  @ApiOperation({
    summary:
      'Upload an image (deduplicated by content); renditions follow asynchronously',
  })
  @ApiCreatedResponse({ type: ImageDto })
  async upload(
    @UploadedFile() file: File | undefined,
    @Body() body: UploadImageDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.withUrls(
      await this.images.upload(
        file,
        { localeCode: body.localeCode, alt: body.alt },
        p,
      ),
    );
  }

  @Patch('images/:id')
  @RequirePermissions('catalog:write')
  @ApiOkResponse({ type: ImageDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateImageDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.withUrls(await this.images.update(id, dto, p));
  }

  @Delete('images/:id')
  @RequirePermissions('catalog:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiQuery({ name: 'force', required: false, type: Boolean })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description: 'The image is linked and force is not set',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('force', new ParseBoolPipe({ optional: true }))
    force: boolean | undefined,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.images.remove(id, force ?? false, p);
  }

  @Get('products/:id/images')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: [ImageLinkViewDto] })
  async productImages(@Param('id', ParseUUIDPipe) id: string) {
    return this.withImages(await this.images.links('PRODUCT', id));
  }

  @Get('products/:id/variants/:variantId/images')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: [ImageLinkViewDto] })
  async variantImages(@Param('variantId', ParseUUIDPipe) variantId: string) {
    return this.withImages(await this.images.links('VARIANT', variantId));
  }

  @Get('categories/:id/images')
  @RequirePermissions('catalog:read')
  @ApiOkResponse({ type: [ImageLinkViewDto] })
  async categoryImages(@Param('id', ParseUUIDPipe) id: string) {
    return this.withImages(await this.images.links('CATEGORY', id));
  }

  @Put('products/:id/images')
  @RequirePermissions('catalog:write')
  @ApiOkResponse({ type: [ImageLinkViewDto] })
  async setProductImages(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetImageLinksDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.withImages(await this.images.setLinks('PRODUCT', id, dto, p));
  }

  @Put('products/:id/variants/:variantId/images')
  @RequirePermissions('catalog:write')
  @ApiOkResponse({ type: [ImageLinkViewDto] })
  async setVariantImages(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: SetImageLinksDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.withImages(
      await this.images.setLinks('VARIANT', variantId, dto, p),
    );
  }

  @Put('categories/:id/images')
  @RequirePermissions('catalog:write')
  @ApiOkResponse({ type: [ImageLinkViewDto] })
  async setCategoryImages(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetImageLinksDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.withImages(await this.images.setLinks('CATEGORY', id, dto, p));
  }
}
