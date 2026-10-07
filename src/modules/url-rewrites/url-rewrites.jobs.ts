import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import {
  type JobContext,
  JobHandler,
  type JobOutcome,
  type JobRunner,
  params,
} from '../jobs/job-handler.js';
import { UrlRewritesService } from './url-rewrites.service.js';

/** `url-rewrites.rebuild`: regenerates storefront URLs of some or every store. */
@JobHandler()
@Injectable()
export class UrlRewritesRebuildJob implements JobRunner {
  readonly info = {
    type: 'url-rewrites.rebuild',
    title: 'Rebuild storefront URLs',
    description:
      'Regenerates the product and category URLs of the given stores (all when omitted). Custom redirects are kept.',
    permission: 'catalog:write',
    exampleParams: { storeIds: ['…'] },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly rewrites: UrlRewritesService,
  ) {}

  async validate(p: Record<string, unknown>) {
    params.only(p, ['storeIds']);
    const storeIds = params.uuids(p, 'storeIds');
    if (storeIds?.length) {
      const found = await this.prisma.store.count({
        where: { id: { in: storeIds } },
      });
      if (found !== new Set(storeIds).size)
        throw new BadRequestException('Some stores do not exist');
    }
    return storeIds ? { storeIds } : {};
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const ids = await this.rewrites.enqueueStoreRebuild(
      ctx.params.storeIds as string[] | undefined,
    );
    return { stats: { stores: ids.length } };
  }
}
