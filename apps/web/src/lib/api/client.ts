import type { ApiErrorBody } from "./types";

/** 모든 API 호출의 공통 접두사. 실서버·목 모두 동일 오리진 상대 경로를 쓴다. */
export const API_BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly retryAfter?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Query;
  /** JSON 본문 */
  body?: unknown;
  /** multipart 본문(사진 업로드) */
  formData?: FormData;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
}

/** 서버가 오류 형식을 지키지 않은 경우(프록시 오류 등)에도 한국어 메시지를 보장한다. */
const FALLBACK_MESSAGES: Record<number, string> = {
  401: "로그인이 필요합니다.",
  403: "권한이 없습니다.",
  404: "요청한 내용을 찾을 수 없습니다.",
  413: "파일이 너무 큽니다.",
  429: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
};

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", query, body, formData, signal } = options;
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (formData) {
    // Content-Type(경계값 포함)은 브라우저가 설정한다.
    payload = formData;
  } else if (body !== undefined) {
    // 백엔드가 본문 있는 상태 변경 요청에 application/json 을 요구한다(CSRF 완화).
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  // 본문이 없는 요청(로그아웃·모두 읽음·삭제 등)에는 Content-Type 을 붙이지 않는다.
  // application/json 인데 본문이 비어 있으면 백엔드(Fastify)가 400 으로 거절한다.

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: payload,
      credentials: "include",
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "네트워크에 연결할 수 없습니다. 연결 상태를 확인해 주세요.",
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!response.ok) {
    const err = (data as ApiErrorBody | undefined)?.error;
    const retryAfter = Number(response.headers.get("Retry-After")) || undefined;
    throw new ApiError(
      response.status,
      err?.code ?? "UNKNOWN",
      err?.message ??
        FALLBACK_MESSAGES[response.status] ??
        "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      err?.fields,
      retryAfter,
    );
  }
  return data as T;
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}
