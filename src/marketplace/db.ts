/**
 * Marketplace Database — SQLite persistence layer.
 *
 * Uses better-sqlite3 for synchronous, fast, single-file storage.
 * All marketplace state (agents, services, jobs) lives here.
 */
import Database from 'better-sqlite3';
import { randomBytes, createHash } from 'crypto';
import type {
  MarketplaceAgent,
  MarketplaceService,
  MarketplaceSearchQuery,
  MarketplaceSearchResult,
  MarketplaceStats,
  Job,
  JobStatus,
} from './types';

export class MarketplaceDB {
  private db: Database.Database;

  constructor(dbPath: string = './marketplace.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('cache_size = -64000'); // 64MB
    this.db.pragma('synchronous = NORMAL'); // Safe with WAL
    this._migrate();
  }

  // ── Schema ──

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id       TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        wallet_address TEXT NOT NULL,
        api_key_hash   TEXT NOT NULL UNIQUE,
        trust_score    REAL NOT NULL DEFAULT 50,
        completed_jobs INTEGER NOT NULL DEFAULT 0,
        total_volume   TEXT NOT NULL DEFAULT '0',
        is_online      INTEGER NOT NULL DEFAULT 1,
        registered_at  INTEGER NOT NULL,
        last_seen_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS services (
        id             TEXT PRIMARY KEY,
        agent_id       TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        capability     TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        endpoint       TEXT NOT NULL,
        price_per_call TEXT NOT NULL,
        chain_id       INTEGER NOT NULL,
        tags           TEXT NOT NULL DEFAULT '[]',
        is_active      INTEGER NOT NULL DEFAULT 1,
        listed_at      INTEGER NOT NULL,
        UNIQUE(agent_id, capability)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id              TEXT PRIMARY KEY,
        service_id      TEXT NOT NULL REFERENCES services(id),
        agent_id        TEXT NOT NULL REFERENCES agents(agent_id),
        client_id       TEXT NOT NULL,
        task_input      TEXT NOT NULL,
        agreed_price    TEXT NOT NULL,
        chain_id        INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        result          TEXT,
        payment_tx_hash TEXT,
        reputation_score INTEGER,
        created_at      INTEGER NOT NULL,
        completed_at    INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_services_capability ON services(capability);
      CREATE INDEX IF NOT EXISTS idx_services_chain ON services(chain_id);
      CREATE INDEX IF NOT EXISTS idx_services_agent ON services(agent_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    `);

    // Add escrow columns (safe to run on existing DBs — ignores if already present)
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN escrow_tx_hash TEXT'); } catch { /* column exists */ }
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN escrow_address TEXT'); } catch { /* column exists */ }
  }

  // ── Agent Operations ──

  /** Register a new agent. Returns the agent ID and raw API key. */
  registerAgent(input: { name: string; description: string; walletAddress: string }): { agentId: string; apiKey: string } {
    const apiKey = `mk_${randomBytes(24).toString('hex')}`;
    const apiKeyHash = this._hashKey(apiKey);
    const agentId = input.walletAddress.toLowerCase();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO agents (agent_id, name, description, wallet_address, api_key_hash, registered_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(agentId, input.name, input.description, input.walletAddress, apiKeyHash, now, now);

    return { agentId, apiKey };
  }

  /** Get an agent by ID */
  getAgent(agentId: string): MarketplaceAgent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId.toLowerCase()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this._rowToAgent(row);
  }

  /** Validate an API key and return the agent ID if valid */
  validateApiKey(apiKey: string): string | null {
    const hash = this._hashKey(apiKey);
    const row = this.db.prepare('SELECT agent_id FROM agents WHERE api_key_hash = ?').get(hash) as { agent_id: string } | undefined;
    if (!row) return null;

    // Update last_seen_at
    this.db.prepare('UPDATE agents SET last_seen_at = ?, is_online = 1 WHERE agent_id = ?').run(Date.now(), row.agent_id);
    return row.agent_id;
  }

  /** Update agent's trust score based on recent job outcomes */
  updateTrustScore(agentId: string): void {
    const jobs = this.db.prepare(`
      SELECT status, reputation_score FROM jobs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(agentId) as Array<{ status: string; reputation_score: number | null }>;

    if (jobs.length === 0) return;

    let completed = 0;
    let failed = 0;
    let repSum = 0;
    let repCount = 0;

    for (const job of jobs) {
      if (job.status === 'completed') completed++;
      if (job.status === 'failed') failed++;
      if (job.reputation_score !== null) {
        repSum += job.reputation_score;
        repCount++;
      }
    }

    const total = completed + failed;
    const successRate = total > 0 ? completed / total : 0.5;
    const avgRep = repCount > 0 ? repSum / repCount : 50;

    // Trust = 50% success rate + 40% avg reputation + 10% volume bonus
    const volumeBonus = Math.min(10, Math.log2(jobs.length + 1) * 2.5);
    const trustScore = Math.round(successRate * 50 + (avgRep / 100) * 40 + volumeBonus);

    this.db.prepare('UPDATE agents SET trust_score = ? WHERE agent_id = ?').run(
      Math.max(0, Math.min(100, trustScore)),
      agentId,
    );
  }

  // ── Service Operations ──

  /** List a service for an agent (upserts by agent_id + capability) */
  listService(agentId: string, input: {
    capability: string;
    description: string;
    endpoint: string;
    pricePerCall: string;
    chainId: number;
    tags?: string[];
  }): string {
    const id = `svc_${randomBytes(8).toString('hex')}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO services (id, agent_id, capability, description, endpoint, price_per_call, chain_id, tags, listed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, capability) DO UPDATE SET
        description = excluded.description,
        endpoint = excluded.endpoint,
        price_per_call = excluded.price_per_call,
        chain_id = excluded.chain_id,
        tags = excluded.tags,
        is_active = 1,
        listed_at = excluded.listed_at
    `).run(id, agentId, input.capability, input.description, input.endpoint, input.pricePerCall, input.chainId, JSON.stringify(input.tags ?? []), now);

    // Return the actual ID (might be existing if upserted)
    const row = this.db.prepare('SELECT id FROM services WHERE agent_id = ? AND capability = ?').get(agentId, input.capability) as { id: string };
    return row.id;
  }

  /** Remove a service listing */
  removeService(agentId: string, serviceId: string): boolean {
    const result = this.db.prepare('UPDATE services SET is_active = 0 WHERE id = ? AND agent_id = ?').run(serviceId, agentId);
    return result.changes > 0;
  }

  /** Get a service by ID */
  getService(serviceId: string): MarketplaceService | null {
    const row = this.db.prepare('SELECT * FROM services WHERE id = ? AND is_active = 1').get(serviceId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this._rowToService(row);
  }

  /** Get all services for an agent */
  getAgentServices(agentId: string): MarketplaceService[] {
    const rows = this.db.prepare('SELECT * FROM services WHERE agent_id = ? AND is_active = 1').all(agentId) as Array<Record<string, unknown>>;
    return rows.map((r) => this._rowToService(r));
  }

  // ── Search ──

  /** Search services with filters, pagination, and sorting */
  search(query: MarketplaceSearchQuery): MarketplaceSearchResult {
    const conditions: string[] = ['s.is_active = 1'];
    const params: unknown[] = [];

    if (query.capability) {
      conditions.push('LOWER(s.capability) LIKE ?');
      params.push(`%${query.capability.toLowerCase()}%`);
    }

    if (query.minTrust !== undefined) {
      conditions.push('a.trust_score >= ?');
      params.push(query.minTrust);
    }

    if (query.maxPrice) {
      // SQLite doesn't do BigInt, so we compare as text length then lexicographic
      // This works for non-negative integers with no leading zeros
      conditions.push('(LENGTH(s.price_per_call) < LENGTH(?) OR (LENGTH(s.price_per_call) = LENGTH(?) AND s.price_per_call <= ?))');
      params.push(query.maxPrice, query.maxPrice, query.maxPrice);
    }

    if (query.chainIds && query.chainIds.length > 0) {
      conditions.push(`s.chain_id IN (${query.chainIds.map(() => '?').join(',')})`);
      params.push(...query.chainIds);
    }

    if (query.tags && query.tags.length > 0) {
      for (const tag of query.tags) {
        conditions.push('LOWER(s.tags) LIKE ?');
        params.push(`%"${tag.toLowerCase()}"%`);
      }
    }

    const where = conditions.join(' AND ');

    // Count total
    const countRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM services s
      JOIN agents a ON s.agent_id = a.agent_id
      WHERE ${where}
    `).get(...params) as { count: number };

    const total = countRow.count;
    const limit = Math.min(query.limit ?? 20, 100);
    const page = Math.max(query.page ?? 1, 1);
    const offset = (page - 1) * limit;
    const totalPages = Math.ceil(total / limit);

    // Sort
    let orderBy = 'a.trust_score DESC'; // default: best agents first
    if (query.sortBy === 'price') {
      orderBy = query.sortOrder === 'desc'
        ? 'LENGTH(s.price_per_call) DESC, s.price_per_call DESC'
        : 'LENGTH(s.price_per_call) ASC, s.price_per_call ASC';
    } else if (query.sortBy === 'jobs') {
      orderBy = query.sortOrder === 'asc' ? 'a.completed_jobs ASC' : 'a.completed_jobs DESC';
    } else if (query.sortBy === 'trust') {
      orderBy = query.sortOrder === 'asc' ? 'a.trust_score ASC' : 'a.trust_score DESC';
    }

    const rows = this.db.prepare(`
      SELECT s.*, a.name as agent_name, a.trust_score, a.completed_jobs, a.is_online
      FROM services s
      JOIN agents a ON s.agent_id = a.agent_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      services: rows.map((r) => ({
        ...this._rowToService(r),
        agent: {
          name: r.agent_name as string,
          trustScore: r.trust_score as number,
          completedJobs: r.completed_jobs as number,
          isOnline: Boolean(r.is_online),
        },
      })),
      total,
      page,
      totalPages,
    };
  }

  // ── Job Operations ──

  /** Create a new job */
  createJob(input: {
    serviceId: string;
    agentId: string;
    clientId: string;
    taskInput: string;
    agreedPrice: string;
    chainId: number;
  }): string {
    const id = `job_${randomBytes(8).toString('hex')}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO jobs (id, service_id, agent_id, client_id, task_input, agreed_price, chain_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.serviceId, input.agentId, input.clientId, input.taskInput, input.agreedPrice, input.chainId, now);

    return id;
  }

  /** Update job status */
  updateJob(jobId: string, updates: {
    status?: JobStatus;
    result?: string;
    paymentTxHash?: string;
    escrowTxHash?: string;
    escrowAddress?: string;
    reputationScore?: number;
  }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.status) {
      // Prevent double-completion from inflating stats
      const current = this.getJob(jobId);
      if (current && current.status === updates.status) {
        // No-op if status hasn't changed
      } else {
        sets.push('status = ?');
        params.push(updates.status);
        if (updates.status === 'completed' || updates.status === 'failed') {
          sets.push('completed_at = ?');
          params.push(Date.now());
        }
      }
    }
    if (updates.result !== undefined) {
      sets.push('result = ?');
      params.push(updates.result);
    }
    if (updates.paymentTxHash) {
      sets.push('payment_tx_hash = ?');
      params.push(updates.paymentTxHash);
    }
    if (updates.escrowTxHash) {
      sets.push('escrow_tx_hash = ?');
      params.push(updates.escrowTxHash);
    }
    if (updates.escrowAddress) {
      sets.push('escrow_address = ?');
      params.push(updates.escrowAddress);
    }
    if (updates.reputationScore !== undefined) {
      sets.push('reputation_score = ?');
      params.push(updates.reputationScore);
    }

    if (sets.length === 0) return false;

    // Check previous status before updating to prevent double-counting
    const previousJob = this.getJob(jobId);
    const wasAlreadyCompleted = previousJob?.status === 'completed';

    params.push(jobId);
    const result = this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    // Only update agent stats on first completion (prevents inflation)
    if (updates.status === 'completed' && !wasAlreadyCompleted) {
      const job = this.getJob(jobId);
      if (job) {
        // Use BigInt-safe string addition to avoid SQLite INTEGER overflow on wei values
        const agent = this.getAgent(job.agentId);
        const currentVolume = BigInt(agent?.totalVolume ?? '0');
        const addedVolume = BigInt(job.agreedPrice || '0');
        const newVolume = (currentVolume + addedVolume).toString();

        this.db.prepare(`
          UPDATE agents SET
            completed_jobs = completed_jobs + 1,
            total_volume = ?
          WHERE agent_id = ?
        `).run(newVolume, job.agentId);
        this.updateTrustScore(job.agentId);
      }
    }

    return result.changes > 0;
  }

  /** Get a job by ID */
  getJob(jobId: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this._rowToJob(row);
  }

  /** Get jobs for an agent */
  getAgentJobs(agentId: string, status?: JobStatus): Job[] {
    let query = 'SELECT * FROM jobs WHERE agent_id = ?';
    const params: unknown[] = [agentId];
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY created_at DESC LIMIT 100';
    const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this._rowToJob(r));
  }

  // ── Stats ──

  /** Get global marketplace statistics */
  getStats(): MarketplaceStats {
    const agents = this.db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
    const services = this.db.prepare('SELECT COUNT(*) as count FROM services WHERE is_active = 1').get() as { count: number };
    const jobs = this.db.prepare('SELECT COUNT(*) as count FROM jobs WHERE status = ?').get('completed') as { count: number };
    const online = this.db.prepare('SELECT COUNT(*) as count FROM agents WHERE is_online = 1').get() as { count: number };

    // Sum volumes using BigInt in JS to avoid SQLite INTEGER overflow on wei values
    const priceRows = this.db.prepare('SELECT agreed_price FROM jobs WHERE status = ?').all('completed') as Array<{ agreed_price: string }>;
    let totalVolume = BigInt(0);
    for (const row of priceRows) {
      try { totalVolume += BigInt(row.agreed_price || '0'); } catch { /* skip invalid */ }
    }
    const volumeRow = { total: totalVolume.toString() };

    const topCaps = this.db.prepare(`
      SELECT s.capability, COUNT(j.id) as job_count
      FROM services s
      LEFT JOIN jobs j ON j.service_id = s.id AND j.status = 'completed'
      WHERE s.is_active = 1
      GROUP BY s.capability
      ORDER BY job_count DESC
      LIMIT 10
    `).all() as Array<{ capability: string; job_count: number }>;

    return {
      totalAgents: agents.count,
      totalServices: services.count,
      totalJobs: jobs.count,
      totalVolume: String(volumeRow.total),
      topCapabilities: topCaps.map((r) => ({ capability: r.capability, jobCount: r.job_count })),
      onlineAgents: online.count,
    };
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  // ── Helpers ──

  private _hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  private _rowToAgent(row: Record<string, unknown>): MarketplaceAgent {
    return {
      agentId: row.agent_id as string,
      name: row.name as string,
      description: row.description as string,
      walletAddress: row.wallet_address as string,
      apiKeyHash: row.api_key_hash as string,
      trustScore: row.trust_score as number,
      completedJobs: row.completed_jobs as number,
      totalVolume: row.total_volume as string,
      isOnline: Boolean(row.is_online),
      registeredAt: row.registered_at as number,
      lastSeenAt: row.last_seen_at as number,
    };
  }

  private _rowToService(row: Record<string, unknown>): MarketplaceService {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      capability: row.capability as string,
      description: row.description as string,
      endpoint: row.endpoint as string,
      pricePerCall: row.price_per_call as string,
      chainId: row.chain_id as number,
      tags: JSON.parse(row.tags as string) as string[],
      isActive: Boolean(row.is_active),
      listedAt: row.listed_at as number,
    };
  }

  private _rowToJob(row: Record<string, unknown>): Job {
    return {
      id: row.id as string,
      serviceId: row.service_id as string,
      agentId: row.agent_id as string,
      clientId: row.client_id as string,
      taskInput: row.task_input as string,
      agreedPrice: row.agreed_price as string,
      chainId: row.chain_id as number,
      status: row.status as JobStatus,
      result: row.result as string | undefined,
      paymentTxHash: row.payment_tx_hash as string | undefined,
      escrowTxHash: row.escrow_tx_hash as string | undefined,
      escrowAddress: row.escrow_address as string | undefined,
      reputationScore: row.reputation_score as number | undefined,
      createdAt: row.created_at as number,
      completedAt: row.completed_at as number | undefined,
    };
  }
}
