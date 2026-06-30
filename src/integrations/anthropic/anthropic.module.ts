import { Module } from '@nestjs/common';
import { ClaudeProctorService } from './claude-proctor.service';
import { ClaudeExamAssistantService } from './claude-exam-assistant.service';

@Module({
  providers: [ClaudeProctorService, ClaudeExamAssistantService],
  exports: [ClaudeProctorService, ClaudeExamAssistantService],
})
export class AnthropicModule {}
