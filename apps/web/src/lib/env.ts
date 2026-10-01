/** true면 실제 API 대신 MSW 목을 쓴다(NEXT_PUBLIC_API_MOCK=true). 실서버 전환은 이 값만 바꾼다. */
export const API_MOCK = process.env.NEXT_PUBLIC_API_MOCK === "true";
