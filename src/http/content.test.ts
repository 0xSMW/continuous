import { describe, expect, it } from "vitest";

import { isJsonContentType } from "./content";

describe("isJsonContentType", () => {
  it.each([
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["Application/JSON", true],
    ["application/jsonp", false],
    ["text/plain", false],
    [null, false],
  ])("classifies %s as %s", (contentType, expected) => {
    expect(isJsonContentType(contentType)).toBe(expected);
  });
});
