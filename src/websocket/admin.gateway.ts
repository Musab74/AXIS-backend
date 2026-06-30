import { Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { RedisService } from '../integrations/redis/redis.service';

export interface AdminAiAlertPayload {
  sessionId: string;
  userId: string;
  eventId: string;
  type: 'AI_FLAG_SUSPICIOUS' | 'AI_FLAG_CONFIRMED' | 'AUDIO_HIGH';
  severity: 'LOW' | 'MED' | 'HIGH';
  captionKo: string;
  captionEn: string;
  ruleBroken: string | null;
  evidenceUrl: string | null;
  videoClipUrl: string | null;
  ts: number;
}

const PUB_CHANNEL = 'proctor:ai-alert';

interface JwtPayload {
  sub?: string;
  userId?: string;
  roles?: string[];
}

const ADMIN_ROLES = new Set(['proctor', 'exam_admin', 'super_admin']);

@WebSocketGateway({
  namespace: '/ws',
  cors: { origin: true, credentials: true },
})
export class AdminGateway
  implements OnModuleInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private readonly server!: Server;

  private readonly logger = new Logger(AdminGateway.name);

  constructor(
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.redis.subscribe(PUB_CHANNEL, (message) => {
      try {
        const payload = JSON.parse(message) as AdminAiAlertPayload;
        // Per-session room — admins subscribe via `admin:subscribe` to receive.
        this.server
          ?.to(`session:${payload.sessionId}`)
          .emit('admin:ai-alert', payload);
        // Also broadcast to a global admin firehose room so the live monitor
        // page (which doesn't pre-subscribe to a specific session) sees it.
        this.server?.to('admin:firehose').emit('admin:ai-alert', payload);
      } catch (err) {
        this.logger.warn(`bad alert payload: ${(err as Error).message}`);
      }
    });
  }

  /**
   * Service-side entry point: AI proctor service calls this to emit an alert.
   * Publishes to Redis so the message reaches every Node worker; each worker's
   * gateway subscribes once and fans out to its connected admin sockets.
   */
  async emitAiAlert(payload: AdminAiAlertPayload): Promise<void> {
    await this.redis.publish(PUB_CHANNEL, JSON.stringify(payload));
  }

  async handleConnection(@ConnectedSocket() socket: Socket): Promise<void> {
    const token = this.extractToken(socket);
    if (!token) {
      socket.disconnect(true);
      return;
    }
    try {
      const secret = this.config.get<string>('jwt.accessSecret');
      const payload = this.jwt.verify<JwtPayload>(token, { secret });
      const roles = (payload.roles ?? []).map((r) => r.toLowerCase());
      const isAdmin = roles.some((r) => ADMIN_ROLES.has(r));
      if (!isAdmin) {
        socket.disconnect(true);
        return;
      }
      socket.data.userId = payload.userId ?? payload.sub;
      socket.data.roles = roles;
      socket.join('admin:firehose');
    } catch {
      socket.disconnect(true);
      throw new UnauthorizedException('Invalid token');
    }
  }

  handleDisconnect(@ConnectedSocket() socket: Socket): void {
    socket.leave('admin:firehose');
  }

  @SubscribeMessage('admin:subscribe')
  onSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { sessionId?: string; scheduleId?: string },
  ): { ok: true } {
    if (body.sessionId) socket.join(`session:${body.sessionId}`);
    if (body.scheduleId) socket.join(`schedule:${body.scheduleId}`);
    return { ok: true };
  }

  @SubscribeMessage('admin:unsubscribe')
  onUnsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { sessionId?: string; scheduleId?: string },
  ): { ok: true } {
    if (body.sessionId) socket.leave(`session:${body.sessionId}`);
    if (body.scheduleId) socket.leave(`schedule:${body.scheduleId}`);
    return { ok: true };
  }

  private extractToken(socket: Socket): string | null {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    if (auth && typeof auth.token === 'string') return auth.token;
    const header = socket.handshake.headers?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    const q = socket.handshake.query?.token;
    if (typeof q === 'string') return q;
    return null;
  }
}
