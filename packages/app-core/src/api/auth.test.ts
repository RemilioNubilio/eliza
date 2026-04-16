import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAuthRateLimiter,
  ensureCompatApiAuthorized,
} from "./auth";

function createMockRes(): http.ServerResponse & {
  statusCode: number;
  body: string;
} {
  const res = {
    statusCode: 200,
    body: "",
    headersSent: false,
    setHeader: vi.fn(),
    end(chunk?: string) {
      if (typeof chunk === "string") this.body = chunk;
    },
  } as unknown as http.ServerResponse & { statusCode: number; body: string };
  return res as http.ServerResponse & { statusCode: number; body: string };
}

describe("ensureCompatApiAuthorized rate limit", () => {
  const prevToken = process.env.ELIZA_API_TOKEN;

  beforeEach(() => {
    _resetAuthRateLimiter();
    process.env.ELIZA_API_TOKEN = "test-secret-token-for-rate-limit-tests";
  });

  afterEach(() => {
    _resetAuthRateLimiter();
    if (prevToken === undefined) {
      delete process.env.ELIZA_API_TOKEN;
    } else {
      process.env.ELIZA_API_TOKEN = prevToken;
    }
  });

  it("does not rate-limit repeated requests with no token (missing header)", () => {
    const req = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as Pick<http.IncomingMessage, "headers" | "socket">;

    for (let i = 0; i < 25; i++) {
      const res = createMockRes();
      ensureCompatApiAuthorized(req, res as http.ServerResponse);
      expect((res as { body: string }).body).toContain("Unauthorized");
    }

    const res429 = createMockRes();
    ensureCompatApiAuthorized(req, res429 as http.ServerResponse);
    expect((res429 as { body: string }).body).not.toContain(
      "Too many authentication",
    );
  });

  it("rate-limits wrong tokens", () => {
    const req = {
      headers: { authorization: "Bearer wrong" },
      socket: { remoteAddress: "127.0.0.1" },
    } as Pick<http.IncomingMessage, "headers" | "socket">;

    for (let i = 0; i < 20; i++) {
      const res = createMockRes();
      ensureCompatApiAuthorized(req, res as http.ServerResponse);
    }

    const res429 = createMockRes();
    ensureCompatApiAuthorized(req, res429 as http.ServerResponse);
    expect((res429 as { body: string }).body).toContain(
      "Too many authentication",
    );
  });

  it("accepts the correct token even after many failed attempts (checks token before lockout)", () => {
    const wrongReq = {
      headers: { authorization: "Bearer wrong" },
      socket: { remoteAddress: "127.0.0.1" },
    } as Pick<http.IncomingMessage, "headers" | "socket">;

    for (let i = 0; i < 20; i++) {
      const res = createMockRes();
      ensureCompatApiAuthorized(wrongReq, res as http.ServerResponse);
    }

    const goodReq = {
      headers: {
        authorization: "Bearer test-secret-token-for-rate-limit-tests",
      },
      socket: { remoteAddress: "127.0.0.1" },
    } as Pick<http.IncomingMessage, "headers" | "socket">;

    const resOk = createMockRes();
    const ok = ensureCompatApiAuthorized(goodReq, resOk as http.ServerResponse);
    expect(ok).toBe(true);
    expect((resOk as { body: string }).body).not.toContain(
      "Too many authentication",
    );
  });
});
