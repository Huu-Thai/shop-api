import { Module } from '@nestjs/common';
import { WebhookDispatcher } from './webhook-dispatcher.js';
import { WebhookSender } from './webhook-sender.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

/** Outgoing webhooks: subscriptions, the event dispatcher, signed and retried deliveries. */
@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDispatcher, WebhookSender],
  exports: [WebhooksService, WebhookSender],
})
export class WebhooksModule {}
