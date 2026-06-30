import { Logger, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../integrations/redis/redis.service';

export const EXAM_CANDIDATE_EVENT_CHANNEL = 'exam:candidate-event';
export const examSessionRoom = (sessionId: string): string => `exam:session:${sessionId}`;

interface JwtPayload {
  sub?: string;
  id?: string;
  userId?: string;
}

export interface CandidateEventEnvelope {
  sessionId: string;
  event: string;
  payload: Record<string, unknown>;
}

@WebSocketGateway({
  namespace: '/ws/exam',
  cors: { origin: true, credentials: true },
})
export class ExamSessionGateway implements OnModuleInit, OnGatewayConnection {
  @WebSocketServer()
  private readonly server!: Server;

  private readonly logger = new Logger(ExamSessionGateway.name);
  private readonly recentLocalEmits = new Set<string>();

  constructor(
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.redis.subscribe(EXAM_CANDIDATE_EVENT_CHANNEL, (msg: string) => {
      try {
        const raw = JSON.parse(msg) as CandidateEventEnvelope & { _tag?: string };
        if (this.wasLocallyEmitted(raw._tag)) return;
        const { _tag: _ignored, sessionId, event, payload } = raw;
        void _ignored;
        this.server?.to(examSessionRoom(sessionId)).emit(event, payload);
      } catch (err) {
        this.logger.warn(`bad candidate-event payload: ${(err as Error).message}`);
      }
    });
  }

  private rememberLocal(id: string): void {
    this.recentLocalEmits.add(id);
    setTimeout(() => this.recentLocalEmits.delete(id), 5_000);
  }

  private wasLocallyEmitted(id: string | undefined): boolean {
    return id != null && this.recentLocalEmits.has(id);
  }

  async emitCandidateEvent(
    sessionId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const tag = `e:${sessionId}:${event}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.rememberLocal(tag);
    this.server?.to(examSessionRoom(sessionId)).emit(event, payload);
    const envelope: CandidateEventEnvelope & { _tag: string } = {
      sessionId,
      event,
      payload,
      _tag: tag,
    };
    await this.redis.publish(EXAM_CANDIDATE_EVENT_CHANNEL, JSON.stringify(envelope));
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
      socket.data.userId = payload.sub ?? payload.id ?? payload.userId;
    } catch (err) {
      this.logger.debug(`exam WS rejected (jwt): ${(err as Error).message}`);
      socket.disconnect(true);
    }
  }

  @SubscribeMessage('exam:join')
  async onJoin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { sessionId?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    const userId = socket.data.userId as string | undefined;
    const sessionId = body?.sessionId?.trim();
    if (!userId || !sessionId) {
      return { ok: false, error: 'sessionId required' };
    }
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!session || session.userId !== userId) {
      socket.disconnect(true);
      return { ok: false, error: 'forbidden' };
    }
    socket.join(examSessionRoom(sessionId));
    socket.data.sessionId = sessionId;
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
