import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReturnRoute } from './restart-receipt';
import { primitiveA, primitiveC, isMissingFile } from './restart-receipt';

// ── Directory ──────────────────────────────────────────────────────────

const LEASE_DIR = 'route-leases';

export function routeLeaseDir(profileDir: string): string {
  return join(profileDir, LEASE_DIR);
}

// ── Types ──────────────────────────────────────────────────────────────

export interface RouteLease {
  routeId: string;
  chatId: string;
  threadId?: string;
  replyTo: string;
  bridgePid: number;
  runId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface RouteLeaseInput {
  chatId: string;
  threadId?: string;
  replyTo: string;
  bridgePid: number;
  runId?: string;
  ttlMs?: number;
}

// ── Lease store ────────────────────────────────────────────────────────

const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function makeRouteId(): string {
  return `route-${randomUUID()}`;
}

export function leasePath(profileDir: string, routeId: string): string {
  return join(routeLeaseDir(profileDir), `${safeLeaseName(routeId)}.json`);
}

function safeLeaseName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Create a route lease via primitive A.
 * Returns the lease (with generated routeId) or null if EEXIST.
 */
export async function createRouteLease(
  profileDir: string,
  input: RouteLeaseInput,
): Promise<RouteLease | null> {
  const routeId = makeRouteId();
  const now = new Date();
  const ttl = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const lease: RouteLease = {
    routeId,
    chatId: input.chatId,
    threadId: input.threadId,
    replyTo: input.replyTo,
    bridgePid: input.bridgePid,
    runId: input.runId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
  const ok = await primitiveA(leasePath(profileDir, routeId), lease);
  return ok ? lease : null;
}

/**
 * Read a route lease by routeId.
 */
export async function readRouteLease(
  profileDir: string,
  routeId: string,
): Promise<RouteLease | undefined> {
  try {
    const data = await readFile(leasePath(profileDir, routeId), 'utf8');
    return JSON.parse(data) as RouteLease;
  } catch (err) {
    if (isMissingFile(err)) return undefined;
    throw err;
  }
}

/**
 * Delete a route lease by routeId (verified delete).
 */
export async function deleteRouteLease(
  profileDir: string,
  routeId: string,
): Promise<boolean> {
  return primitiveC(leasePath(profileDir, routeId), routeId, 'routeId');
}

/**
 * Extend a live lease's expiry while its run is still executing.
 *
 * A lease must stay valid for the whole agent run: `at-bot` and `restart`
 * validate it at arbitrary points, and long runs routinely exceed the initial
 * TTL. Renewal never resurrects a lease that was consumed (restart) or deleted
 * (run end), and never rewrites one owned by a different routeId.
 */
export async function renewRouteLease(
  profileDir: string,
  routeId: string,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): Promise<boolean> {
  const target = leasePath(profileDir, routeId);
  const lease = await readRouteLease(profileDir, routeId);
  if (!lease || lease.routeId !== routeId) return false;
  const renewed: RouteLease = {
    ...lease,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  const temp = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.renew.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(renewed)}\n`, 'utf8');
    // Re-check right before the atomic replace so a concurrent consume/delete
    // is not undone by this renewal.
    if (!(await readRouteLease(profileDir, routeId))) return false;
    await rename(temp, target);
    return true;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/** Interval at which a running agent's lease is renewed. */
export const ROUTE_LEASE_RENEW_INTERVAL_MS = 2 * 60 * 1000;
/** Safety cap so a leaked keeper cannot renew a lease forever. */
export const ROUTE_LEASE_MAX_KEEPALIVE_MS = 12 * 60 * 60 * 1000;

export interface RouteLeaseKeeperOptions {
  intervalMs?: number;
  ttlMs?: number;
  maxKeepAliveMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Periodically renew a run's lease until `stop()` is called, the lease
 * disappears (consumed or deleted), or the safety cap is reached.
 */
export function keepRouteLeaseAlive(
  profileDir: string,
  routeId: string,
  options: RouteLeaseKeeperOptions = {},
): { stop(): void } {
  const intervalMs = options.intervalMs ?? ROUTE_LEASE_RENEW_INTERVAL_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const deadline = Date.now() + (options.maxKeepAliveMs ?? ROUTE_LEASE_MAX_KEEPALIVE_MS);
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    if (Date.now() >= deadline) {
      stop();
      return;
    }
    inFlight = true;
    renewRouteLease(profileDir, routeId, ttlMs)
      .then((renewed) => {
        if (!renewed) stop();
      })
      .catch((err) => options.onError?.(err))
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  timer.unref?.();
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }
  return { stop };
}

/**
 * Validate a route lease: must exist, bridgePid must match, must not be expired.
 */
export async function validateRouteLease(
  profileDir: string,
  routeId: string,
  bridgePid: number,
): Promise<{ ok: true; lease: RouteLease } | { ok: false; reason: string }> {
  const lease = await readRouteLease(profileDir, routeId);
  if (!lease) {
    return { ok: false, reason: `route lease not found: ${routeId}` };
  }
  if (lease.bridgePid !== bridgePid) {
    return {
      ok: false,
      reason: `route lease bridgePid mismatch: expected ${bridgePid}, got ${lease.bridgePid}`,
    };
  }
  if (new Date(lease.expiresAt) < new Date()) {
    return { ok: false, reason: `route lease expired at ${lease.expiresAt}` };
  }
  return { ok: true, lease };
}

/**
 * Extract return route from a validated lease.
 */
export function returnRouteFromLease(lease: RouteLease): ReturnRoute {
  return {
    chatId: lease.chatId,
    threadId: lease.threadId,
    replyTo: lease.replyTo,
  };
}

/**
 * Clean up expired leases (TTL-based cleanup).
 */
export async function cleanupExpiredLeases(profileDir: string): Promise<number> {
  const dir = routeLeaseDir(profileDir);
  let files: { name: string }[];
  try {
    files = await readdir(dir, { withFileTypes: true }).then((items) =>
      items.filter((d) => d.isFile()).map((d) => ({ name: d.name })),
    );
  } catch {
    return 0;
  }
  let cleaned = 0;
  const now = new Date();
  for (const { name } of files) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(dir, name);
    try {
      const data = JSON.parse(await readFile(filePath, 'utf8')) as RouteLease;
      if (new Date(data.expiresAt) < now) {
        await unlink(filePath);
        cleaned++;
      }
    } catch {
      // corrupt file — clean it up
      await unlink(filePath).catch(() => {});
      cleaned++;
    }
  }
  return cleaned;
}
