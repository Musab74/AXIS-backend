import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class PublishResultsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  sessionIds!: string[];
}
