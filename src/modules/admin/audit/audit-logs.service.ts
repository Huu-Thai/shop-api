import { Injectable } from '@nestjs/common';
import {
  paginated,
  type Paginated,
} from '../../../common/dto/pagination.dto.js';
import type { Prisma } from '../../../database/generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import type {
  AuditLogDto,
  ListAuditLogsQueryDto,
} from './dto/audit-log.dto.js';

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ListAuditLogsQueryDto): Promise<Paginated<AuditLogDto>> {
    const where: Prisma.AuditLogWhereInput = {
      entityType: q.entityType,
      entityId: q.entityId,
      actorId: q.actorId,
      ...(q.action
        ? {
            action: q.action.endsWith('.')
              ? { startsWith: q.action }
              : q.action,
          }
        : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lt: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: q.order },
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginated(rows, total, q);
  }
}
