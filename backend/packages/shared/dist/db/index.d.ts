import pg from 'pg';
import { type RedisClientType } from 'redis';
export declare function getPgPool(): pg.Pool;
export declare function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
export declare function getRedisClient(): Promise<RedisClientType>;
export declare function cacheGet<T = unknown>(key: string): Promise<T | null>;
export declare function cacheSet(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
export declare function cacheDelete(key: string): Promise<void>;
export declare const CacheKeys: {
    session: (id: string) => string;
    domSnapshot: (pageId: string) => string;
    siteGraph: (siteId: string) => string;
    flowCache: (siteId: string, taskHash: string) => string;
    jobRuntime: (jobId: string) => string;
    jobCancel: (jobId: string) => string;
    proxyPool: () => string;
};
export declare function seedAdmins(): Promise<void>;
export declare function runMigrations(): Promise<void>;
//# sourceMappingURL=index.d.ts.map