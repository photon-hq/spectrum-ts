const REGISTRY = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 15_000;
const VISIBILITY_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5000;

// A failed probe is retried by the verifier. Before publishing, it falls
// through to npm, which rejects an already-published version rather than overwriting it.
export async function registryHas(
  name: string,
  version: string,
  timeoutMs = REGISTRY_TIMEOUT_MS
): Promise<boolean> {
  try {
    const res = await fetch(`${REGISTRY}/${name}/${version}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200 && res.status !== 404) {
      console.warn(
        `  registry probe for ${name}@${version}: HTTP ${res.status}`
      );
    }
    return res.status === 200;
  } catch (error) {
    console.warn(
      `  registry probe for ${name}@${version} failed: ${error instanceof Error ? error.message : error}`
    );
    return false;
  }
}

// npm can accept a publish several minutes before reads expose it. Keep
// waiting here rather than repeating a successful publish or abandoning later packages.
export async function verifyOnRegistry(
  name: string,
  version: string
): Promise<void> {
  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS;
  console.log(
    `  waiting up to 10 minutes for ${name}@${version} to become visible on registry`
  );
  while (Date.now() < deadline) {
    if (
      await registryHas(
        name,
        version,
        Math.min(REGISTRY_TIMEOUT_MS, deadline - Date.now())
      )
    ) {
      console.log(`  ✓ ${name}@${version} visible on registry`);
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining))
      );
    }
  }
  throw new Error(
    `${name}@${version} not visible on registry within 10 minutes after publish was accepted; retry with publish-only to resume the same version`
  );
}
