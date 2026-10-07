import { type LookupAddress, type LookupOptions, lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, request } from 'undici';
import type { AppConfig } from '../../config/configuration.js';

/** Addresses a webhook may never reach (SSRF): loopback, private, link-local, metadata, … */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv6');

export function isBlockedAddress(address: string): boolean {
  const v = isIP(address);
  if (!v) return true;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
  return BLOCKED.check(address, v === 6 ? 'ipv6' : 'ipv4');
}

export class BlockedTargetError extends Error {}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * dns.lookup with the SSRF check, for socket connects. Node asks for one address or for all of them
 * (`all: true`, Happy Eyeballs): either way, any private address refuses the connection.
 */
export function safeLookup(
  hostname: string,
  options: LookupOptions,
  cb: LookupCallback,
  allowPrivate: boolean,
): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, []);
    const blocked = allowPrivate
      ? undefined
      : addresses.find((a) => isBlockedAddress(a.address));
    if (blocked)
      return cb(
        new BlockedTargetError(
          `${hostname} resolves to a private address (${blocked.address}); webhooks can't reach internal networks`,
        ),
        [],
      );
    if (options.all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  durationMs: number;
}

/**
 * POSTs webhook bodies. The address is checked when the connection is made (not only when the URL
 * was saved), so a host that later resolves to an internal address — DNS rebinding — is refused.
 * Redirects are not followed (undici only follows them with an interceptor); the response body is
 * read up to 1 KB.
 */
@Injectable()
export class WebhookSender implements OnModuleDestroy {
  private readonly agent: Agent;
  private readonly timeoutMs: number;
  private readonly allowPrivate: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    const { timeoutMs, allowPrivateTargets } = config.get('webhooks', {
      infer: true,
    });
    this.timeoutMs = timeoutMs;
    this.allowPrivate = allowPrivateTargets;
    this.agent = new Agent({
      connect: {
        timeout: timeoutMs,
        lookup: (hostname, options, cb) =>
          safeLookup(hostname, options, cb, allowPrivateTargets),
      },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.agent.close();
  }

  async send(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<SendResult> {
    const started = Date.now();
    // An IP literal is connected to without a DNS lookup: check it here.
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (!this.allowPrivate && isIP(host) && isBlockedAddress(host))
      return {
        ok: false,
        status: null,
        body: null,
        error: `${host} is a private address; webhooks can't reach internal networks`,
        durationMs: 0,
      };
    try {
      const res = await request(url, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'shop-webhooks/1',
          ...headers,
        },
        dispatcher: this.agent,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      let text = '';
      for await (const chunk of res.body) {
        text += chunk.toString();
        if (text.length >= 1000) break;
      }
      res.body.destroy();
      return {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body: text.slice(0, 1000) || null,
        error: null,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      const err = e as Error & { cause?: Error };
      return {
        ok: false,
        status: null,
        body: null,
        error: (err.cause?.message ?? err.message).slice(0, 1000),
        durationMs: Date.now() - started,
      };
    }
  }
}
