import { Module } from '@nestjs/common';
import { CORE_IMPORTS } from '../app.module.js';

@Module({ imports: [...CORE_IMPORTS] })
export class CliModule {}
