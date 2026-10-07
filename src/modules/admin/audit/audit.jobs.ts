import { BadRequestException, Injectable } from '@nestjs/common';
import { CsvWriter } from '../../../common/csv/csv.js';
import type { Prisma } from '../../../database/generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import {
  JobCanceledError,
  type JobContext,
  JobHandler,
  type JobOutcome,
  type JobRunner,
  params,
} from '../../jobs/job-handler.js';

const PAGE = 2000;

/** `export.audit-log`: who changed what, for a period (compliance, investigations). */
@JobHandler()
@Injectable()
export class ExportAuditLogJob implements JobRunner {
  readonly info = {
    type: 'export.audit-log',
    title: 'Export the audit log',
    description:
      'Audit entries with actor, action, entity, request id, IP and changes (JSON). Parameters: from and to (ISO dates, required), optional entityType and action (exact, or a prefix ending in ".").',
    permission: 'audit-logs:read',
    exampleParams: {
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
      action: 'auth.',
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async validate(p: Record<string, unknown>) {
    params.only(p, ['from', 'to', 'entityType', 'action']);
    const from = params.date(p, 'from');
    const to = params.date(p, 'to');
    if (!from || !to) throw new BadRequestException('from and to are required');
    if (from >= to) throw new BadRequestException('from must be before to');
    const entityType = params.string(p, 'entityType', { max: 64 });
    const action = params.string(p, 'action', { max: 100 });
    return {
      from,
      to,
      ...(entityType ? { entityType } : {}),
      ...(action ? { action } : {}),
    };
  }

  async run(ctx: JobContext): Promise<JobOutcome> {
    const p = ctx.params as {
      from: string;
      to: string;
      entityType?: string;
      action?: string;
    };
    const where: Prisma.AuditLogWhereInput = {
      createdAt: { gte: new Date(p.from), lt: new Date(p.to) },
      ...(p.entityType ? { entityType: p.entityType } : {}),
      ...(p.action
        ? {
            action: p.action.endsWith('.')
              ? { startsWith: p.action }
              : p.action,
          }
        : {}),
    };
    const csv = new CsvWriter([
      'created_at',
      'actor_type',
      'actor',
      'action',
      'entity_type',
      'entity_id',
      'request_id',
      'ip',
      'changes',
    ]);
    const total = await this.prisma.auditLog.count({ where });
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.auditLog.findMany({
        where,
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!rows.length) break;
      csv.add(
        rows.map((a) => [
          a.createdAt,
          a.actorType,
          a.actorLabel,
          a.action,
          a.entityType,
          a.entityId,
          a.requestId,
          a.ip,
          a.changes ?? '',
        ]),
      );
      cursor = rows[rows.length - 1].id;
      await ctx.progress(csv.rows, total);
      if (await ctx.cancelRequested()) throw new JobCanceledError();
    }
    return {
      stats: { rows: csv.rows },
      output: {
        name: `audit-log-${p.from.slice(0, 10)}-${p.to.slice(0, 10)}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: csv.toBuffer(),
      },
    };
  }
}
