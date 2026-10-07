import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateApiKey } from '../../../common/auth/api-key-format.js';
import { actorOf, type Principal } from '../../../common/auth/principal.js';
import { TransactionalEventBus } from '../../../common/events/transactional-event-bus.js';
import type { Prisma } from '../../../database/generated/prisma/client.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { assertGrantable } from '../roles/grant.js';
import type {
  ApiKeyCreatedDto,
  ApiKeyDto,
  CreateApiKeyDto,
} from './dto/api-key.dto.js';
import {
  ApiKeyBeforeWriteEvent,
  ApiKeyCreatedEvent,
  ApiKeyRevokedEvent,
} from './events/api-key.events.js';

const SELECT = {
  id: true,
  name: true,
  prefix: true,
  permissions: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
  createdBy: { select: { email: true } },
} as const satisfies Prisma.ApiKeySelect;
type Row = Prisma.ApiKeyGetPayload<{ select: typeof SELECT }>;

const toDto = ({ createdBy, permissions, ...k }: Row): ApiKeyDto => ({
  ...k,
  permissions: permissions ?? [],
  createdBy: createdBy?.email ?? null,
});

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: TransactionalEventBus,
  ) {}

  async list(includeRevoked: boolean): Promise<ApiKeyDto[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: includeRevoked ? {} : { revokedAt: null },
      select: SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDto);
  }

  /** The raw key is returned once and never stored (only its SHA-256). */
  async create(
    dto: CreateApiKeyDto,
    actor: Principal,
  ): Promise<ApiKeyCreatedDto> {
    const permissions = assertGrantable(actor, dto.permissions);
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date())
      throw new BadRequestException('expiresAt must be in the future');
    const { key, prefix, hash } = generateApiKey();
    const row = await this.bus.write({
      before: new ApiKeyBeforeWriteEvent('create', null, actorOf(actor)),
      work: async (tx, after) => {
        const k = await tx.apiKey.create({
          data: {
            name: dto.name,
            prefix,
            keyHash: hash,
            permissions,
            expiresAt,
            createdById: actor.type === 'admin' ? actor.id : null,
          },
          select: SELECT,
        });
        after.add(
          new ApiKeyCreatedEvent(
            actorOf(actor),
            k.id,
            k.name,
            prefix,
            permissions,
          ),
        );
        return k;
      },
    });
    return { ...toDto(row), key };
  }

  async revoke(id: string, actor: Principal): Promise<void> {
    await this.bus.write({
      before: new ApiKeyBeforeWriteEvent('revoke', id, actorOf(actor)),
      work: async (tx, after) => {
        const k = await tx.apiKey.findUnique({
          where: { id },
          select: { id: true, name: true, revokedAt: true },
        });
        if (!k) throw new NotFoundException(`API key ${id} not found`);
        if (k.revokedAt) return;
        await tx.apiKey.update({
          where: { id },
          data: { revokedAt: new Date() },
        });
        after.add(new ApiKeyRevokedEvent(actorOf(actor), id, k.name));
      },
    });
  }
}
