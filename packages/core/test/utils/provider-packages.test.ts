import { describe, expect, it } from "bun:test";
import {
  normalizePlatformKey,
  officialProviderInstallHint,
  officialProviderPackage,
} from "@/utils/provider-packages";

const INSTALL_COMMAND = /bun add|npm install/;

describe("normalizePlatformKey", () => {
  it("maps every spelling seen in the wild onto the manifest key", () => {
    // definePlatform labels
    expect(normalizePlatformKey("iMessage")).toBe("imessage");
    expect(normalizePlatformKey("Slack")).toBe("slack");
    expect(normalizePlatformKey("Terminal")).toBe("terminal");
    expect(normalizePlatformKey("WhatsApp Business")).toBe("whatsapp-business");
    // fusor routing key
    expect(normalizePlatformKey("telegram")).toBe("telegram");
    // cloud platform key
    expect(normalizePlatformKey("whatsapp_business")).toBe("whatsapp-business");
  });
});

describe("officialProviderPackage", () => {
  it("resolves all five official providers from any spelling", () => {
    expect(officialProviderPackage("iMessage")).toBe("@spectrum-ts/imessage");
    expect(officialProviderPackage("whatsapp_business")).toBe(
      "@spectrum-ts/whatsapp-business"
    );
    expect(officialProviderPackage("telegram")).toBe("@spectrum-ts/telegram");
  });

  it("returns undefined for unknown/custom platforms", () => {
    expect(officialProviderPackage("discord")).toBeUndefined();
    expect(officialProviderInstallHint("discord")).toBeUndefined();
  });
});

describe("officialProviderInstallHint", () => {
  it("names the package and an install command", () => {
    const hint = officialProviderInstallHint("telegram");
    expect(hint).toContain("@spectrum-ts/telegram");
    expect(hint).toMatch(INSTALL_COMMAND);
    expect(hint).toContain("Spectrum({ providers: [...] })");
  });
});
