import { Module } from '@nestjs/common';
import { ImagesService } from './images.service.js';
import { MediaController } from './media.controller.js';
import { MediaListener } from './media.listener.js';
import { MediaQuery } from './media.query.js';

/** Images in object storage, their alt texts and links to products, variants and categories. */
@Module({
  controllers: [MediaController],
  providers: [ImagesService, MediaQuery, MediaListener],
  exports: [ImagesService, MediaQuery],
})
export class MediaModule {}
