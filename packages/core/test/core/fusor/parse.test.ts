import { describe, expect, it } from "vitest";
import { parseHttpRequest } from "@/fusor/parse";

describe("parseHttpRequest", () => {
  it("lowercases and joins duplicate headers without dropping empty values", () => {
    const request = new TextEncoder().encode(
      "POST /hooks HTTP/1.1\r\nX-Probe:\r\nx-PROBE: second\r\n\r\nbody"
    );

    const parsed = parseHttpRequest(request);

    expect(parsed.headers["x-probe"]).toBe(", second");
    expect(new TextDecoder().decode(parsed.rawBody)).toBe("body");
  });
});
