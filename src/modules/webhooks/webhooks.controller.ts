import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Principal } from '../../common/auth/principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../common/decorators/auth.decorators.js';
import {
  CreateWebhookDto,
  ListDeliveriesQueryDto,
  UpdateWebhookDto,
  WebhookDeliveryDto,
  WebhookDeliveryPageDto,
  WebhookDto,
  WebhookEventTypeDto,
  WebhookWithSecretDto,
} from './dto/webhooks.dto.js';
import { WebhooksService } from './webhooks.service.js';

@ApiTags('admin · webhooks')
@Controller('admin')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('webhooks/events')
  @RequirePermissions('webhooks:read')
  @ApiOperation({ summary: 'Events a webhook can subscribe to' })
  @ApiOkResponse({ type: [WebhookEventTypeDto] })
  events() {
    return this.webhooks.events();
  }

  @Get('webhooks')
  @RequirePermissions('webhooks:read')
  @ApiOkResponse({ type: [WebhookDto] })
  list() {
    return this.webhooks.list();
  }

  @Post('webhooks')
  @RequirePermissions('webhooks:write')
  @ApiOperation({
    summary:
      'Subscribe a URL to events; the response carries the signing secret (only this once)',
  })
  @ApiCreatedResponse({ type: WebhookWithSecretDto })
  create(@Body() dto: CreateWebhookDto, @CurrentPrincipal() p: Principal) {
    return this.webhooks.create(dto, p);
  }

  @Get('webhooks/:id')
  @RequirePermissions('webhooks:read')
  @ApiOkResponse({ type: WebhookDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.get(id);
  }

  @Patch('webhooks/:id')
  @RequirePermissions('webhooks:write')
  @ApiOkResponse({ type: WebhookDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWebhookDto,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.webhooks.update(id, dto, p);
  }

  @Delete('webhooks/:id')
  @RequirePermissions('webhooks:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Deleted with its deliveries' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.webhooks.remove(id, p);
  }

  @Post('webhooks/:id/rotate-secret')
  @RequirePermissions('webhooks:write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A new signing secret (the old one stops at once)' })
  @ApiOkResponse({ type: WebhookWithSecretDto })
  rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.webhooks.rotateSecret(id, p);
  }

  @Post('webhooks/:id/test')
  @RequirePermissions('webhooks:write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a webhook.ping delivery now' })
  @ApiAcceptedResponse({ type: WebhookDeliveryDto })
  test(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.webhooks.test(id, p);
  }

  @Get('webhooks/:id/deliveries')
  @RequirePermissions('webhooks:read')
  @ApiOkResponse({ type: WebhookDeliveryPageDto })
  deliveries(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ListDeliveriesQueryDto,
  ) {
    return this.webhooks.deliveries(id, q);
  }

  @Post('webhook-deliveries/:id/redeliver')
  @RequirePermissions('webhooks:write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a delivery again (a new round of retries)' })
  @ApiAcceptedResponse({ type: WebhookDeliveryDto })
  redeliver(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.webhooks.redeliver(id, p);
  }
}
