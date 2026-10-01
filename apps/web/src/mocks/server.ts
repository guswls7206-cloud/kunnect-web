import { setupServer } from "msw/node";
import { handlers } from "./handlers";

/** 테스트(vitest) 전용 Node 서버 */
export const server = setupServer(...handlers);
