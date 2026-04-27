import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * NICE 본인인증 서비스
 *
 * 지원 방식:
 * 1. CheckPlus (휴대폰 인증 via PASS 앱)
 * 2. I-PIN (아이핀 인증)
 *
 * Flow:
 * 1. Frontend calls /auth/nice/request → gets encrypted data + request number
 * 2. Frontend opens NICE popup with the encrypted data
 * 3. NICE redirects to our callback URL with result
 * 4. Backend decrypts and returns verified identity
 */

export interface NiceVerificationResult {
  success: boolean;
  requestNo: string;
  name?: string;         // 실명
  phone?: string;        // 휴대폰 번호
  birthDate?: string;    // YYYYMMDD
  gender?: string;       // 1=male, 0=female
  nationalInfo?: string; // 0=내국인, 1=외국인
  ci?: string;           // Connecting Info (개인 고유값)
  di?: string;           // Duplicate Info (서비스별 고유값)
  errorCode?: string;
  errorMessage?: string;
}

export type NiceAuthType = 'CHECKPLUS' | 'IPIN';

@Injectable()
export class NiceAuthService {
  private readonly logger = new Logger(NiceAuthService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * NICE 인증 요청 데이터 생성
   * Frontend에서 NICE 팝업을 열기 위한 암호화된 데이터를 반환
   */
  generateRequest(authType: NiceAuthType, returnUrl: string): {
    requestNo: string;
    encData: string;
    authType: NiceAuthType;
    actionUrl: string;
  } {
    const requestNo = this.generateRequestNo();

    if (authType === 'CHECKPLUS') {
      return this.generateCheckPlusRequest(requestNo, returnUrl);
    } else {
      return this.generateIpinRequest(requestNo, returnUrl);
    }
  }

  /**
   * CheckPlus (PASS 휴대폰 인증) 요청 생성
   */
  private generateCheckPlusRequest(requestNo: string, returnUrl: string) {
    const sitecode = this.config.get<string>('nice.checkplus.sitecode');
    const sitepasswd = this.config.get<string>('nice.checkplus.sitepasswd');

    // NICE CheckPlus 요청 데이터 구성
    const plainData = [
      `7:REQ_SEQ${requestNo.length}:${requestNo}`,
      `8:SITECODE${sitecode!.length}:${sitecode}`,
      `9:AUTH_TYPE`,  // 빈값 = 모든 인증수단 허용
      `9:RTN_URL${returnUrl.length}:${returnUrl}`,
      `7:ERR_URL${returnUrl.length}:${returnUrl}`,
    ].join('');

    const encData = this.encrypt(plainData, sitecode!, sitepasswd!);

    return {
      requestNo,
      encData,
      authType: 'CHECKPLUS' as NiceAuthType,
      actionUrl: 'https://nice.checkplus.co.kr/CheckPlusSafe498/checkplus.cb',
    };
  }

  /**
   * I-PIN 인증 요청 생성
   */
  private generateIpinRequest(requestNo: string, returnUrl: string) {
    const sitecode = this.config.get<string>('nice.ipin.sitecode');
    const sitepasswd = this.config.get<string>('nice.ipin.sitepasswd');

    const plainData = [
      `7:REQ_SEQ${requestNo.length}:${requestNo}`,
      `8:SITECODE${sitecode!.length}:${sitecode}`,
      `9:RTN_URL${returnUrl.length}:${returnUrl}`,
    ].join('');

    const encData = this.encrypt(plainData, sitecode!, sitepasswd!);

    return {
      requestNo,
      encData,
      authType: 'IPIN' as NiceAuthType,
      actionUrl: 'https://cert.vno.co.kr/ipin.cb',
    };
  }

  /**
   * NICE 콜백에서 받은 암호화 데이터 복호화
   */
  decryptResponse(encData: string, authType: NiceAuthType): NiceVerificationResult {
    try {
      let sitecode: string;
      let sitepasswd: string;

      if (authType === 'CHECKPLUS') {
        sitecode = this.config.get<string>('nice.checkplus.sitecode')!;
        sitepasswd = this.config.get<string>('nice.checkplus.sitepasswd')!;
      } else {
        sitecode = this.config.get<string>('nice.ipin.sitecode')!;
        sitepasswd = this.config.get<string>('nice.ipin.sitepasswd')!;
      }

      const decrypted = this.decrypt(encData, sitecode, sitepasswd);
      const parsed = this.parseResponse(decrypted, authType);

      this.logger.log(`NICE verification success: requestNo=${parsed.requestNo}`);
      return parsed;
    } catch (error) {
      this.logger.error('NICE decryption failed', error);
      return {
        success: false,
        requestNo: '',
        errorCode: 'DECRYPT_FAILED',
        errorMessage: 'Failed to decrypt NICE response',
      };
    }
  }

  /**
   * 복호화된 데이터 파싱
   */
  private parseResponse(decryptedData: string, authType: NiceAuthType): NiceVerificationResult {
    const data = this.parseKeyValue(decryptedData);

    if (authType === 'CHECKPLUS') {
      return {
        success: true,
        requestNo: data['REQ_SEQ'] || '',
        name: data['UTF8_NAME'] || data['NAME'] || '',
        phone: data['MOBILE_NO'] || '',
        birthDate: data['BIRTHDATE'] || '',
        gender: data['GENDER'] || '',
        nationalInfo: data['NATIONALINFO'] || '',
        ci: data['CI'] || '',
        di: data['DI'] || '',
      };
    } else {
      // I-PIN
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
  }

  /**
   * NICE 응답 key=value 파싱
   */
  private parseKeyValue(data: string): Record<string, string> {
    const result: Record<string, string> = {};
    const pairs = data.split('&');
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const key = pair.substring(0, idx);
        const value = decodeURIComponent(pair.substring(idx + 1));
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * 암호화 (NICE 규격)
   * NICE uses SEED/AES encryption with sitecode-derived key
   */
  private encrypt(plainText: string, sitecode: string, sitepasswd: string): string {
    const key = this.deriveKey(sitecode, sitepasswd);
    const iv = key.subarray(0, 16);
    const cipher = crypto.createCipheriv('aes-128-cbc', key.subarray(0, 16), iv);
    let encrypted = cipher.update(plainText, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
  }

  /**
   * 복호화 (NICE 규격)
   */
  private decrypt(encData: string, sitecode: string, sitepasswd: string): string {
    const key = this.deriveKey(sitecode, sitepasswd);
    const iv = key.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key.subarray(0, 16), iv);
    let decrypted = decipher.update(encData, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * sitecode + sitepasswd 로 암호화 키 도출
   */
  private deriveKey(sitecode: string, sitepasswd: string): Buffer {
    const combined = sitecode + sitepasswd;
    return crypto.createHash('sha256').update(combined).digest();
  }

  /**
   * 고유 요청 번호 생성 (NICE 규격: 30자리)
   */
  private generateRequestNo(): string {
    const now = new Date();
    const timestamp = now.getFullYear().toString()
      + (now.getMonth() + 1).toString().padStart(2, '0')
      + now.getDate().toString().padStart(2, '0')
      + now.getHours().toString().padStart(2, '0')
      + now.getMinutes().toString().padStart(2, '0')
      + now.getSeconds().toString().padStart(2, '0');
    const random = crypto.randomBytes(8).toString('hex').substring(0, 16);
    return timestamp + random; // 14 + 16 = 30 chars
  }
}
