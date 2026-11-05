import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import type { OcrExtractDto, OcrExtractResult } from '@shared/api.interface';
import { validateNativeImage } from '../../local-agents/native-image';
import { normalizePublicLlmBaseUrl, publicHttpsAgent } from '../settings/settings-security';
import { EXTRACTION_PROMPT, parseScreenshotResult, ScreenshotError } from './screenshot-result';

interface EndpointPolicy { normalize: typeof normalizePublicLlmBaseUrl }

/** One vision call. Credentials/images remain transient; diagnostics never expose upstream content. */
@Injectable()
export class OcrService {
  constructor(private readonly httpService: HttpService,
    @Optional() @Inject('OCR_ENDPOINT_POLICY') private readonly endpoints: EndpointPolicy = { normalize: normalizePublicLlmBaseUrl }) {}

  private normalizeEndpoint(input: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new ScreenshotError('VISION_FAILED')); return; }
      let settled = false;
      const finish = (error?: ScreenshotError, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value!);
      };
      const cancel = () => finish(new ScreenshotError('VISION_FAILED'));
      const timer = setTimeout(() => finish(new ScreenshotError('VISION_TIMEOUT')), 10_000);
      timer.unref();
      signal?.addEventListener('abort', cancel, { once: true });
      // DNS cannot be aborted portably. Stop waiting and discard its late answer before dispatch.
      void Promise.resolve().then(() => this.endpoints.normalize(input)).then(
        value => finish(undefined, value), () => finish(new ScreenshotError('INVALID_API_CONFIGURATION')));
    });
  }

  async extract(dto: OcrExtractDto, signal?: AbortSignal): Promise<OcrExtractResult> {
    if (!dto || typeof dto.apiKey !== 'string' || !dto.apiKey.trim() || dto.apiKey.length > 4096 || /[\r\n]/.test(dto.apiKey)
      || typeof dto.model !== 'string' || !dto.model.trim() || dto.model.length > 200) throw new ScreenshotError('INVALID_API_CONFIGURATION');
    const raw = dto.imageBase64;
    if (typeof raw !== 'string' || raw.length > 11_200_000) throw new ScreenshotError('INVALID_IMAGE');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/s.exec(raw);
    const data = match?.[2] ?? raw;
    const prefix = Buffer.from(data.slice(0, 32), 'base64');
    const mimeType = match?.[1] ?? (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : prefix.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/jpeg');
    let image;
    try { image = validateNativeImage({ mimeType, data }); } catch { throw new ScreenshotError('INVALID_IMAGE'); }
    const baseUrl = await this.normalizeEndpoint(dto.baseUrl?.trim() || 'https://ark.cn-beijing.volces.com/api/v3', signal);
    if (signal?.aborted) throw new ScreenshotError('VISION_FAILED');
    let content: unknown;
    const agent = publicHttpsAgent();
    try {
      const response = await firstValueFrom(this.httpService.post(`${baseUrl}/chat/completions`, {
        model: dto.model.trim(), messages: [{ role: 'user', content: [
          { type: 'text', text: EXTRACTION_PROMPT },
          { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
        ] }], temperature: 0,
      }, { headers: { Authorization: `Bearer ${dto.apiKey.trim()}` }, timeout: 90_000, signal,
        maxRedirects: 0, maxContentLength: 1_048_576, maxBodyLength: 12 * 1024 * 1024, httpsAgent: agent, proxy: false }));
      content = response.data?.choices?.[0]?.message?.content;
    } catch (error) {
      const failure = error as { code?: string; response?: { status?: number; data?: { error?: { code?: string; type?: string } } } };
      const status = failure.response?.status;
      const upstreamCode = `${failure.response?.data?.error?.code ?? ''} ${failure.response?.data?.error?.type ?? ''}`;
      const code = status === 402 || /insufficient_quota|quota_exceeded|billing|credit|usage_limit/i.test(upstreamCode) ? 'VISION_USAGE_LIMIT'
        : status === 429 ? 'VISION_RATE_LIMIT' : status === 401 || status === 403 ? 'VISION_AUTH_REQUIRED'
          : ['ECONNABORTED', 'ETIMEDOUT'].includes(failure.code ?? '') ? 'VISION_TIMEOUT' : 'VISION_FAILED';
      throw new ScreenshotError(code);
    } finally { agent.destroy(); }
    return parseScreenshotResult(typeof content === 'string' ? content : '');
  }
}
