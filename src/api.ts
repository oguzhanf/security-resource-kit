import { z } from 'zod';

const errorSchema = z.object({ error: z.string(), requestId: z.string().optional() });

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly requestId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, schema: z.ZodType<T>, options: {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  csrfToken?: string | null;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const method = options.method || 'GET';
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-SRK-Request': '1',
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      ...(options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : {}),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    throw new ApiError('The community service returned an unexpected response. Retry shortly.', response.status);
  }
  const data: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('srk-session-expired'));
    const error = errorSchema.safeParse(data);
    throw new ApiError(error.success ? error.data.error : 'The request could not be completed.', response.status,
      error.success ? error.data.requestId : undefined);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError('The community response could not be validated. Refresh the page.', 502);
  return parsed.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation could not be completed.';
}
