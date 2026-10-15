import { PostgresUrlStore } from "./postgres-store.js";
import { PostgresConfigStore } from "./config-store.js";
import { PostgresAuditStore } from "./audit-store.js";
import { PostgresSocialPostStore } from "./social-post-store.js";
import { createSqliteStores } from "./sqlite-stores.js";
import type { UrlStore, ConfigStore, AuditStore } from "./store.js";
import type { SocialPostStore } from "./social-store.js";

export interface StoreSet {
  urlStore: UrlStore;
  configStore: ConfigStore;
  auditStore: AuditStore;
  socialPostStore: SocialPostStore;
}

export function createStores(connectionString: string): StoreSet {
  if (
    connectionString.startsWith("postgres://") ||
    connectionString.startsWith("postgresql://")
  ) {
    return {
      urlStore: new PostgresUrlStore(connectionString),
      configStore: new PostgresConfigStore(connectionString),
      auditStore: new PostgresAuditStore(connectionString),
      socialPostStore: new PostgresSocialPostStore(connectionString),
    };
  }
  const filePath = connectionString.replace(/^file:/, "");
  return createSqliteStores(filePath);
}
