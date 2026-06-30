import { Module } from '@nestjs/common';
import {
  PublicNoticesController,
  PublicFaqController,
  AdminNoticesController,
  AdminFaqController,
} from './content.controller';
import { PublicSiteController } from './site-public.controller';
import { ContentService } from './content.service';
import { PrismaService } from '../../common/prisma.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
      }),
    }),
  ],
  controllers: [
    PublicNoticesController,
    PublicFaqController,
    PublicSiteController,
    AdminNoticesController,
    AdminFaqController,
  ],
  providers: [ContentService, PrismaService],
})
export class ContentModule {}
