/**
 * Rubric Parser Utility
 * 
 * Converts plain-text rubric format to structured JSON for AI scoring.
 * 
 * Input format example:
 *   프롬프트 설계(10점): 역할·맥락·조건·형식 등 프롬프트 구성 요소를 적절히 활용
 *   산출물 품질(15점): 완성도, 논리성, 가독성 등
 * 
 * Output format:
 *   [
 *     { criterion: "프롬프트 설계", maxScore: 10, description: "역할·맥락·조건·형식 등..." },
 *     { criterion: "산출물 품질", maxScore: 15, description: "완성도, 논리성, 가독성 등" }
 *   ]
 */

export interface RubricItem {
  criterion: string;
  maxScore: number;
  description: string;
}

export interface ParsedRubric {
  items: RubricItem[];
  totalScore: number;
  raw: string;
}

const RUBRIC_PATTERN = /^(.+?)\((\d+)점\):\s*(.+)$/;

export function parseRubricToJson(rubricText: string): ParsedRubric {
  const items: RubricItem[] = [];
  const lines = rubricText.trim().split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    const match = trimmed.match(RUBRIC_PATTERN);
    if (match) {
      items.push({
        criterion: match[1].trim(),
        maxScore: parseInt(match[2], 10),
        description: match[3].trim(),
      });
    } else if (trimmed.length > 0) {
      // Line doesn't match pattern but has content - treat as description-only
      const numMatch = trimmed.match(/\((\d+)점\)/);
      if (numMatch) {
        const score = parseInt(numMatch[1], 10);
        const criterion = trimmed.replace(/\((\d+)점\)/, '').trim();
        items.push({
          criterion,
          maxScore: score,
          description: '',
        });
      }
    }
  }
  
  const totalScore = items.reduce((sum, item) => sum + item.maxScore, 0);
  
  return {
    items,
    totalScore,
    raw: rubricText,
  };
}

export function rubricToPrompt(rubric: ParsedRubric): string {
  if (rubric.items.length === 0) {
    return `Evaluate based on the following criteria:\n${rubric.raw}`;
  }
  
  const lines = rubric.items.map((item, i) => {
    const desc = item.description ? `: ${item.description}` : '';
    return `${i + 1}. ${item.criterion} (${item.maxScore}점)${desc}`;
  });
  
  return `Evaluate using the following rubric (total ${rubric.totalScore} points):\n\n${lines.join('\n')}`;
}

export function validateRubric(rubric: ParsedRubric, expectedTotal: number): { valid: boolean; message: string } {
  if (rubric.items.length === 0) {
    return { valid: false, message: 'No rubric items found' };
  }
  
  if (rubric.totalScore !== expectedTotal) {
    return { 
      valid: false, 
      message: `Rubric total (${rubric.totalScore}) does not match expected (${expectedTotal})` 
    };
  }
  
  for (const item of rubric.items) {
    if (!item.criterion) {
      return { valid: false, message: 'Rubric item missing criterion name' };
    }
    if (item.maxScore <= 0) {
      return { valid: false, message: `Invalid score for criterion: ${item.criterion}` };
    }
  }
  
  return { valid: true, message: 'OK' };
}
