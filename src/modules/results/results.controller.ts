import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResultsService } from './results.service';

@ApiTags('Results')
@Controller('results')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ResultsController {
  constructor(private readonly svc: ResultsService) {}

  @Get('mine')
  @ApiOperation({ summary: 'List my exam results' })
  mine(@CurrentUser('id') userId: string) {
    return this.svc.listMine(userId);
  }
}
