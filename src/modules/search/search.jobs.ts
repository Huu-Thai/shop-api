import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import {
  type JobContext,
  JobHandler,
  type JobOutcome,
  type JobRunner,
  params,
} from '../jobs/job-handler.js';
import { SearchListener } from './search.listener.js';

/** `search.reindex`: rebuilds the search documents of some or every website (e.g. nightly). */
@JobHandler()
@Injectable()
export class SearchReindexJob implements JobRunner {
  readonly info = {
    type: 'search.reindex',
    title: 'Rebuild search',
    description:
      'Rebuilds the search documents of the given websites (all when omitted) and pushes them to the active engine.',
    permission: 'catalog:write',
    exampleParams: { websiteIds: ['…'] },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchListener,
  ) {}

  async validate(p: Record<string, unknown>) {
    params.only(p, ['websiteIds']);
    const websiteIds = params.uuids(p, 'websiteIds');
    if (websiteIds?.length) {
      const found = await this.prisma.website.count({
        where: { id: { in: websiteIds } },
      });
      if (found !== new Set(websiteIds).size)
        throw new BadRequestException('Some websites do not exist');
    }
    return websiteIds ? { websiteIds } : {};
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const ids = ctx.params.websiteIds as string[] | undefined;
    await this.search.reindexWebsites(ids);
    const websites = ids?.length ?? (await this.prisma.website.count());
    return { stats: { websites } };
  }
}
