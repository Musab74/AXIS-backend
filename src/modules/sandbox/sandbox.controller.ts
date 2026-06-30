import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SandboxService, CodeRunInput } from './sandbox.service';

class CodeRunDto implements CodeRunInput {
  sourceCode!: string;
  languageId!: number;
  stdin?: string;
}

class CodeTestDto extends CodeRunDto {
  taskId!: string;
}

class CodeSubmitDto extends CodeRunDto {
  taskId!: string;
}

@ApiTags('sandbox')
@ApiBearerAuth()
@Controller('cbt/sessions/:id')
@UseGuards(JwtAuthGuard)
export class SandboxController {
  constructor(private readonly svc: SandboxService) {}

  /**
   * Run code without test cases. Returns raw stdout/stderr so the candidate
   * can verify basic output before committing to a final submission.
   * Rate-limited to 30 runs per session.
   */
  @Post('code/run')
  @ApiOperation({ summary: 'Run code (AXIS-C, no test cases)' })
  run(
    @CurrentUser('id') userId: string,
    @Param('id') sessionId: string,
    @Body() dto: CodeRunDto,
  ) {
    return this.svc.runCode(userId, sessionId, dto);
  }

  /**
   * Run code against the task's visible sample test cases. Returns per-case
   * pass/fail. Hidden test cases are only evaluated on final code submission.
   */
  @Post('code/test')
  @ApiOperation({ summary: 'Run code against sample test cases (AXIS-C)' })
  test(
    @CurrentUser('id') userId: string,
    @Param('id') sessionId: string,
    @Body() dto: CodeTestDto,
  ) {
    return this.svc.runTests(userId, sessionId, dto.taskId, dto);
  }

  /**
   * Final code submission for an AXIS-C task. Persists the source code as the
   * candidate's answer and runs it through the sandbox. Re-submitting before
   * the exam ends overwrites the previous code. The grader reviews `contentText`
   * as the submitted solution.
   */
  @Post('code/submit')
  @ApiOperation({ summary: 'Final code submission (AXIS-C)' })
  submit(
    @CurrentUser('id') userId: string,
    @Param('id') sessionId: string,
    @Body() dto: CodeSubmitDto,
  ) {
    return this.svc.submitCode(userId, sessionId, dto.taskId, dto);
  }
}
