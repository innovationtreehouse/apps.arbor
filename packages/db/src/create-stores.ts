import postgres from "postgres";
import { PostgresUrlStore } from "./postgres-store.js";
import { PostgresConfigStore } from "./config-store.js";
import { PostgresAuditStore } from "./audit-store.js";
import { createSqliteStores } from "./sqlite-stores.js";
import type { UrlStore, ConfigStore, AuditStore } from "./store.js";

export interface StoreSet {
  urlStore: UrlStore;
  configStore: ConfigStore;
  auditStore: AuditStore;
}

export function createStores(connectionString: string): StoreSet {
  if (
    connectionString.startsWith("postgres://") ||
    connectionString.startsWith("postgresql://")
  ) {
    const client = postgres(connectionString);
    return {
      urlStore: new PostgresUrlStore(client),
      configStore: new PostgresConfigStore(client),
      auditStore: new PostgresAuditStore(client),
    };
  }
  const filePath = connectionString.replace(/^file:/, "");
  return createSqliteStores(filePath);
}
