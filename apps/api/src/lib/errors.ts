/** API 오류. 응답은 항상 {error:{code,message,fields?}} 형태로 직렬화된다. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, fields?: Record<string, string>) =>
  new AppError(400, code, message, fields);
export const forbidden = (message = '권한이 없습니다.', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (message = '대상을 찾을 수 없습니다.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
