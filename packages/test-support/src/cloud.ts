import { cloud } from "@spectrum-ts/core";
import { vi } from "vitest";

// Spectrum() fetches project metadata up-front when projectId/projectSecret are
// supplied. Stub the cloud call so construction doesn't hit the network (and
// doesn't raise a VALIDATION_ERROR) with placeholder credentials.
//
// Call at module top level in any test that constructs Spectrum with credentials,
// mirroring the module-load-time spy the tests relied on when colocated.
export const stubCloud = () =>
  vi.spyOn(cloud, "getProject").mockResolvedValue({
    id: "proj",
    name: "Test Project",
    profile: {},
    slug: "test-project",
  });
