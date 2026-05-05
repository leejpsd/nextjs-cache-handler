/**
 * Lua script loader. Handles the EVALSHA → NOSCRIPT → SCRIPT LOAD → EVALSHA
 * dance so the network round-trip cost is one packet on every call after the
 * first.
 *
 * The script bodies are imported as strings via tsup's `loader: { '.lua':
 * 'text' }` configuration. We compute their SHA1 lazily on first use rather
 * than pre-loading on connect — a connect handler that pre-loads scripts adds
 * a startup failure mode (Redis ACLs that block SCRIPT LOAD will surface as
 * connection errors) without a corresponding benefit.
 */

import { createHash } from "node:crypto";

import type { RedisClientLike } from "../../types.js";

import setWithTagsLua from "./set-with-tags.lua";
import revalidateHardLua from "./revalidate-hard.lua";
import refreshTagLockLua from "./refresh-tag-lock.lua";

export const SCRIPTS = {
  setWithTags: setWithTagsLua,
  revalidateHard: revalidateHardLua,
  refreshTagLock: refreshTagLockLua,
} as const;

export type ScriptName = keyof typeof SCRIPTS;

const shaCache = new Map<ScriptName, string>();

function sha1(body: string): string {
  return createHash("sha1").update(body).digest("hex");
}

function isNoScriptError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: string }).message ?? "";
  return msg.includes("NOSCRIPT");
}

/**
 * Execute a named Lua script with EVALSHA, falling back to EVAL + SCRIPT LOAD
 * if the server doesn't have it cached (e.g. Redis was restarted).
 */
export async function execLuaScript<TResult = unknown>(
  client: RedisClientLike,
  name: ScriptName,
  keys: string[],
  args: string[]
): Promise<TResult> {
  const body = SCRIPTS[name];
  let cachedSha = shaCache.get(name);
  if (cachedSha === undefined) {
    cachedSha = sha1(body);
    shaCache.set(name, cachedSha);
  }

  // Best path: EVALSHA. Most Redis servers will have the script cached after
  // the first EVAL.
  if (typeof client.evalSha === "function") {
    try {
      return (await client.evalSha(cachedSha, {
        keys,
        arguments: args,
      })) as TResult;
    } catch (err) {
      if (!isNoScriptError(err)) {
        // Some other failure — propagate.
        throw err;
      }
      // Fall through to EVAL.
    }
  }

  // EVAL ships the script body and primes the server cache. Subsequent
  // EVALSHA on this connection will succeed.
  return (await client.eval(body, { keys, arguments: args })) as TResult;
}
