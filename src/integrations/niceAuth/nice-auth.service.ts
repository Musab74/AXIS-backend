import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as iconv from 'iconv-lite';

/**
 * NICE 본인인증 (CheckPlusSafe + I-PIN)
 *
 * The wire format is NOT pure JS — NICE ships a native CPClient binary that
 * handles encryption/decryption with their proprietary key schedule. We invoke
 * the binary as a subprocess (exactly how the official PHP sample does it):
 *
 *   CPClient_64bit ENC <sitecode> <sitepasswd> <plaindata>   → returns base64 enc
 *   CPClient_64bit DEC <sitecode> <sitepasswd> <encdata>     → returns plaintext
 *
 * Both calls return a negative integer string (e.g. "-9") on error.
 *
 * Plaintext format: length-prefixed `<nameLen>:<name><valueLen>:<value>` repeated.
 * Output (decryption) is EUC-KR encoded.
 */

export interface NiceVerificationResult {
  success: boolean;
  requestNo: string;
  name?: string;
  phone?: string;
  birthDate?: string;
  gender?: string;
  nationalInfo?: string;
  ci?: string;
  di?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type NiceAuthType = 'CHECKPLUS' | 'IPIN';

const ENC_ERRORS: Record<string, string> = {
  '-1': '암/복호화 시스템 오류',
  '-2': '암호화 처리 오류',
  '-3': '암호화 데이터 오류',
  '-9': '입력값 오류',
};

const DEC_ERRORS: Record<string, string> = {
  '-1': '암/복호화 시스템 오류',
  '-4': '복호화 처리 오류',
  '-5': 'HASH값 불일치',
  '-6': '복호화 데이터 오류',
  '-9': '입력값 오류',
  '-12': '사이트 비밀번호 오류',
};

@Injectable()
export class NiceAuthService {
  private readonly logger = new Logger(NiceAuthService.name);

  constructor(private readonly config: ConfigService) {}

  async generateRequest(
    authType: NiceAuthType,
    returnUrl: string,
  ): Promise<{ requestNo: string; encData: string; authType: NiceAuthType; actionUrl: string }> {
    const requestNo = this.generateRequestNo();
    if (authType === 'CHECKPLUS') {
      return this.generateCheckPlusRequest(requestNo, returnUrl);
    }
    return this.generateIpinRequest(requestNo, returnUrl);
  }

  private async generateCheckPlusRequest(requestNo: string, returnUrl: string) {
    const sitecode = this.requireConfig('nice.checkplus.sitecode');
    const sitepasswd = this.requireConfig('nice.checkplus.sitepasswd');
    const binary = this.requireConfig('nice.checkplus.modulePath');

    // Length-prefixed plaintext, exactly matching NICE's PHP reference.
    // AUTH_TYPE M = mobile only; "" = let user pick. POPUP_GUBUN N = no cancel button.
    const authTypeVal = 'M';
    const popGubun = 'N';
    const customize = '';
    const gender = '';
    const plainData =
      `7:REQ_SEQ${requestNo.length}:${requestNo}` +
      `8:SITECODE${sitecode.length}:${sitecode}` +
      `9:AUTH_TYPE${authTypeVal.length}:${authTypeVal}` +
      `7:RTN_URL${returnUrl.length}:${returnUrl}` +
      `7:ERR_URL${returnUrl.length}:${returnUrl}` +
      `11:POPUP_GUBUN${popGubun.length}:${popGubun}` +
      `9:CUSTOMIZE${customize.length}:${customize}` +
      `6:GENDER${gender.length}:${gender}`;

    const encData = await this.runCpClient(binary, ['ENC', sitecode, sitepasswd, plainData], ENC_ERRORS);

    return {
      requestNo,
      encData,
      authType: 'CHECKPLUS' as NiceAuthType,
      actionUrl: 'https://nice.checkplus.co.kr/CheckPlusSafeModel/checkplus.cb',
    };
  }

  private async generateIpinRequest(requestNo: string, returnUrl: string) {
    const sitecode = this.requireConfig('nice.ipin.sitecode');
    const sitepasswd = this.requireConfig('nice.ipin.sitepasswd');
    const binary = this.requireConfig('nice.ipin.modulePath');

    // I-PIN module uses a different argv shape: REQ <sitecode> <sitepasswd> <reqno> <returnUrl>.
    const stdout = await this.execAndCapture(binary, ['REQ', sitecode, sitepasswd, requestNo, returnUrl]);
    const code = parseInt(stdout, 10);
    if (!isNaN(code) && code < 0) {
      throw new InternalServerErrorException(`NICE I-PIN 요청 실패: ${ENC_ERRORS[String(code)] ?? `code ${code}`}`);
    }

    return {
      requestNo,
      encData: stdout,
      authType: 'IPIN' as NiceAuthType,
      actionUrl: 'https://cert.vno.co.kr/ipin.cb',
    };
  }

  async decryptResponse(encData: string, authType: NiceAuthType): Promise<NiceVerificationResult> {
    try {
      const sitecode = this.requireConfig(
        authType === 'CHECKPLUS' ? 'nice.checkplus.sitecode' : 'nice.ipin.sitecode',
      );
      const sitepasswd = this.requireConfig(
        authType === 'CHECKPLUS' ? 'nice.checkplus.sitepasswd' : 'nice.ipin.sitepasswd',
      );
      const binary = this.requireConfig(
        authType === 'CHECKPLUS' ? 'nice.checkplus.modulePath' : 'nice.ipin.modulePath',
      );

      const decrypted = await this.runCpClient(binary, ['DEC', sitecode, sitepasswd, encData], DEC_ERRORS);
      const fields = this.parseLengthColonPlain(decrypted);
      const parsed = this.fieldsToResult(fields, authType);

      // Field names only — values are PIPA-protected and must not appear in logs.
      this.logger.log(
        `NICE verification success: requestNo=${parsed.requestNo} returnedFields=${Object.keys(fields).join(',')}`,
      );
      return parsed;
    } catch (error: any) {
      this.logger.error('NICE decryption failed', error?.stack ?? error);
      return {
        success: false,
        requestNo: '',
        errorCode: 'DECRYPT_FAILED',
        errorMessage: error?.message || 'Failed to decrypt NICE response',
      };
    }
  }

  private fieldsToResult(data: Record<string, string>, authType: NiceAuthType): NiceVerificationResult {
    // Use NAME (EUC-KR), not UTF8_NAME. We EUC-KR-decode the whole stdout buffer once;
    // NAME comes through cleanly as UTF-8, but UTF8_NAME's already-UTF8 bytes get
    // double-decoded into mojibake by that pass.
    if (authType === 'CHECKPLUS') {
      return {
        success: true,
        requestNo: data['REQ_SEQ'] || '',
        name: data['NAME'] || '',
        phone: data['MOBILE_NO'] || '',
        birthDate: data['BIRTHDATE'] || '',
        gender: data['GENDER'] || '',
        nationalInfo: data['NATIONALINFO'] || '',
        ci: data['CI'] || '',
        di: data['DI'] || '',
      };
    }
    return {
      success: true,
      requestNo: data['REQ_SEQ'] || '',
      name: data['NAME'] || '',
      birthDate: data['BIRTHDATE'] || '',
      gender: data['GENDER'] || '',
      nationalInfo: data['NATIONALINFO'] || '',
      ci: data['CI'] || '',
      di: data['DI'] || '',
    };
  }

  private parseLengthColonPlain(plain: string): Record<string, string> {
    const r: Record<string, string> = {};
    let pos = 0;
    while (pos < plain.length) {
      const c1 = plain.indexOf(':', pos);
      if (c1 < 0) break;
      const nameLen = parseInt(plain.slice(pos, c1), 10);
      if (Number.isNaN(nameLen) || nameLen <= 0) break;
      pos = c1 + 1;
      if (pos + nameLen > plain.length) break;
      const fieldName = plain.slice(pos, pos + nameLen);
      pos += nameLen;
      const c2 = plain.indexOf(':', pos);
      if (c2 < 0) break;
      const valueLen = parseInt(plain.slice(pos, c2), 10);
      if (Number.isNaN(valueLen) || valueLen < 0) break;
      pos = c2 + 1;
      if (pos + valueLen > plain.length) break;
      r[fieldName] = plain.slice(pos, pos + valueLen);
      pos += valueLen;
    }
    return r;
  }

  private async runCpClient(
    binary: string,
    args: string[],
    errorTable: Record<string, string>,
  ): Promise<string> {
    const stdout = await this.execAndCapture(binary, args);
    const code = parseInt(stdout, 10);
    if (!isNaN(code) && code < 0 && errorTable[String(code)]) {
      throw new InternalServerErrorException(`NICE: ${errorTable[String(code)]} (code ${code})`);
    }
    return stdout;
  }

  // CPClient exits with code 1 even on successful encryption — exit status is unreliable.
  // We always resolve from stdout content; if it's empty, that's the real failure signal.
  private execAndCapture(binary: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args, { timeout: 10_000 });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      proc.stdout.on('data', (c: Buffer) => out.push(c));
      proc.stderr.on('data', (c: Buffer) => err.push(c));
      proc.on('error', reject);
      proc.on('close', () => {
        const stdout = Buffer.concat(out);
        if (stdout.length === 0) {
          const stderr = Buffer.concat(err).toString();
          reject(new Error(`NICE binary returned empty stdout${stderr ? ` (stderr: ${stderr})` : ''}`));
          return;
        }
        resolve(iconv.decode(stdout, 'euc-kr').trim());
      });
    });
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new InternalServerErrorException(`Missing NICE config: ${key}`);
    }
    return value;
  }

  private generateRequestNo(): string {
    const now = new Date();
    const ts =
      now.getFullYear().toString() +
      (now.getMonth() + 1).toString().padStart(2, '0') +
      now.getDate().toString().padStart(2, '0') +
      now.getHours().toString().padStart(2, '0') +
      now.getMinutes().toString().padStart(2, '0') +
      now.getSeconds().toString().padStart(2, '0');
    const random = crypto.randomBytes(8).toString('hex').substring(0, 16);
    return ts + random;
  }
}
