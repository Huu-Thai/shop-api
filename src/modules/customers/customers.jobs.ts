import { BadRequestException, Injectable } from '@nestjs/common';
import { CsvWriter, fileDate } from '../../common/csv/csv.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  JobCanceledError,
  type JobContext,
  JobHandler,
  type JobOutcome,
  type JobRunner,
  params,
} from '../jobs/job-handler.js';
import { StoresQuery } from '../stores/stores.query.js';

const PAGE = 1000;

/**
 * `export.customers`: customer accounts (personal data — the file needs `customers:read`, is only
 * reachable through short-lived links and is deleted after JOBS_FILE_RETENTION_DAYS).
 */
@JobHandler()
@Injectable()
export class ExportCustomersJob implements JobRunner {
  readonly info = {
    type: 'export.customers',
    title: 'Export customers',
    description:
      'Customer accounts: website, email, names, phone, group, status, marketing consent, locale, created and last sign-in. Optional parameters website (a code) and acceptsMarketing (true to export only consenting customers).',
    permission: 'customers:read',
    exampleParams: { website: 'us', acceptsMarketing: true },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly stores: StoresQuery,
  ) {}

  async validate(p: Record<string, unknown>) {
    params.only(p, ['website', 'acceptsMarketing']);
    const website = params.string(p, 'website', { max: 64 });
    if (website) {
      const snap = await this.stores.snapshot(true);
      if (![...snap.byId.values()].some((s) => s.websiteCode === website))
        throw new BadRequestException(`Unknown website ${website}`);
    }
    if (
      p.acceptsMarketing !== undefined &&
      typeof p.acceptsMarketing !== 'boolean'
    )
      throw new BadRequestException('acceptsMarketing must be true or false');
    return {
      ...(website ? { website } : {}),
      ...(p.acceptsMarketing !== undefined
        ? { acceptsMarketing: p.acceptsMarketing }
        : {}),
    };
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const snap = await this.stores.snapshot(true);
    const websiteCode = new Map(
      [...snap.byId.values()].map((s) => [s.websiteId, s.websiteCode]),
    );
    const website = ctx.params.website as string | undefined;
    const websiteId = website
      ? [...websiteCode].find(([, code]) => code === website)?.[0]
      : undefined;
    const where = {
      ...(websiteId ? { websiteId } : {}),
      ...(ctx.params.acceptsMarketing !== undefined
        ? { acceptsMarketing: ctx.params.acceptsMarketing as boolean }
        : {}),
    };
    const csv = new CsvWriter([
      'website',
      'email',
      'first_name',
      'last_name',
      'phone',
      'group',
      'status',
      'accepts_marketing',
      'locale',
      'created_at',
      'last_login_at',
    ]);
    const total = await this.prisma.customer.count({ where });
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.customer.findMany({
        where,
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          websiteId: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          status: true,
          acceptsMarketing: true,
          localeCode: true,
          createdAt: true,
          lastLoginAt: true,
          customerGroup: { select: { code: true } },
        },
      });
      if (!rows.length) break;
      csv.add(
        rows.map((c) => [
          websiteCode.get(c.websiteId) ?? '',
          c.email,
          c.firstName,
          c.lastName,
          c.phone,
          c.customerGroup.code,
          c.status,
          c.acceptsMarketing,
          c.localeCode,
          c.createdAt,
          c.lastLoginAt,
        ]),
      );
      cursor = rows[rows.length - 1].id;
      await ctx.progress(csv.rows, total);
      if (await ctx.cancelRequested()) throw new JobCanceledError();
    }
    return {
      stats: { rows: csv.rows },
      output: {
        name: `customers${website ? `-${website}` : ''}-${fileDate()}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: csv.toBuffer(),
      },
    };
  }
}
