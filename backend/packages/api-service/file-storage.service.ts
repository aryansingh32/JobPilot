import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getPgPool } from '../shared/db/index.js';
import type { UserFile } from '../shared/types/index.js';

type FileCategory = UserFile['category'];

const VALID_CATEGORIES: readonly FileCategory[] = ['resume', 'signature', 'photo', 'document', 'receipt', 'other'];

const STORAGE_ROOT = process.env.USER_FILE_STORAGE_ROOT
  ?? path.resolve(process.cwd(), 'mnt/user-data/outputs/automation-platform/uploads');

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Defense in depth: category ultimately becomes a path segment (see uploadBase64
// below), so it must never be trusted past this whitelist even though the API
// layer already validates it — this is what closes the hole if a future caller
// forgets to validate at the boundary.
function sanitizeCategory(category: FileCategory | undefined): FileCategory {
  return category && VALID_CATEGORIES.includes(category) ? category : 'other';
}

export class FileStorageService {
  buildAutomationReferences(file: UserFile) {
    return {
      fileRef: `file:${file.id}`,
      latestCategoryRef: `file-category:${file.category}`,
      templateRef: `{{userFile:${file.category}}}`,
    };
  }

  async uploadBase64(input: {
    userId: string;
    originalName: string;
    mimeType: string;
    base64Data: string;
    category?: FileCategory;
    profileName?: string;
    metadata?: Record<string, unknown>;
  }): Promise<UserFile> {
    const fileId = randomUUID();
    const category = sanitizeCategory(input.category);
    const safeOriginal = sanitizeFileName(input.originalName || 'file.bin');
    const extension = path.extname(safeOriginal);
    const storedName = `${fileId}${extension}`;
    const userDir = path.join(STORAGE_ROOT, sanitizeFileName(input.userId), category);
    const fullPath = path.join(userDir, storedName);
    const buffer = Buffer.from(input.base64Data, 'base64');

    await mkdir(userDir, { recursive: true });
    await writeFile(fullPath, buffer);

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
        category,
        input.originalName,
        storedName,
        input.mimeType || 'application/octet-stream',
        buffer.byteLength,
        fullPath,
        JSON.stringify(input.metadata ?? {}),
      ]
    );

    return rows[0];
  }

  async listFiles(userId: string, category?: FileCategory): Promise<UserFile[]> {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT
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
         updated_at as "updatedAt"
       FROM user_files
       WHERE user_id = $1
         AND ($2::text IS NULL OR category = $2)
       ORDER BY created_at DESC`,
      [userId, category ?? null]
    );
    return rows;
  }

  async summarizeFiles(userId: string): Promise<string> {
    const files = await this.listFiles(userId);
    if (!files.length) return 'No uploaded user files.';

    return files.slice(0, 20).map((file) => JSON.stringify({
      id: file.id,
      category: file.category,
      originalName: file.originalName,
      profileName: file.profileName ?? null,
      reference: this.buildAutomationReferences(file),
    })).join('\n');
  }

  async getFile(fileId: string, userId?: string): Promise<UserFile | null> {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT
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
         updated_at as "updatedAt"
       FROM user_files
       WHERE id = $1
         AND ($2::text IS NULL OR user_id = $2)
       LIMIT 1`,
      [fileId, userId ?? null]
    );
    return rows[0] ?? null;
  }

  async getFileContent(fileId: string, userId?: string): Promise<{ file: UserFile; buffer: Buffer } | null> {
    const file = await this.getFile(fileId, userId);
    if (!file) return null;
    const buffer = await readFile(file.storagePath);
    return { file, buffer };
  }

  async deleteFile(fileId: string, userId?: string): Promise<boolean> {
    const file = await this.getFile(fileId, userId);
    if (!file) return false;

    await unlink(file.storagePath).catch(() => {});
    const pool = getPgPool();
    await pool.query(`DELETE FROM user_files WHERE id = $1`, [fileId]);
    return true;
  }
}

export const fileStorageService = new FileStorageService();
