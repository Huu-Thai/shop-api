import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { SecretBox } from './secret-box.js';

/** Seals secrets stored in the database (AES-256-GCM with APP_ENCRYPTION_KEY). */
@Injectable()
export class SecretsService {
  private readonly box?: SecretBox;

  constructor(config: ConfigService<AppConfig, true>) {
    const key = config.get('encryptionKey', { infer: true });
    if (key) this.box = new SecretBox(key);
  }

  get enabled(): boolean {
    return !!this.box;
  }

  seal(value: object): string {
    if (!this.box)
      throw new BadRequestException(
        'Configure APP_ENCRYPTION_KEY before storing credentials',
      );
    return this.box.seal(JSON.stringify(value));
  }

  open<T>(sealed: string): T {
    if (!this.box)
      throw new Error(
        'APP_ENCRYPTION_KEY is not configured; stored credentials cannot be read',
      );
    return JSON.parse(this.box.open(sealed)) as T;
  }
}
