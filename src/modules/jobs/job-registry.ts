import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { JobHandler, type JobRunner, type JobTypeInfo } from './job-handler.js';

/** Every job type of the application, discovered from `@JobHandler()` providers. */
@Injectable()
export class JobRegistry implements OnModuleInit {
  private readonly logger = new Logger(JobRegistry.name);
  private readonly runners = new Map<string, JobRunner>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: JobHandler.KEY,
    })) {
      const runner = wrapper.instance as JobRunner | undefined;
      if (!runner?.info) continue;
      if (this.runners.has(runner.info.type))
        throw new Error(`Job type ${runner.info.type} is registered twice`);
      this.runners.set(runner.info.type, runner);
    }
    this.logger.log(`Job types: ${[...this.runners.keys()].sort().join(', ')}`);
  }

  types(): JobTypeInfo[] {
    return [...this.runners.values()]
      .map((r) => r.info)
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  get(type: string): JobRunner {
    const r = this.runners.get(type);
    if (!r)
      throw new BadRequestException(
        `Unknown job type "${type}" (see GET /admin/jobs/types)`,
      );
    return r;
  }

  has(type: string): boolean {
    return this.runners.has(type);
  }
}
