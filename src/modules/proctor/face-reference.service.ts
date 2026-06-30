import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

interface DemoReferenceEntry {
  image: Buffer;
  storedAt: number;
}

const DEMO_TTL_MS = 60 * 60 * 1000; // 60 minutes — matches the longest L1 demo

/**
 * Storage for the per-user reference face image used by the in-exam identity
 * recheck. Two scopes:
 *
 *  • EXAM — persisted on `User.referenceFaceImage`, written once when the user
 *           passes /identity-verification/verify. Survives reloads.
 *  • DEMO — kept in-process only (a Map with TTL). Captured by the demo runner
 *           at Start so a roommate swap mid-demo is caught, but no demo selfie
 *           ever lands in the DB (PIPA: collect minimum, retain shortest).
 *
 * The demo cache is per-process — fine for a single API instance. If we scale
 * out behind a load balancer, lift this into Redis with the same TTL.
 */
@Injectable()
export class FaceReferenceService {
  private readonly logger = new Logger(FaceReferenceService.name);
  private readonly demoCache = new Map<string, DemoReferenceEntry>();

  constructor(private readonly prisma: PrismaService) {}

  async setExamReference(userId: string, image: Buffer): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        referenceFaceImage: image,
        referenceFaceUpdatedAt: new Date(),
      },
    });
    this.logger.log(`Exam reference face stored for user=${userId} bytes=${image.length}`);
  }

  async getExamReference(userId: string): Promise<Buffer | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referenceFaceImage: true },
    });
    const blob = row?.referenceFaceImage ?? null;
    if (!blob) return null;
    return Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  }

  setDemoReference(userId: string, image: Buffer): void {
    this.demoCache.set(userId, { image, storedAt: Date.now() });
    this.logger.log(`Demo reference face stored for user=${userId} bytes=${image.length}`);
  }

  getDemoReference(userId: string): Buffer | null {
    const entry = this.demoCache.get(userId);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > DEMO_TTL_MS) {
      this.demoCache.delete(userId);
      return null;
    }
    return entry.image;
  }

  clearDemoReference(userId: string): void {
    this.demoCache.delete(userId);
  }
}
