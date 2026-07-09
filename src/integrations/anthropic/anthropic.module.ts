import { Module } from '@nestjs/common';
import { ClaudeProctorService } from './claude-proctor.service';
import { ClaudeExamAssistantService } from './claude-exam-assistant.service';
import { ExamTranslationService } from './exam-translation.service';

@Module({
  providers: [ClaudeProctorService, ClaudeExamAssistantService, ExamTranslationService],
  exports: [ClaudeProctorService, ClaudeExamAssistantService, ExamTranslationService],
})
export class AnthropicModule {}
