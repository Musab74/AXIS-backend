import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface Judge0SubmitInput {
  sourceCode: string;
  languageId: number;
  stdin?: string;
  expectedOutput?: string;
}

export type Judge0StatusId =
  | 1  // In Queue
  | 2  // Processing
  | 3  // Accepted
  | 4  // Wrong Answer
  | 5  // Time Limit Exceeded
  | 6  // Compilation Error
  | 7  // Runtime Error (SIGSEGV)
  | 8  // Runtime Error (SIGXFSZ)
  | 9  // Runtime Error (SIGFPE)
  | 10 // Runtime Error (SIGABRT)
  | 11 // Runtime Error (NZEC)
  | 12 // Runtime Error (Other)
  | 13 // Internal Error
  | 14; // Exec Format Error

export interface Judge0Result {
  token: string;
  statusId: Judge0StatusId;
  statusDescription: string;
  stdout: string | null;
  stderr: string | null;
  compileOutput: string | null;
  time: string | null;
  memory: number | null;
  message: string | null;
}

/** Judge0 status IDs that indicate the submission has finished (not pending). */
const TERMINAL_STATUS_IDS = new Set<number>([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

interface Judge0SubmissionResponse {
  token: string;
}

interface Judge0StatusResponse {
  status: { id: number; description: string };
  stdout: string | null;
  stderr: string | null;
  compile_output: string | null;
  time: string | null;
  memory: number | null;
  message: string | null;
}

@Injectable()
export class Judge0Service {
  private readonly logger = new Logger(Judge0Service.name);
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(config: ConfigService) {
    const j0 = config.get<{ url: string; authToken: string }>('judge0');
    this.baseUrl = (j0?.url ?? '').replace(/\/+$/, '');
    this.authToken = j0?.authToken ?? '';
  }

  /** Whether Judge0 is configured. Sandbox endpoints return 503 when false. */
  isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Code sandbox is not configured on this server. Contact an administrator.',
      );
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) headers['X-Auth-Token'] = this.authToken;
    return headers;
  }

  /**
   * Submit code to Judge0 and return the submission token.
   * Uses `wait=false` so this call returns immediately; poll with `getResult`.
   */
  async submit(input: Judge0SubmitInput): Promise<string> {
    this.assertConfigured();

    const body = {
      source_code: Buffer.from(input.sourceCode).toString('base64'),
      language_id: input.languageId,
      stdin: input.stdin ? Buffer.from(input.stdin).toString('base64') : undefined,
      expected_output: input.expectedOutput
        ? Buffer.from(input.expectedOutput).toString('base64')
        : undefined,
      // Security caps — matches the AGENTS.md §10 spec
      cpu_time_limit: 5,
      memory_limit: 262144, // 256 MB
      max_processes_and_or_threads: 10000,
    };

    const res = await fetch(`${this.baseUrl}/submissions?base64_encoded=true&wait=false`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown');
      this.logger.error(`Judge0 submit failed: HTTP ${res.status} — ${text}`);
      throw new ServiceUnavailableException('Code sandbox submission failed. Try again.');
    }

    const data = (await res.json()) as Judge0SubmissionResponse;
    return data.token;
  }

  /**
   * Fetch the current result for a submission token.
   * Returns `null` if still in queue/processing (caller should poll).
   */
  async getResult(token: string): Promise<Judge0Result | null> {
    this.assertConfigured();

    const res = await fetch(
      `${this.baseUrl}/submissions/${token}?base64_encoded=true&fields=status,stdout,stderr,compile_output,time,memory,message`,
      { headers: this.buildHeaders() },
    );

    if (!res.ok) {
      this.logger.warn(`Judge0 getResult HTTP ${res.status} for token ${token}`);
      return null;
    }

    const data = (await res.json()) as Judge0StatusResponse;
    const statusId = data.status.id as Judge0StatusId;

    if (!TERMINAL_STATUS_IDS.has(statusId)) return null; // still running

    const decode = (v: string | null): string | null =>
      v ? Buffer.from(v, 'base64').toString('utf8') : null;

    return {
      token,
      statusId,
      statusDescription: data.status.description,
      stdout: decode(data.stdout),
      stderr: decode(data.stderr),
      compileOutput: decode(data.compile_output),
      time: data.time,
      memory: data.memory,
      message: data.message,
    };
  }

  /**
   * Submit code and poll until the result arrives or `maxPollMs` elapses.
   * Returns the result or throws `ServiceUnavailableException` on timeout.
   */
  async runWithTimeout(input: Judge0SubmitInput, maxPollMs = 12_000): Promise<Judge0Result> {
    const token = await this.submit(input);
    const deadline = Date.now() + maxPollMs;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    let interval = 500;
    while (Date.now() < deadline) {
      await sleep(interval);
      const result = await this.getResult(token);
      if (result) return result;
      interval = Math.min(interval * 1.5, 2000);
    }

    throw new ServiceUnavailableException('Code execution timed out. The sandbox may be overloaded.');
  }
}
