import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration.js';
import { poolConfig, PrismaService } from './prisma.service.js';

describe('PrismaService', () => {
  const config = {
    get: () => ({ url: 'postgresql://u:p@localhost:5432/db' }),
  } as unknown as ConfigService<AppConfig, true>;

  it('connects on init and disconnects on destroy', async () => {
    const service = new PrismaService(config);
    const connect = vi.spyOn(service, '$connect').mockResolvedValue(undefined);
    const disconnect = vi
      .spyOn(service, '$disconnect')
      .mockResolvedValue(undefined);
    await service.onModuleInit();
    await service.onApplicationShutdown();
    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('pins sessions to UTC (the pg adapter sends timestamps without an offset)', () => {
    expect(
      poolConfig({
        url: 'postgresql://u:p@localhost:5432/db',
        poolMax: 5,
        poolTimeoutMs: 1000,
      } as AppConfig['database']),
    ).toMatchObject({ options: '-c TimeZone=UTC' });
  });
});
