import { Logger } from '@nestjs/common';
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

interface JwtPayload {
  sub?: string;
  id?: string;
  userId?: string;
  roles?: string[];
}

const ADMIN_ROLES = new Set(['super_admin', 'exam_admin', 'SUPER_ADMIN', 'EXAM_ADMIN']);

@WebSocketGateway({
  namespace: '/ws/inquiry',
  cors: { origin: true, credentials: true },
})
export class InquiryGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server!: Server;

  private readonly logger = new Logger(InquiryGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async handleConnection(@ConnectedSocket() socket: Socket): Promise<void> {
    const token = this.extractToken(socket);
    if (!token) {
      socket.disconnect(true);
      return;
    }
    try {
      const secret = this.config.get<string>('jwt.accessSecret');
      const payload = this.jwt.verify<JwtPayload>(token, { secret });
      // IMPORTANT: `inquiry.userId` is the User.id (cuid pk), which is
      // exactly `payload.sub`. The legacy fallback to `payload.userId`
      // pointed at the human-readable login id and silently put students
      // in the wrong room, so admin replies never reached them in real
      // time — preferring `sub` keeps the room names symmetric with
      // notifyNewReply/notifyStatusChange below.
      const userId = payload.sub ?? payload.id ?? payload.userId;
      const roles = payload.roles ?? [];
      const isAdmin = roles.some((r) => ADMIN_ROLES.has(r));

      if (!userId) {
        socket.disconnect(true);
        return;
      }

      socket.data.userId = userId;
      socket.data.isAdmin = isAdmin;

      socket.join(`user:${userId}`);

      if (isAdmin) {
        socket.join('admin:inquiries');
        this.logger.log(`Admin connected to inquiry gateway: ${userId}`);
      } else {
        this.logger.log(`User connected to inquiry gateway: ${userId}`);
      }
    } catch (err) {
      this.logger.warn(`Inquiry gateway auth failed: ${(err as Error).message}`);
      socket.disconnect(true);
    }
  }

  handleDisconnect(@ConnectedSocket() socket: Socket): void {
    const userId = socket.data.userId;
    if (userId) {
      socket.leave(`user:${userId}`);
      socket.leave('admin:inquiries');
    }
  }

  @SubscribeMessage('inquiry:subscribe')
  onSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { inquiryId: string },
  ): { ok: true } {
    if (body.inquiryId) {
      socket.join(`inquiry:${body.inquiryId}`);
    }
    return { ok: true };
  }

  @SubscribeMessage('inquiry:unsubscribe')
  onUnsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { inquiryId: string },
  ): { ok: true } {
    if (body.inquiryId) {
      socket.leave(`inquiry:${body.inquiryId}`);
    }
    return { ok: true };
  }

  notifyNewInquiry(inquiry: any): void {
    this.server?.to('admin:inquiries').emit('inquiry:new', {
      id: inquiry.id,
      userId: inquiry.userId,
      userName: inquiry.user?.name ?? 'Unknown',
      category: inquiry.category,
      title: inquiry.title,
      status: inquiry.status,
      createdAt: inquiry.createdAt,
    });
    this.logger.log(`New inquiry notification sent: ${inquiry.id}`);
  }

  notifyNewReply(inquiry: any, reply: any, isAdminReply: boolean): void {
    const payload = {
      inquiryId: inquiry.id,
      replyId: reply.id,
      content: reply.content,
      isAdmin: isAdminReply,
      createdAt: reply.createdAt,
      inquiryStatus: inquiry.status,
    };

    this.server?.to(`inquiry:${inquiry.id}`).emit('inquiry:reply', payload);

    if (isAdminReply) {
      this.server?.to(`user:${inquiry.userId}`).emit('inquiry:admin-reply', {
        ...payload,
        inquiryTitle: inquiry.title,
      });
    } else {
      this.server?.to('admin:inquiries').emit('inquiry:user-reply', {
        ...payload,
        userName: inquiry.user?.name ?? 'Unknown',
        inquiryTitle: inquiry.title,
      });
    }

    this.logger.log(`Reply notification sent for inquiry: ${inquiry.id}`);
  }

  notifyStatusChange(inquiryId: string, status: string, userId: string): void {
    this.server?.to(`inquiry:${inquiryId}`).emit('inquiry:status', { inquiryId, status });
    this.server?.to(`user:${userId}`).emit('inquiry:status', { inquiryId, status });
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
