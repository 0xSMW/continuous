import { describe, expect, it } from "vitest";

import { isJsonContentType } from "./content";

describe("isJsonContentType", () => {
  const cases: Array<[string | null, boolean]> = [
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["Application/JSON", true],
    ["application/jsonp", false],
    ["text/plain", false],
    [null, false],
  ];

  it.each(cases)("classifies %s as %s", (contentType, expected) => {
    expect(isJsonContentType(contentType)).toBe(expected);
  });
});
