export interface RevokedJtiStore {
  has(jti: string): Promise<boolean>;
  add(jti: string): Promise<void>;
}

export function createInMemoryRevokedJtiStore(): RevokedJtiStore {
  const revoked = new Set<string>();

  return {
    has(jti: string): Promise<boolean> {
      return Promise.resolve(revoked.has(jti));
    },

    add(jti: string): Promise<void> {
      revoked.add(jti);
      return Promise.resolve();
    },
  };
}
