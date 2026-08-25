import type { FastifyRequest, FastifyReply } from 'fastify';
import { getPgPool } from '../shared/db/index.js';
import { resolveAdminSession } from './auth-routes.js';
import { createLogger } from '../shared/logger/index.js';

// ============================================================
// ADMIN AUTH — single source of truth, used by every admin route
// module (admin-routes.ts, observability-routes.ts, ...).
//
// Accepts either:
//   - a valid admin session cookie (issued by POST /auth/admin/login —
//     this is what the admin panel UI uses now; the raw key is never
//     shipped to the browser), or
//   - the legacy `x-admin-key` header (kept for scripts/CI).
// ============================================================

const logger = createLogger('admin-auth');

export interface AuthedAdmin {
  id: string;
  role: 'viewer' | 'editor' | 'super-admin';
}

export async function adminAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await resolveAdminSession(req);
  let admin: AuthedAdmin | null = null;

  if (session) {
    admin = { id: session.adminId, role: session.role as AuthedAdmin['role'] };
  } else {
    const key = req.headers['x-admin-key'] as string | undefined;
    if (!key) {
      logger.warn('admin:auth-missing-credentials', { ip: req.ip, url: req.url });
      reply.status(401).send({ error: 'Unauthorized — admin session or admin key required' });
      return;
    }

    try {
      const pool = getPgPool();
      const { rows } = await pool.query('SELECT id, role FROM admins WHERE api_key = $1', [key]);
      if (!rows.length) {
        logger.warn('admin:auth-failed', { ip: req.ip, url: req.url });
        reply.status(401).send({ error: 'Unauthorized — invalid admin key' });
        return;
      }
      admin = rows[0];
    } catch (err) {
      logger.error('admin:auth-error', err);
      reply.status(500).send({ error: 'Internal Server Error' });
      return;
    }
  }

  (req as FastifyRequest & { admin: AuthedAdmin }).admin = admin!;

  const method = req.method.toUpperCase();
  if (method === 'DELETE' && admin!.role !== 'super-admin') {
    reply.status(403).send({ error: 'Forbidden — super-admin required for DELETE' });
    return;
  }
  if ((method === 'POST' || method === 'PUT') && admin!.role === 'viewer') {
    reply.status(403).send({ error: 'Forbidden — editor or super-admin required for POST/PUT' });
    return;
  }
}
