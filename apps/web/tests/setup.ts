import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { mockConfig } from "@/mocks/handlers";
import { resetDb } from "@/mocks/seed";
import { server } from "@/mocks/server";

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
beforeEach(() => {
  mockConfig.delayMs = 0;
  resetDb(true);
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
