'use client';

import type {
  AskInput,
  ChatMessage,
  Conversation,
  CreateDocumentInput,
  Document,
  ListDocumentsResponse,
  ProblemDetails,
  StreamEvent,
  UpdateDocumentInput,
  UsageSummary,
} from '@kb/contracts';
import { supabaseBrowser } from './supabase';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Typed API client.
 *
 * Request and response shapes come from @kb/contracts, the same schemas the
 * server validates with -- so a contract change breaks this file at compile
 * time rather than at runtime.
 */
export class ApiError extends Error {
  constructor(
    readonly problem: ProblemDetails,
    readonly status: number,
  ) {
    super(problem.title);
    this.name = 'ApiError';
  }

  /** Field-level messages for form display. */
  get fieldErrors(): Record<string, string[]> {
    return this.problem.errors ?? {};
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabaseBrowser().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
      ...init.headers,
    },
  });

  if (!res.ok) {
    let problem: ProblemDetails;
    try {
      problem = (await res.json()) as ProblemDetails;
    } catch {
      problem = {
        type: 'about:blank',
        title: res.statusText || 'Request failed',
        status: res.status,
        code: 'internal_error',
      };
    }
    throw new ApiError(problem, res.status);
  }

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  listDocuments: (params: { tag?: string; search?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.tag) q.set('tag', params.tag);
    if (params.search) q.set('search', params.search);
    const qs = q.toString();
    return request<ListDocumentsResponse>(`/documents${qs ? `?${qs}` : ''}`);
  },
  getDocument: (id: string) => request<Document>(`/documents/${id}`),
  createDocument: (body: CreateDocumentInput) =>
    request<Document>('/documents', { method: 'POST', body: JSON.stringify(body) }),
  updateDocument: (id: string, body: UpdateDocumentInput) =>
    request<Document>(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: 'DELETE' }),
  /**
   * Uploads a file. Not routed through `request()` because the browser must set
   * its own multipart boundary -- specifying Content-Type here would produce a
   * boundary the server cannot parse.
   */
  uploadDocument: async (file: File): Promise<Document> => {
    const form = new FormData();
    form.append('file', file);

    const res = await fetch(`${API_URL}/documents/upload`, {
      method: 'POST',
      headers: await authHeader(),
      body: form,
    });

    if (!res.ok) {
      let problem: ProblemDetails;
      try {
        problem = (await res.json()) as ProblemDetails;
      } catch {
        problem = {
          type: 'about:blank',
          title: res.status === 413 ? 'That file is too large' : 'Upload failed',
          status: res.status,
          code: 'validation_failed',
        };
      }
      throw new ApiError(problem, res.status);
    }
    return (await res.json()) as Document;
  },

  usage: (days = 30) => request<UsageSummary>(`/usage?days=${days}`),

  listConversations: () => request<Conversation[]>('/chat/conversations'),
  listMessages: (id: string) => request<ChatMessage[]>(`/chat/conversations/${id}/messages`),
};

/**
 * Streams an answer.
 *
 * Reads the SSE body with a ReadableStream reader rather than EventSource,
 * which cannot POST a request body or set an Authorization header.
 *
 * Buffering is explicit: a chunk boundary can split an event mid-JSON, so
 * partial data is held until a complete `\n\n`-delimited block arrives.
 */
export async function streamAsk(
  body: AskInput,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}/chat/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let problem: ProblemDetails;
    try {
      problem = (await res.json()) as ProblemDetails;
    } catch {
      problem = {
        type: 'about:blank',
        title: 'Could not start the answer stream',
        status: res.status,
        code: 'internal_error',
      };
    }
    throw new ApiError(problem, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as StreamEvent);
        } catch {
          // A malformed event must not kill the rest of the stream.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
