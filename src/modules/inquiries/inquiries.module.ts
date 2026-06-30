import { Module } from '@nestjs/common';
import { InquiriesController, AdminInquiriesController } from './inquiries.controller';
import { InquiryUploadsController } from './inquiry-uploads.controller';
import { InquiriesService } from './inquiries.service';
import { InquiryGateway } from './inquiry.gateway';
import { AdminNotificationsModule } from '../adminNotifications/admin-notifications.module';
import { PrismaService } from '../../common/prisma.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    AdminNotificationsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
      }),
    }),
  ],
  controllers: [InquiriesController, AdminInquiriesController, InquiryUploadsController],
  providers: [InquiriesService, InquiryGateway, PrismaService],
  exports: [InquiryGateway],
})
export class InquiriesModule {}
