import { Module } from '@nestjs/common';
import { CORE_IMPORTS, DOMAIN_IMPORTS } from '../app.module.js';

/** CLI context with the domain modules (seeding goes through their services and events). */
@Module({ imports: [...CORE_IMPORTS, ...DOMAIN_IMPORTS] })
export class SeedModule {}
