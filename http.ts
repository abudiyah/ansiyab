/** عميل HTTP قابل للحقن (fetch في المتصفح وNode، أو بديل في الاختبارات). */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = 'Ansiyab/0.1 (+https://github.com/ ; traffic decision support research prototype)';

export class SourceError extends Error {
  constructor(
    public readonly sourceId: string,
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(`[${sourceId}] ${message}`);
  }
}

export async function getJson<T>(fetcher: Fetcher, sourceId: string, url: string, init?: RequestInit, timeoutMs = 30000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new SourceError(sourceId, `HTTP ${res.status} ${body}`, res.status);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof SourceError) throw e;
    throw new SourceError(sourceId, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(t);
  }
}

/** يُخفي المفتاح من أي رابط قبل تسجيله أو عرضه */
export const redactKey = (url: string) => url.replace(/([?&](?:key|apiKey|apikey)=)[^&]+/g, '$1***');
