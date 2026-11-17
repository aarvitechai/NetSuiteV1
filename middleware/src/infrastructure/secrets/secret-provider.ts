/**
 * Secret provider: where credentials come from.
 *
 * WHY AN ABSTRACTION: in development, secrets come from a local .env file that is never committed.
 * In the cloud they must come from a managed secret store (AWS Secrets Manager, Azure Key Vault):
 *   - access is audited and controlled by IAM (least privilege: this service may read only its own secrets);
 *   - secrets are encrypted at rest and can be ROTATED without a redeploy;
 *   - they never appear in container images, Git or build logs.
 *
 * CachedSecretProvider re-reads a secret after `ttlMs`, so a rotated secret is picked up automatically.
 * For webhook secrets we also accept the PREVIOUS value during rotation (see WebhookService), so no
 * event is rejected while the provider and we switch over.
 */

export interface SecretProvider {
  get(name: string): Promise<string | undefined>;
}

/** Reads secrets from environment variables (local development and tests). */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  async get(name: string): Promise<string | undefined> {
    return this.env[name];
  }
}

export class CachedSecretProvider implements SecretProvider {
  private cache = new Map<string, { value: string | undefined; at: number }>();
  constructor(
    private readonly inner: SecretProvider,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(name: string): Promise<string | undefined> {
    const hit = this.cache.get(name);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = await this.inner.get(name);
    this.cache.set(name, { value, at: this.now() });
    return value;
  }
}

/**
 * Copies the named secrets from the provider into the environment object BEFORE the config is
 * validated. The rest of the app then keeps reading validated config, and only start-up knows about
 * the secret store.
 */
export async function hydrateSecrets(
  provider: SecretProvider,
  names: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  for (const n of names) {
    const v = await provider.get(n);
    if (v !== undefined) env[n] = v;
  }
}
