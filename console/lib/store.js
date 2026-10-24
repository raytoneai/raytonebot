// The console's only storage: Upstash Redis over its REST API (what Vercel's Redis/KV integration
// provisions), or an in-memory stand-in for local runs and tests. Both take Redis commands as
// arrays, so the rest of the code never knows which one it has.

const url = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const COMPARE_AND_SET = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

/** The comparison and write must be one Redis operation, including across console instances. */
export async function compareAndSet(store, key, expected, value) {
  return await store.cmd("EVAL", COMPARE_AND_SET, 1, key, expected, value) === 1;
}

function upstash(base, auth) {
  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`storage: HTTP ${response.status}`);
    return response.json();
  };
  return {
    async cmd(...args) {
      const { result, error } = await call("", args);
      if (error) throw new Error(`storage: ${error}`);
      return result;
    },
    async pipe(commands) {
      if (!commands.length) return [];
      const replies = await call("/pipeline", commands);
      return replies.map(({ result, error }) => { if (error) throw new Error(`storage: ${error}`); return result; });
    },
  };
}

/** Just the commands the console uses, with Redis's reply shapes. */
export function memoryStore() {
  const data = new Map();
  const expires = new Map();
  const live = (key) => {
    if (expires.has(key) && expires.get(key) <= Date.now()) { data.delete(key); expires.delete(key); }
    return data.get(key);
  };
  const list = (key) => { const value = live(key) ?? []; data.set(key, value); return value; };
  const run = ([name, ...args]) => {
    switch (String(name).toUpperCase()) {
      case "GET": return live(args[0]) ?? null;
      case "EVAL": {
        const [script, count, key, expected, value] = args;
        if (script !== COMPARE_AND_SET || count !== 1) throw new Error("Unsupported memory store script");
        if (live(key) !== expected) return 0;
        data.set(key, String(value)); expires.delete(key);
        return 1;
      }
      case "MGET": return args.map((key) => live(key) ?? null);
      case "SET": {
        const [key, value, ...options] = args;
        const upper = options.map((option) => String(option).toUpperCase());
        if (upper.includes("NX") && live(key) !== undefined) return null;
        data.set(key, String(value));
        const ex = upper.indexOf("EX");
        if (ex >= 0) expires.set(key, Date.now() + Number(options[ex + 1]) * 1000); else expires.delete(key);
        return "OK";
      }
      case "DEL": return args.filter((key) => data.delete(key)).length;
      case "INCR": { const next = Number(live(args[0]) ?? 0) + 1; data.set(args[0], String(next)); return next; }
      case "EXPIRE": if (!data.has(args[0])) return 0; expires.set(args[0], Date.now() + Number(args[1]) * 1000); return 1;
      case "SADD": { const set = live(args[0]) ?? new Set(); data.set(args[0], set); const before = set.size; args.slice(1).forEach((m) => set.add(String(m))); return set.size - before; }
      case "SMEMBERS": return [...(live(args[0]) ?? [])];
      case "RPUSH": { const items = list(args[0]); items.push(...args.slice(1).map(String)); return items.length; }
      case "LPOP": {
        const items = list(args[0]);
        if (args[1] === undefined) return items.shift() ?? null;
        const taken = items.splice(0, Number(args[1]));
        return taken.length ? taken : null;
      }
      default: throw new Error(`memory store: ${name} not supported`);
    }
  };
  return { async cmd(...args) { return run(args); }, async pipe(commands) { return commands.map(run); } };
}

let store;

/** Upstash when its env is set; otherwise memory, which only a local run may use. */
export function getStore() {
  if (store) return store;
  if (url() && token()) return (store = upstash(url(), token()));
  if (process.env.VERCEL) throw new Error("Connect a Redis (Upstash) store to this project");
  return (store = memoryStore());
}

export function setStore(next) { store = next; }

export const K = {
  key: (id) => `rtb:key:${id}`,
  keys: "rtb:keys",
  bot: (id) => `rtb:bot:${id}`,
  access: (id) => `rtb:access:${id}`,
  queue: "rtb:queue",
  control: "rtb:control",
  limit: (ip) => `rtb:limit:${ip}`,
};

export const parse = (text) => { try { return text ? JSON.parse(text) : undefined; } catch { return undefined; } };
