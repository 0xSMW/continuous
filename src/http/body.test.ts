import { describe, expect, it } from "vitest";

import { defaultMaxJsonBodyBytes, readJsonObjectBody } from "./body";

const testErrors = {
  invalidContentType: {
    code: "invalid_body",
    message: "Body must be JSON.",
  },
  invalidJson: {
    code: "invalid_body",
    message: "Body must be valid JSON.",
  },
  invalidObject: {
    code: "invalid_body",
    message: "Body must be a JSON object.",
  },
  tooLarge: (maxBytes: number) => ({
    code: "body_too_large",
    message: `Body must be at most ${maxBytes} bytes.`,
  }),
};

describe("readJsonObjectBody", () => {
  it("reads JSON objects", async () => {
    const result = await readJsonObjectBody(
      new Request("http://localhost/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ ok: true }),
      }),
      testErrors,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        ok: true,
      },
    });
  });

  it("rejects non-JSON, malformed, and non-object bodies", async () => {
    await expect(
      readJsonObjectBody(
        new Request("http://localhost/test", {
          method: "POST",
          headers: {
            "content-type": "text/plain",
          },
          body: "{}",
        }),
        testErrors,
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 415,
      error: testErrors.invalidContentType,
    });

    await expect(
      readJsonObjectBody(
        new Request("http://localhost/test", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: "{",
        }),
        testErrors,
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: testErrors.invalidJson,
    });

    await expect(
      readJsonObjectBody(
        new Request("http://localhost/test", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: "[]",
        }),
        testErrors,
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: testErrors.invalidObject,
    });
  });

  it("rejects oversized bodies from content-length and streamed bytes", async () => {
    await expect(
      readJsonObjectBody(
        new Request("http://localhost/test", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(defaultMaxJsonBodyBytes + 1),
          },
          body: "{}",
        }),
        testErrors,
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 413,
      error: testErrors.tooLarge(defaultMaxJsonBodyBytes),
    });

    await expect(
      readJsonObjectBody(
        new Request("http://localhost/test", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: "x".repeat(defaultMaxJsonBodyBytes + 1),
        }),
        testErrors,
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 413,
      error: testErrors.tooLarge(defaultMaxJsonBodyBytes),
    });
  });
});
