import { Module } from '@nestjs/common';
import { CategoryImageOwnerListener } from './image-owner.listener.js';
import { AttributesQuery } from './attributes.query.js';
import { AttributesService } from './attributes.service.js';
import { CategoriesQuery } from './categories.query.js';
import { CategoriesService } from './categories.service.js';
import {
  AttributesController,
  CategoriesController,
} from './catalog.admin.controller.js';

/** Attributes, attribute sets and the category tree. Other modules read through the *Query services. */
@Module({
  controllers: [AttributesController, CategoriesController],
  providers: [
    AttributesService,
    AttributesQuery,
    CategoriesService,
    CategoriesQuery,
    CategoryImageOwnerListener,
  ],
  exports: [AttributesQuery, CategoriesQuery],
})
export class CatalogModule {}
