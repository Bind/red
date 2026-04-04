export interface RevokedJtiStore {
  has(jti: string): Promise<boolean>;
  add(jti: string): Promise<void>;
}

export function createInMemoryRevokedJtiStore(): RevokedJtiStore {
  const revoked = new Set<string>();

  return {
    async has(jti: string): Promise<boolean> {
      return revoked.has(jti);
    },

    async add(jti: string): Promise<void> {
      revoked.add(jti);
    },
  };
}
