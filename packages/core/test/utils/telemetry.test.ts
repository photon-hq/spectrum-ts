import { describe, expect, it } from "bun:test";
import { errorAttrs } from "@/utils/telemetry";

describe("errorAttrs", () => {
  it("captures the error type and message", () => {
    const attrs = errorAttrs(new TypeError("boom"));
    expect(attrs["spectrum.error.type"]).toBe("TypeError");
    expect(attrs["spectrum.error.message"]).toBe("boom");
  });

  it("uses a custom error class name as the type", () => {
    class CursorRejectedError extends Error {
      constructor() {
        super("rejected");
        this.name = "CursorRejectedError";
      }
    }
    expect(errorAttrs(new CursorRejectedError())["spectrum.error.type"]).toBe(
      "CursorRejectedError"
    );
  });

  it("includes code and status when present", () => {
    const err = Object.assign(new Error("nope"), {
      code: "ECONNREFUSED",
      status: 503,
    });
    const attrs = errorAttrs(err);
    expect(attrs["spectrum.error.code"]).toBe("ECONNREFUSED");
    expect(attrs["spectrum.error.status"]).toBe(503);
  });

  it("omits code/status when they are not primitives", () => {
    const err = Object.assign(new Error("nope"), { code: { nested: true } });
    const attrs = errorAttrs(err);
    expect(attrs["spectrum.error.code"]).toBeUndefined();
  });

  it("unwraps one level of an Error cause", () => {
    const cause = new RangeError("bad cursor");
    const attrs = errorAttrs(new Error("wrapped", { cause }));
    expect(attrs["spectrum.error.cause.type"]).toBe("RangeError");
    expect(attrs["spectrum.error.cause.message"]).toBe("bad cursor");
  });

  it("reports a non-Error cause by its typeof", () => {
    const attrs = errorAttrs(new Error("wrapped", { cause: "stringy" }));
    expect(attrs["spectrum.error.cause.type"]).toBe("string");
    expect(attrs["spectrum.error.cause.message"]).toBe("stringy");
  });

  it("leaves cause keys undefined when there is no cause", () => {
    const attrs = errorAttrs(new Error("lonely"));
    expect(attrs["spectrum.error.cause.type"]).toBeUndefined();
    expect(attrs["spectrum.error.cause.message"]).toBeUndefined();
  });

  it("handles non-Error throws", () => {
    const attrs = errorAttrs("just a string");
    expect(attrs["spectrum.error.type"]).toBe("string");
    expect(attrs["spectrum.error.message"]).toBe("just a string");
  });

  it("scrubs PII (email and phone) from the message", () => {
    const attrs = errorAttrs(
      new Error("failed for foo.bar@example.com / +13315553374")
    );
    const message = attrs["spectrum.error.message"] as string;
    expect(message).not.toContain("foo.bar@example.com");
    expect(message).not.toContain("3315553374");
  });

  it("honors a custom attribute prefix", () => {
    const attrs = errorAttrs(new Error("x"), "spectrum.fusor.error");
    expect(attrs["spectrum.fusor.error.type"]).toBe("Error");
    expect(attrs["spectrum.error.type"]).toBeUndefined();
  });
});
