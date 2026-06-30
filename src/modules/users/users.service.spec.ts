import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';

describe('UsersService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    niceSession: {
      findUnique: jest.fn(),
    },
  };

  const authSessions = {
    revokeSession: jest.fn(async () => undefined),
  };

  function svc() {
    return new UsersService(prisma as never, authSessions as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('changePassword', () => {
    it('rejects when current password is wrong', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u1',
        passwordHash: await bcrypt.hash('correct', 4),
      });

      await expect(
        svc().changePassword('u1', 'wrong', 'NewPass123!'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('updates hash when current password matches', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u1',
        passwordHash: await bcrypt.hash('OldPass123!', 4),
      });
      prisma.user.update.mockResolvedValueOnce({ id: 'u1' });

      const result = await svc().changePassword('u1', 'OldPass123!', 'NewPass123!');

      expect(result.success).toBe(true);
      expect(authSessions.revokeSession).toHaveBeenCalledWith('u1');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u1' },
          data: expect.objectContaining({
            passwordHash: expect.any(String),
          }),
        }),
      );
    });
  });

  describe('updatePhoneWithNice', () => {
    const baseUser = {
      id: 'u1',
      name: '홍길동',
      birthDate: '19950315',
      ci: 'ci-1',
      di: null,
      phone: '01011112222',
    };

    it('rejects when NICE name does not match profile', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(baseUser);
      prisma.niceSession.findUnique.mockResolvedValueOnce({
        id: 'nice-1',
        status: 'SUCCESS',
        resultData: JSON.stringify({
          name: '김철수',
          phone: '01099998888',
          birthDate: '19950315',
          ci: 'ci-1',
        }),
      });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', ci: 'ci-1' });

      await expect(svc().updatePhoneWithNice('u1', 'nice-1', '01099998888')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('updates phone when identity matches', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(baseUser);
      prisma.niceSession.findUnique.mockResolvedValueOnce({
        id: 'nice-1',
        status: 'SUCCESS',
        resultData: JSON.stringify({
          name: '홍길동',
          phone: '010-9999-8888',
          birthDate: '19950315',
          ci: 'ci-1',
        }),
      });
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', ci: 'ci-1' });
      prisma.user.update.mockResolvedValueOnce({
        id: 'u1',
        userId: 'test01',
        phone: '01099998888',
      });

      const result = await svc().updatePhoneWithNice('u1', 'nice-1', '01099998888');

      expect(result.phone).toBe('01099998888');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { phone: '01099998888', niceVerified: true },
      });
    });
  });
});
