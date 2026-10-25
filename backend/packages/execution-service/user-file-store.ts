import { mkdir, writeFile, unlink, readdir, stat, rm } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getPgPool } from '../shared/db/index.js';
import { materialize, putObject } from '../shared/storage/index.js';
import type { UserFile } from '../shared/types/index.js';

const STORAGE_ROOT = process.env.USER_FILE_STORAGE_ROOT
  ?? path.resolve(process.cwd(), 'mnt/user-data/outputs/automation-platform/uploads');

const TEMP_ROOT = process.env.TEMP_STORAGE_ROOT ?? '/tmp/automation-platform';

type FileCategory = UserFile['category'];

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function mapRow(row: Record<string, any>): UserFile {
  return {
    id: row.id,
    userId: row.userId,
    profileName: row.profileName ?? undefined,
    category: row.category,
    originalName: row.originalName,
    storedName: row.storedName,
    mimeType: row.mimeType,
    fileSizeBytes: Number(row.fileSizeBytes),
    storagePath: row.storagePath,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class UserFileStore {
  constructor() {
    this.ensureDirectories().catch(console.error);
  }

  private async ensureDirectories() {
    await mkdir(STORAGE_ROOT, { recursive: true });
    await mkdir(path.join(TEMP_ROOT, 'screenshots'), { recursive: true });
    await mkdir(path.join(TEMP_ROOT, 'downloads'), { recursive: true });
  }

  async resolveInputReference(userId: string, rawValue: string): Promise<string> {
    const normalized = rawValue.replace(/\{\{userFile:([^}]+)\}\}/g, (_match, category) => `file-category:${category}`);

    if (normalized !== rawValue) {
      return this.resolveInputReference(userId, normalized);
    }

    if (normalized.startsWith('file:')) {
      const fileId = normalized.slice('file:'.length);
      const file = await this.getFileById(fileId, userId);
      if (!file) throw new Error(`Referenced file not found: ${fileId}`);
      // Playwright needs a local path; remote objects are downloaded to a temp cache.
      return materialize(file.storagePath);
    }

    if (normalized.startsWith('file-category:')) {
      const category = normalized.slice('file-category:'.length) as FileCategory;
      const file = await this.getLatestByCategory(userId, category);
      if (!file) throw new Error(`No uploaded file found for category: ${category}`);
      return materialize(file.storagePath);
    }

    return normalized;
  }

  async persistDownloadedFile(input: {
    userId: string;
    category: FileCategory;
    originalName: string;
    buffer: Buffer;
    mimeType?: string;
    profileName?: string;
    metadata?: Record<string, unknown>;
  }): Promise<UserFile> {
    const fileId = randomUUID();
    const safeOriginal = sanitizeFileName(input.originalName || `${input.category}.bin`);
    const extension = path.extname(safeOriginal);
    const storedName = `${fileId}${extension}`;
    try {
      const fullPath = await putObject(
        `${sanitizeFileName(input.userId)}/${input.category}/${storedName}`,
        input.buffer,
        input.mimeType || 'application/octet-stream',
      );

      const pool = getPgPool();
      const { rows } = await pool.query(
        `INSERT INTO user_files (
           id, user_id, profile_name, category, original_name, stored_name,
           mime_type, file_size_bytes, storage_path, metadata, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
         RETURNING
           id,
           user_id as "userId",
           profile_name as "profileName",
           category,
           original_name as "originalName",
           stored_name as "storedName",
           mime_type as "mimeType",
           file_size_bytes as "fileSizeBytes",
           storage_path as "storagePath",
           metadata,
           created_at as "createdAt",
           updated_at as "updatedAt"`,
        [
          fileId,
          input.userId,
          input.profileName ?? null,
          input.category,
          input.originalName,
          storedName,
          input.mimeType ?? 'application/octet-stream',
          input.buffer.byteLength,
          fullPath,
          JSON.stringify(input.metadata ?? {}),
        ]
      );

      return mapRow(rows[0]);
    } catch (err) {
      console.error(`[UserFileStore] Failed to persist file:`, err);
      throw new Error(`File persistence failed: ${(err as Error).message}`);
    }
  }

  async getFileById(fileId: string, userId: string): Promise<UserFile | null> {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT
         id, user_id as "userId", profile_name as "profileName", category,
         original_name as "originalName", stored_name as "storedName",
         mime_type as "mimeType", file_size_bytes as "fileSizeBytes",
         storage_path as "storagePath", metadata, created_at as "createdAt", updated_at as "updatedAt"
       FROM user_files
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [fileId, userId]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async getLatestByCategory(userId: string, category: FileCategory): Promise<UserFile | null> {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT
         id, user_id as "userId", profile_name as "profileName", category,
         original_name as "originalName", stored_name as "storedName",
         mime_type as "mimeType", file_size_bytes as "fileSizeBytes",
         storage_path as "storagePath", metadata, created_at as "createdAt", updated_at as "updatedAt"
       FROM user_files
       WHERE user_id = $1 AND category = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, category]
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Cleanup temporary files older than a certain age
   */
  async cleanupTempFiles(maxAgeMs = 3600 * 1000) { // Default 1 hour
    const now = Date.now();
    const tempDirs = [
      path.join(TEMP_ROOT, 'screenshots'),
      path.join(TEMP_ROOT, 'downloads'),
      path.join(TEMP_ROOT, 'uploads'),
    ];

    for (const dir of tempDirs) {
      try {
        const files = await readdir(dir).catch(() => []);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const fstat = await stat(filePath);
          if (now - fstat.mtimeMs > maxAgeMs) {
            // uploads/ holds one folder per run (files keep their original names).
            await (fstat.isDirectory() ? rm(filePath, { recursive: true, force: true }) : unlink(filePath)).catch(() => {});
          }
        }
      } catch (err) {
        console.warn(`[UserFileStore] Cleanup failed for ${dir}:`, err);
      }
    }
  }

  getTempPath(type: 'screenshots' | 'downloads' | 'uploads', filename: string): string {
    return path.join(TEMP_ROOT, type, sanitizeFileName(filename));
  }
}

export const userFileStore = new UserFileStore();
