import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@Controller('users/me')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Aggregated MyPage dashboard data' })
  dashboard(@CurrentUser('id') userId: string) {
    return this.svc.getMyDashboard(userId);
  }
}
