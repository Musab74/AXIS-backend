import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, normalize, resolve, sep } from 'path';

export interface NcoConfig {
  accessKey: string;
  secretKey: string;
  region: string;
  endpoint: string;
  bucketSnapshots: string;
}

export interface PutResult {
  key: string;
  bucket: string;
  bytes: number;
}

/**
 * When NCP credentials are not configured (dev / staging / accidental prod
 * misconfig), evidence is written to `axis-backend/uploads/<bucket>/<key>`
 * and `signedGetUrl()` returns a URL pointing at the public route mounted
 * by `LocalEvidenceController`. The URL is HMAC-signed + time-limited so it
 * has the same security shape as an S3 pre-signed URL — the `<img>` tag in
 * the admin browser can fetch it without sending a JWT, but no one can
 * fabricate URLs without the server secret. When NCP IS configured, this
 * code path is dead, so production behavior is unchanged.
 */
@Injectable()
export class NcObjectStorageService {
  private readonly logger = new Logger(NcObjectStorageService.name);
  private readonly client: S3Client | null;
  private readonly cfg: NcoConfig;
  private readonly localSecret: string;
  private readonly appUrl: string;
  private readonly uploadsRoot: string;

  constructor(config: ConfigService) {
    const cfg = config.get<NcoConfig>('ncp');
    this.cfg = cfg ?? {
      accessKey: '',
      secretKey: '',
      region: 'kr-standard',
      endpoint: 'https://kr.object.ncloudstorage.com',
      bucketSnapshots: 'axis-snapshots',
    };
    this.localSecret =
      config.get<{ accessSecret: string }>('jwt')?.accessSecret ||
      process.env.JWT_ACCESS_SECRET ||
      'access-secret';
    this.appUrl =
      config.get<string>('appUrl') || process.env.APP_URL || 'http://localhost:3000';
    this.uploadsRoot = resolve(process.cwd(), 'uploads');

    if (!this.cfg.accessKey || !this.cfg.secretKey) {
      this.logger.warn(
        'NCP credentials missing — NcObjectStorageService is offline. ' +
          'Evidence frames will be written to ./uploads and served via signed local URLs.',
      );
      this.client = null;
      return;
    }

    this.client = new S3Client({
      region: this.cfg.region,
      endpoint: this.cfg.endpoint,
      credentials: {
        accessKeyId: this.cfg.accessKey,
        secretAccessKey: this.cfg.secretKey,
      },
      forcePathStyle: false,
    });
  }

  /** Whether the NCP S3 client is configured. Local fallback is used when false. */
  isConfigured(): boolean {
    return this.client !== null;
  }

  bucketSnapshots(): string {
    return this.cfg.bucketSnapshots;
  }

  async put(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
    ttlDays: number,
  ): Promise<PutResult> {
    const client = this.client;

    if (!client) {
      const filePath = this.resolveLocalPath(bucket, key);
      if (!filePath) {
        throw new Error(`Refusing to write evidence to suspicious local path: ${bucket}/${key}`);
      }
      const fileDir = filePath.substring(0, filePath.lastIndexOf(sep));
      if (!existsSync(fileDir)) {
        mkdirSync(fileDir, { recursive: true });
      }
      writeFileSync(filePath, body);
      this.logger.log(`Local file saved (${contentType}): ${filePath}`);
      return { key, bucket, bytes: body.length };
    }

    const expires = new Date(Date.now() + ttlDays * 86_400_000);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Expires: expires,
        Metadata: {
          'retain-until': expires.toISOString(),
        },
      }),
    );
    return { key, bucket, bytes: body.length };
  }

  async signedGetUrl(key: string, expiresIn: number, bucket?: string): Promise<string> {
    const client = this.client;
    const b = bucket ?? this.cfg.bucketSnapshots;

    if (!client) {
      const exp = Math.floor(Date.now() / 1000) + Math.max(60, Math.floor(expiresIn));
      const sig = this.signLocal(b, key, exp);
      const params = new URLSearchParams({ b, k: key, exp: String(exp), sig });
      return `${this.appUrl.replace(/\/+$/, '')}/proctor/local-evidence?${params.toString()}`;
    }

    const cmd = new GetObjectCommand({
      Bucket: b,
      Key: key,
    });
    return getSignedUrl(client, cmd, { expiresIn });
  }

  /**
   * Verify a local-evidence URL signature. Used by `LocalEvidenceController`.
   * Constant-time comparison prevents timing oracles. Expiry is checked with
   * a 5-second skew tolerance to avoid spurious 410s on slow networks.
   */
  verifyLocalSignature(bucket: string, key: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    if (exp < nowSec - 5) return false;
    const expected = this.signLocal(bucket, key, exp);
    if (expected.length !== sig.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
    } catch {
      return false;
    }
  }

  /**
   * Resolve a `(bucket, key)` pair to an absolute filesystem path under the
   * uploads root. Returns `null` if the resolved path would escape the
   * uploads root (path-traversal guard) or if `bucket`/`key` look malicious.
   */
  resolveLocalPath(bucket: string, key: string): string | null {
    if (!bucket || !key) return null;
    if (bucket.includes('/') || bucket.includes('\\') || bucket.includes('..')) return null;
    if (key.startsWith('/') || key.startsWith('\\')) return null;
    if (key.split(/[\\/]/).some((seg) => seg === '..')) return null;
    const candidate = normalize(join(this.uploadsRoot, bucket, key));
    const expectedPrefix = normalize(this.uploadsRoot) + sep;
    if (!candidate.startsWith(expectedPrefix)) return null;
    return candidate;
  }

  private signLocal(bucket: string, key: string, exp: number): string {
    return createHmac('sha256', this.localSecret)
      .update(`${bucket}|${key}|${exp}`)
      .digest('hex');
  }
}
