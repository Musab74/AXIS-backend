import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { AdminNotificationsService } from './admin-notifications.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

@ApiTags('admin-notifications')
@ApiBearerAuth()
@Controller('admin/notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'EXAM_ADMIN', 'GRADING_ADMIN', 'PROCTOR')
export class AdminNotificationsController {
  constructor(private readonly svc: AdminNotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Admin notification inbox' })
  list(@CurrentUser('id') userId: string) {
    return this.svc.listInbox(userId);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread notification count for bell badge' })
  async unread(@CurrentUser('id') userId: string) {
    const count = await this.svc.unreadCount(userId);
    return { count };
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Global admin notification category toggles' })
  preferences() {
    return this.svc.getPreferences();
  }

  @Patch('preferences')
  @Roles('SUPER_ADMIN', 'EXAM_ADMIN')
  @ApiOperation({ summary: 'Update which notification categories are active' })
  updatePreferences(@Body() dto: UpdateNotificationPreferencesDto) {
    return this.svc.updatePreferences(dto);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async markAllRead(@CurrentUser('id') userId: string) {
    await this.svc.markAllRead(userId);
    return { ok: true };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark a single notification as read' })
  async markRead(@CurrentUser('id') userId: string, @Param('id') id: string) {
    await this.svc.markRead(userId, id);
    return { ok: true };
  }
}
