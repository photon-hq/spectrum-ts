// The `spectrum-ts/providers/*` compat shims must stay wired to the real
// provider packages: same module instance (single definePlatform identity),
// every public export forwarded. Runs under bun, so the shims resolve the
// provider packages to workspace source — no provider build required.
//
// biome-ignore-all lint/performance/noNamespaceImport: comparing full module
// namespaces is exactly what this parity test is for.

import { describe, expect, it } from "bun:test";
import * as imessagePkg from "@spectrum-ts/imessage";
import * as slackPkg from "@spectrum-ts/slack";
import * as telegramPkg from "@spectrum-ts/telegram";
import * as terminalPkg from "@spectrum-ts/terminal";
import * as whatsappPkg from "@spectrum-ts/whatsapp-business";
import * as imessageShim from "@/providers/imessage/index";
import * as barrel from "@/providers/index";
import * as slackShim from "@/providers/slack/index";
import * as telegramShim from "@/providers/telegram/index";
import * as terminalShim from "@/providers/terminal/index";
import * as whatsappShim from "@/providers/whatsapp-business/index";

const cases = [
  ["imessage", imessageShim, imessagePkg],
  ["slack", slackShim, slackPkg],
  ["telegram", telegramShim, telegramPkg],
  ["terminal", terminalShim, terminalPkg],
  ["whatsapp-business", whatsappShim, whatsappPkg],
] as const;

describe("spectrum-ts/providers/* shims", () => {
  for (const [key, shim, pkg] of cases) {
    it(`${key}: forwards every export of the provider package`, () => {
      for (const name of Object.keys(pkg)) {
        expect(shim[name as keyof typeof shim]).toBe(
          pkg[name as keyof typeof pkg]
        );
      }
      expect(Object.keys(pkg).length).toBeGreaterThan(0);
    });
  }

  it("barrel re-exports the five provider consts by their v4 names", () => {
    expect(barrel.imessage).toBe(imessagePkg.imessage);
    expect(barrel.slack).toBe(slackPkg.slack);
    expect(barrel.telegram).toBe(telegramPkg.telegram);
    expect(barrel.terminal).toBe(terminalPkg.terminal);
    expect(barrel.whatsappBusiness).toBe(whatsappPkg.whatsappBusiness);
  });
});
