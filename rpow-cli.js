#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { Worker } = require("worker_threads");

const DEFAULT_SITE_ORIGIN = "https://rpow3.com";
const DEFAULT_API_ORIGIN = "https://api.rpow3.com";
const DEFAULT_INDEX = path.join(__dirname, "index.js");
const DEFAULT_STATE = path.join(__dirname, ".rpow-cli-state.json");
const AUTH_REQUEST_TIMEOUT_MS = 60000;
const MINER_WORKER = path.join(__dirname, "rpow-miner-worker.js");
const NATIVE_MINER_CANDIDATES = process.platform === "win32"
  ? [
    path.join(__dirname, "rpow-native-miner.exe"),
    path.join(__dirname, "rpow-native-miner"),
  ]
  : [
    path.join(__dirname, "rpow-native-miner"),
    path.join(__dirname, "rpow-native-miner.exe"),
  ];
const SAFE_HOSTS = new Set([
  "api.rpow3.com",
  "rpow3.com",
  "www.rpow3.com",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
let activeDashboard = null;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function log(level, message, data) {
  const suffix = data === undefined ? "" : ` ${formatLogData(data)}`;
  const upper = level.toUpperCase();
  const plainLevel = upper.padEnd(7);
  const color = process.env.NO_COLOR
    ? ""
    : upper === "SUCCESS" ? COLORS.green
      : upper === "WARN" ? COLORS.yellow
        : upper === "ERROR" ? COLORS.red
          : upper === "INFO" ? COLORS.cyan
            : "";
  const reset = color ? COLORS.reset : "";
  const line = `${new Date().toISOString()} ${color}${plainLevel}${reset} ${message}${suffix}`;
  if (activeDashboard) activeDashboard.log(level, message, data, line);
  else console.log(line);
}

function verboseEnabled() {
  return process.env.RPOW_VERBOSE === "1" || globalThis.__RPOW_VERBOSE__ === true;
}

function debugLog(message, data) {
  if (verboseEnabled()) log("info", message, data);
}

function formatLogData(data) {
  if (data === null || typeof data !== "object") return String(data);
  return Object.entries(data).map(([key, value]) => {
    if (value === undefined) return null;
    if (value === null) return `${key}=null`;
    if (typeof value === "object") return `${key}=${JSON.stringify(value)}`;
    const text = String(value);
    return /^[A-Za-z0-9._:/?=-]+$/.test(text) ? `${key}=${text}` : `${key}=${JSON.stringify(text)}`;
  }).filter(Boolean).join(" ");
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(text) {
  return stripAnsi(text).length;
}

function fit(text, width) {
  const plain = stripAnsi(text);
  if (plain.length <= width) return `${text}${" ".repeat(width - plain.length)}`;
  return `${plain.slice(0, Math.max(0, width - 3))}...`;
}

function formatDuration(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function maxWorkerCount() {
  return Math.max(1, os.cpus().length);
}

class Dashboard {
  constructor(options = {}) {
    this.width = Math.max(72, Math.min(process.stdout.columns || 100, 120));
    this.logLimit = Math.max(8, Math.min(18, Math.floor((process.stdout.rows || 32) / 2)));
    this.logs = [];
    this.startedAt = Date.now();
    this.state = {
      target: options.target || "--",
      difficulty: "--",
      workers: options.workers || defaultWorkerCount(),
      maxWorkers: options.maxWorkers || maxWorkerCount(),
      hashes: "0",
      rate: "0",
      elapsed: "00:00:00",
      status: "IDLE",
      minedThisRun: 0,
      totalMined: options.totalMined || 0,
      challengeId: "--",
    };
    this.timer = setInterval(() => this.render(), 1000);
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.render();
  }

  log(level, message, data, line) {
    this.applyLogData(level, message, data);
    this.logs.push(stripAnsi(line));
    if (this.logs.length > this.logLimit) this.logs.shift();
    this.render();
  }

  applyLogData(level, message, data = {}) {
    if (message === "challenge") {
      this.update({
        status: "MINING",
        challengeId: data.id || "--",
        difficulty: String(data.difficulty || "--").replace(/\s*bits$/i, ""),
        hashes: "0",
        rate: "0",
        elapsed: "00:00:00",
      });
    } else if (message === "miner config") {
      this.update({ workers: data.workers || this.state.workers, status: "MINING" });
    } else if (message === "mining" || message === "mining progress") {
      this.update({
        status: "MINING",
        hashes: data.hashes || this.state.hashes,
        rate: data.speed || data.rate_mhs || this.state.rate,
        elapsed: formatDuration(Date.now() - this.startedAt),
      });
    } else if (message === "solution found") {
      this.update({
        status: "SUBMITTING",
        hashes: data.hashes || this.state.hashes,
        rate: data.speed || this.state.rate,
        elapsed: formatDuration(data.elapsed_ms || Date.now() - this.startedAt),
      });
    } else if (message === "mint/claim accepted") {
      this.update({ status: "ACCEPTED" });
    } else if (message === "mint progress") {
      this.update({
        status: "NEXT CHALLENGE",
        minedThisRun: data.minted || this.state.minedThisRun,
        totalMined: Number(this.state.totalMined || 0) + 1,
      });
    } else if (level === "warn") {
      this.update({ status: "WARN" });
    } else if (level === "error") {
      this.update({ status: "ERROR" });
    }
  }

  row(label, value) {
    const innerWidth = this.width - 4;
    const text = `  ${label.padEnd(17)} : ${value}`;
    return `| ${fit(text, innerWidth)} |`;
  }

  sectionTitle(title) {
    const inner = this.width - 4;
    const text = ` ${title} `;
    return `+--${text}${"-".repeat(Math.max(0, inner - text.length - 2))}+`;
  }

  render() {
    if (!process.stdout.isTTY) return;
    const s = this.state;
    s.elapsed = s.status === "MINING" ? formatDuration(Date.now() - this.startedAt) : s.elapsed;
    const lines = [
      this.sectionTitle("MINE"),
      this.row("TARGET", `${s.difficulty} trailing zero bits`),
      this.row("WORKER", `${s.workers}/${s.maxWorkers} (MAX WORKER AUTO DETECT)`),
      this.row("HASHES (current)", s.hashes),
      this.row("RATE", s.rate),
      this.row("ELAPSED", s.elapsed),
      this.row("STATUS", s.status),
      this.row("MINED THIS RUN", s.minedThisRun),
      this.row("TOTAL MINED", s.totalMined),
      this.row("CHALLENGE", s.challengeId),
      `+${"-".repeat(this.width - 2)}+`,
      "",
      this.sectionTitle("LOGS"),
      ...this.logs.map((entry) => `| ${fit(entry, this.width - 4)} |`),
      `+${"-".repeat(this.width - 2)}+`,
      "Press Ctrl+C to stop.",
    ];
    process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`);
  }

  stop(status) {
    clearInterval(this.timer);
    if (status) this.update({ status });
    activeDashboard = null;
  }
}

function safeUrlForLog(url) {
  return `${url.origin}${url.pathname}${url.search ? "?..." : ""}`;
}

function retryAfterMs(headers) {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function isAuthRequest(method, url) {
  return method === "POST" && url.pathname === "/auth/request";
}

function isAuthVerifyRequest(method, url) {
  return method === "GET" && url.pathname === "/auth/verify";
}

function looksLikeProviderRateLimit(err) {
  return err.status === 429
    || err.code === "RATE_LIMITED"
    || /too many requests|rate limit|try again/i.test(err.message || "");
}

function errorCode(err) {
  return err?.code || err?.cause?.code || err?.cause?.cause?.code;
}

function isTransientNetworkError(err) {
  const code = errorCode(err);
  return err?.name === "AbortError"
    || err?.message === "fetch failed"
    || [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code);
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function saveState(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function discoverFromIndex(indexFile) {
  const js = fs.readFileSync(indexFile, "utf8");
  const apiOrigin = /const\s+\w+\s*=\s*"([^"]+)";\s*async function\s+\w+\(\w+,\s*\w+,\s*\w+\)/.exec(js)?.[1]
    || DEFAULT_API_ORIGIN;
  const endpoints = [...js.matchAll(/(\w+):\s*(?:(?:\(\)|\w+)\s*=>\s*)?\w+\("([A-Z]+)",\s*"([^"]+)"/g)]
    .map((m) => ({ name: m[1], method: m[2], path: m[3] }));
  const workerPath = /new URL\("([^"]*miner\.worker-[^"]+\.js)"/.exec(js)?.[1] || null;
  return { apiOrigin, endpoints, workerPath };
}

function printApiMap(discovered) {
  console.log(`API origin: ${discovered.apiOrigin}`);
  console.log("Browser request defaults: credentials=include, JSON content-type only when body exists.");
  console.log("Sequence:");
  console.log("1. POST /auth/request { email } -> sends magic link, no browser UI needed.");
  console.log("2. Open/fetch magic link -> server sets session cookie; CLI stores Set-Cookie values.");
  console.log("3. GET /me -> verifies session and balance.");
  console.log("4. POST /challenge -> { challenge_id, nonce_prefix, difficulty_bits }.");
  console.log("5. Mine locally with the native C miner: SHA-256(nonce_prefix || uint64-le nonce), accept trailing zero bits >= difficulty_bits.");
  console.log("6. POST /mint { challenge_id, solution_nonce } -> mints/claims token.");
  console.log("7. Repeat from /challenge for more tokens; no separate commit/reveal endpoint is used by this site.");
  console.log("Endpoints found in index.js:");
  for (const e of discovered.endpoints) console.log(`- ${e.name}: ${e.method} ${e.path}`);
  if (discovered.workerPath) console.log(`Worker: ${discovered.workerPath}`);
}

function assertSafeUrl(rawUrl, apiOrigin) {
  const url = new URL(rawUrl, apiOrigin);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error(`blocked non-http URL: ${rawUrl}`);
  if (!SAFE_HOSTS.has(url.hostname)) throw new Error(`blocked host outside site/API allowlist: ${url.hostname}`);
  return url;
}

function cookieHeader(cookies = {}) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeSetCookies(state, setCookieHeaders) {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return;
  state.cookies ||= {};
  for (const header of setCookieHeaders) {
    const first = header.split(";", 1)[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (value) state.cookies[name] = value;
    else delete state.cookies[name];
  }
}

function responseSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

class RpowClient {
  constructor(options) {
    this.apiOrigin = options.apiOrigin;
    this.siteOrigin = options.siteOrigin;
    this.stateFile = options.stateFile;
    this.state = loadState(this.stateFile);
    this.timeoutMs = Number(options.timeoutMs || 20000);
    this.maxRetries = Number(options.retries || 5);
  }

  save() {
    this.state.updated_at = new Date().toISOString();
    saveState(this.stateFile, this.state);
  }

  async request(method, urlOrPath, body, options = {}) {
    const url = assertSafeUrl(urlOrPath, this.apiOrigin);
    let attempt = 0;
    while (true) {
      attempt += 1;
      const controller = new AbortController();
      const requestTimeoutMs = Number(options.timeoutMs || ((isAuthRequest(method, url) || isAuthVerifyRequest(method, url)) ? Math.max(this.timeoutMs, AUTH_REQUEST_TIMEOUT_MS) : this.timeoutMs));
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      const started = Date.now();
      try {
        const headers = {
          "accept": "application/json, text/plain, */*",
          "origin": this.siteOrigin,
          "referer": `${this.siteOrigin}/`,
          "user-agent": "rpow-cli/1.0",
        };
        const cookies = cookieHeader(this.state.cookies);
        if (cookies) headers.cookie = cookies;
        let payload;
        if (body !== undefined) {
          headers["content-type"] = "application/json";
          payload = JSON.stringify(body);
        }
        debugLog("HTTP ->", {
          method,
          url: safeUrlForLog(url),
          attempt,
          has_body: body !== undefined,
          has_cookie: Boolean(headers.cookie),
        });
        const res = await fetch(url, {
          method,
          headers,
          body: payload,
          redirect: options.redirect || "manual",
          signal: controller.signal,
        });
        storeSetCookies(this.state, responseSetCookies(res.headers));
        this.save();
        const text = await res.text();
        const parsed = text ? tryJson(text) : undefined;
        debugLog("HTTP <-", {
          method,
          url: safeUrlForLog(url),
          attempt,
          status: res.status,
          ms: Date.now() - started,
          set_cookie: responseSetCookies(res.headers).length > 0,
          retry_after_ms: retryAfterMs(res.headers),
        });
        if (res.status === 401 && options.allowUnauthorized !== true) {
          const err = new Error(parsed?.message || "login required");
          err.code = "UNAUTHORIZED";
          err.status = res.status;
          throw err;
        }
        if (!res.ok && ![301, 302, 303, 307, 308].includes(res.status)) {
          const err = new Error(parsed?.message || res.statusText || `HTTP ${res.status}`);
          err.status = res.status;
          err.code = parsed?.error;
          err.retryable = [408, 425, 429, 500, 502, 503, 504].includes(res.status);
          if (isAuthRequest(method, url) && looksLikeProviderRateLimit(err)) {
            err.retryable = false;
            err.cooldownMs = Math.max(retryAfterMs(res.headers) || 0, 60000);
          }
          err.retryAfterMs = retryAfterMs(res.headers);
          throw err;
        }
        return { res, data: parsed ?? text };
      } catch (err) {
        if (isAuthRequest(method, url) && err?.name === "AbortError") {
          const e = new Error("magic-link request timed out; if the email arrived, paste that link instead of requesting another one");
          e.code = "MAGIC_LINK_MAY_BE_SENT";
          throw e;
        }
        if (isAuthVerifyRequest(method, url) && err?.name === "AbortError") {
          const e = new Error("magic-link verification timed out; the link may have been consumed, request a fresh link before trying again");
          e.code = "MAGIC_LINK_VERIFY_TIMEOUT";
          throw e;
        }
        if (isAuthRequest(method, url) && looksLikeProviderRateLimit(err)) {
          const waitSeconds = Math.ceil((err.cooldownMs || 60000) / 1000);
          const e = new Error(`magic-link request is rate-limited; wait at least ${waitSeconds}s before running login again`);
          e.code = err.code || "RATE_LIMITED";
          e.status = err.status;
          throw e;
        }
        const retryable = err.retryable || isTransientNetworkError(err);
        if (!retryable || attempt > this.maxRetries) throw err;
        const backoff = Math.min(30000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        const delay = Math.max(backoff, Math.min(err.retryAfterMs || 0, 60000));
        log("warn", `request failed, retrying in ${delay}ms`, {
          method,
          url: safeUrlForLog(url),
          attempt,
          status: err.status,
          code: errorCode(err),
          error: err.message,
        });
        await sleep(delay);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async followMagicLink(link) {
    let url = assertSafeUrl(link, this.apiOrigin).href;
    for (let i = 0; i < 8; i += 1) {
      const { res, data } = await this.request("GET", url, undefined, { redirect: "manual", allowUnauthorized: true });
      const location = res.headers.get("location");
      log("info", "magic-link step", { status: res.status, location: location ? safeUrlForLog(assertSafeUrl(location, url)) : null });
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) return data;
      url = assertSafeUrl(location, url).href;
    }
    throw new Error("too many redirects while completing magic link");
  }

  async api(method, pathName, body, options) {
    return (await this.request(method, pathName, body, options)).data;
  }
}

async function requestMagicLink(client, email) {
  try {
    await client.api("POST", "/auth/request", { email }, { timeoutMs: AUTH_REQUEST_TIMEOUT_MS });
    log("success", "magic link requested; check your email");
  } catch (err) {
    if (err.code !== "MAGIC_LINK_MAY_BE_SENT") throw err;
    log("warn", err.message);
  }
  client.state.email = email;
  client.state.login_requested_at = new Date().toISOString();
  client.save();
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) throw new Error(`bad nonce_prefix hex: ${hex}`);
  return Buffer.from(hex, "hex");
}

function nonceLe64(nonce) {
  const out = Buffer.allocUnsafe(8);
  let n = BigInt(nonce);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function trailingZeroBits(buf) {
  let bits = 0;
  for (let i = buf.length - 1; i >= 0; i -= 1) {
    const byte = buf[i];
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let bit = 0; bit < 8; bit += 1) {
      if ((byte & (1 << bit)) === 0) bits += 1;
      else return bits;
    }
  }
  return bits;
}

function defaultWorkerCount() {
  return Math.max(1, Math.min(os.cpus().length - 1, os.cpus().length, 8));
}

function nativeMinerPath() {
  return NATIVE_MINER_CANDIDATES.find((file) => fs.existsSync(file)) || null;
}

function mineSolutionSingleThread(challenge, state, stateFile, logEveryMs) {
  const prefix = hexToBytes(challenge.nonce_prefix);
  const difficulty = Number(challenge.difficulty_bits);
  const expiresAt = challenge.expires_at ? Date.parse(challenge.expires_at) : null;
  const cutoffAt = Number.isFinite(expiresAt) ? expiresAt - 5000 : null;
  let nonce = BigInt(state.mining?.nonce || "0");
  let hashes = BigInt(state.mining?.hashes || "0");
  const started = Date.now();
  let lastLog = started;
  while (true) {
    if (cutoffAt && Date.now() >= cutoffAt) {
      const err = new Error("challenge expired before a solution was found");
      err.code = "CHALLENGE_EXPIRED";
      err.retryable = true;
      throw err;
    }
    const digest = crypto.createHash("sha256").update(prefix).update(nonceLe64(nonce)).digest();
    if (trailingZeroBits(digest) >= difficulty) {
      state.mining = { ...state.mining, nonce: nonce.toString(), hashes: hashes.toString(), found_at: new Date().toISOString() };
      saveState(stateFile, state);
      return { solution_nonce: nonce.toString(), hashes: hashes.toString(), digest: digest.toString("hex") };
    }
    nonce += 1n;
    hashes += 1n;
    const now = Date.now();
    if (now - lastLog >= logEveryMs) {
      const seconds = Math.max(1, (now - started) / 1000);
      const rate = Number(hashes) / seconds;
      state.mining = { challenge_id: challenge.challenge_id, nonce: nonce.toString(), hashes: hashes.toString(), difficulty_bits: difficulty };
      saveState(stateFile, state);
      log("info", "mining progress", {
        hashes: hashes.toString(),
        nonce: nonce.toString(),
        rate_mhs: `${(rate / 1_000_000).toFixed(2)} MH/s`,
        rate_hps: Math.round(rate),
      });
      lastLog = now;
    }
  }
}

function mineSolutionParallel(challenge, state, stateFile, logEveryMs, workerCount) {
  if (workerCount <= 1) return Promise.resolve(mineSolutionSingleThread(challenge, state, stateFile, logEveryMs));

  return new Promise((resolve, reject) => {
    const difficulty = Number(challenge.difficulty_bits);
    const expiresAt = challenge.expires_at ? Date.parse(challenge.expires_at) : null;
    const cutoffAt = Number.isFinite(expiresAt) ? expiresAt - 5000 : null;
    const startNonce = BigInt(state.mining?.nonce || "0");
    const started = Date.now();
    const workers = [];
    const workerStats = new Map();
    let settled = false;
    let lastSavedNonce = startNonce;

    function cleanup() {
      for (const worker of workers) worker.terminate().catch(() => {});
    }

    function totalHashes() {
      let total = 0n;
      for (const stats of workerStats.values()) total += BigInt(stats.hashes || "0");
      return total;
    }

    function maxNonce() {
      let max = lastSavedNonce;
      for (const stats of workerStats.values()) {
        if (!stats.nonce) continue;
        const n = BigInt(stats.nonce);
        if (n > max) max = n;
      }
      return max;
    }

    const progressTimer = setInterval(() => {
      if (settled) return;
      const hashes = totalHashes();
      const seconds = Math.max(1, (Date.now() - started) / 1000);
      const rate = Number(hashes) / seconds;
      lastSavedNonce = maxNonce();
      state.mining = {
        challenge_id: challenge.challenge_id,
        nonce: lastSavedNonce.toString(),
        hashes: hashes.toString(),
        difficulty_bits: difficulty,
        workers: workerCount,
      };
      saveState(stateFile, state);
      log("info", "mining progress", {
        hashes: hashes.toString(),
        nonce: lastSavedNonce.toString(),
        workers: workerCount,
        rate_mhs: `${(rate / 1_000_000).toFixed(2)} MH/s`,
        rate_hps: Math.round(rate),
      });
    }, logEveryMs);

    for (let i = 0; i < workerCount; i += 1) {
      const worker = new Worker(MINER_WORKER, {
        workerData: {
          noncePrefix: challenge.nonce_prefix,
          difficultyBits: difficulty,
          startNonce: (startNonce + BigInt(i)).toString(),
          stride: String(workerCount),
          cutoffAt,
          progressEveryMs: Math.max(500, Math.floor(logEveryMs / 2)),
        },
      });
      workers.push(worker);
      workerStats.set(i, { hashes: "0", nonce: (startNonce + BigInt(i)).toString() });

      worker.on("message", (message) => {
        if (settled) return;
        if (message.hashes !== undefined || message.nonce !== undefined) {
          workerStats.set(i, {
            hashes: message.hashes ?? workerStats.get(i)?.hashes ?? "0",
            nonce: message.nonce ?? workerStats.get(i)?.nonce,
          });
        }
        if (message.type === "found") {
          settled = true;
          clearInterval(progressTimer);
          cleanup();
          const hashes = totalHashes();
          const seconds = Math.max(0.001, (Date.now() - started) / 1000);
          const rate = Number(hashes) / seconds;
          state.mining = {
            ...state.mining,
            nonce: message.solution_nonce,
            hashes: hashes.toString(),
            found_at: new Date().toISOString(),
            workers: workerCount,
          };
          saveState(stateFile, state);
          resolve({
            solution_nonce: message.solution_nonce,
            hashes: hashes.toString(),
            digest: message.digest,
            speed: `${(rate / 1_000_000).toFixed(2)} MH/s`,
            elapsed_ms: Date.now() - started,
          });
        }
        if (message.type === "expired") {
          settled = true;
          clearInterval(progressTimer);
          cleanup();
          const err = new Error("challenge expired before a solution was found");
          err.code = "CHALLENGE_EXPIRED";
          err.retryable = true;
          reject(err);
        }
      });

      worker.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearInterval(progressTimer);
        cleanup();
        reject(err);
      });

      worker.on("exit", (code) => {
        if (!settled && code !== 0) {
          settled = true;
          clearInterval(progressTimer);
          cleanup();
          reject(new Error(`miner worker exited with code ${code}`));
        }
      });
    }
  });
}

function mineSolutionNative(challenge, state, stateFile, logEveryMs, workerCount) {
  const nativeMiner = nativeMinerPath();
  if (!nativeMiner) {
    throw new Error(`native miner not built; expected one of: ${NATIVE_MINER_CANDIDATES.join(", ")}`);
  }
  return new Promise((resolve, reject) => {
    const difficulty = Number(challenge.difficulty_bits);
    const expiresAt = challenge.expires_at ? Date.parse(challenge.expires_at) : null;
    const cutoffAt = Number.isFinite(expiresAt) ? expiresAt - 5000 : 0;
    const startNonce = BigInt(state.mining?.nonce || "0");
    const started = Date.now();
    let settled = false;
    let stderr = "";

    const child = spawn(nativeMiner, [
      "--prefix", challenge.nonce_prefix,
      "--difficulty", String(difficulty),
      "--workers", String(workerCount),
      "--start", startNonce.toString(),
      "--cutoff-ms", String(cutoffAt || 0),
      "--progress-ms", String(logEveryMs),
    ], { windowsHide: true });

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const idx = buffer.indexOf("\n");
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          log("warn", "native miner emitted non-json line", { line });
          continue;
        }
        if (message.type === "progress") {
          const hashes = BigInt(message.hashes || "0");
          const seconds = Math.max(1, (Date.now() - started) / 1000);
          const rate = Number(hashes) / seconds;
          state.mining = {
            challenge_id: challenge.challenge_id,
            nonce: message.nonce,
            hashes: hashes.toString(),
            difficulty_bits: difficulty,
            workers: workerCount,
            engine: "native",
          };
          saveState(stateFile, state);
          log("info", "mining", {
            hashes: hashes.toString(),
            nonce: message.nonce,
            workers: workerCount,
            engine: "native",
            speed: `${(rate / 1_000_000).toFixed(2)} MH/s`,
          });
        }
        if (message.type === "found") {
          settled = true;
          const hashes = BigInt(message.hashes || "0");
          const seconds = Math.max(0.001, (Date.now() - started) / 1000);
          const rate = Number(hashes) / seconds;
          state.mining = {
            ...state.mining,
            nonce: message.solution_nonce,
            hashes: message.hashes,
            found_at: new Date().toISOString(),
            workers: workerCount,
            engine: "native",
          };
          saveState(stateFile, state);
          resolve({
            solution_nonce: message.solution_nonce,
            hashes: message.hashes,
            digest: message.digest,
            speed: `${(rate / 1_000_000).toFixed(2)} MH/s`,
            elapsed_ms: Date.now() - started,
          });
        }
        if (message.type === "expired") {
          settled = true;
          const err = new Error("challenge expired before a solution was found");
          err.code = "CHALLENGE_EXPIRED";
          err.retryable = true;
          reject(err);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (settled) return;
      if (code === 0) return;
      reject(new Error(`native miner exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function promptLine(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(label, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

async function promptDefault(label, defaultValue) {
  const suffix = defaultValue === undefined || defaultValue === "" ? "" : ` [${defaultValue}]`;
  const answer = await promptLine(`${label}${suffix}: `);
  return answer || String(defaultValue || "");
}

async function promptNumber(label, defaultValue, validate) {
  while (true) {
    const value = Number(await promptDefault(label, defaultValue));
    if (Number.isFinite(value) && (!validate || validate(value))) return value;
    log("warn", "please enter a valid number");
  }
}

async function promptYesNo(label, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await promptLine(`${label} [${hint}]: `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function runMining(client, args = {}) {
  const targetValue = args.count !== undefined ? args.count : args.tokens !== undefined ? args.tokens : 1;
  const target = Number(targetValue);
  const workers = Number(args.workers || defaultWorkerCount());
  const engine = args.engine || (nativeMinerPath() ? "native" : "node");
  const logEveryMs = Number(args["log-every-ms"] || (engine === "native" ? 1000 : 5000));
  if (!Number.isInteger(target) || target < 0) throw new Error("--count must be 0 or a positive integer");
  if (!Number.isInteger(workers) || workers < 1 || workers > maxWorkerCount()) {
    throw new Error(`--workers must be between 1 and ${maxWorkerCount()}`);
  }
  if (!["native", "node"].includes(engine)) throw new Error("--engine must be native or node");
  let minted = 0;
  const endless = target === 0;
  const me = await client.api("GET", "/me");
  const useDashboard = args.dashboard !== false && args["no-dashboard"] !== true && process.stdout.isTTY;
  if (useDashboard) {
    activeDashboard = new Dashboard({
      target: endless ? "until stopped" : String(target),
      workers,
      maxWorkers: maxWorkerCount(),
      totalMined: Number(me.minted || 0),
    });
    activeDashboard.update({ status: "STARTING" });
  }
  while (endless || minted < target) {
    let challenge = client.state.challenge;
    const challengeExpiresAt = challenge?.expires_at ? Date.parse(challenge.expires_at) : null;
    const challengeExpired = Number.isFinite(challengeExpiresAt) && Date.now() >= challengeExpiresAt - 5000;
    if (!challenge || challengeExpired || client.state.mining?.challenge_id !== challenge.challenge_id || args.fresh) {
      if (challengeExpired) log("warn", "saved challenge expired; requesting a fresh one", { challenge_id: challenge.challenge_id });
      challenge = await client.api("POST", "/challenge");
      client.state.challenge = challenge;
      client.state.mining = { challenge_id: challenge.challenge_id, nonce: "0", hashes: "0", difficulty_bits: challenge.difficulty_bits };
      client.save();
    }
    log("info", "challenge", {
      id: challenge.challenge_id,
      difficulty: `${challenge.difficulty_bits} bits`,
      expires: challenge.expires_at,
    });
    let solution;
    try {
      log("info", "miner config", { workers, engine });
      solution = engine === "native"
        ? await mineSolutionNative(challenge, client.state, client.stateFile, logEveryMs, workers)
        : await mineSolutionParallel(challenge, client.state, client.stateFile, logEveryMs, workers);
    } catch (err) {
      if (err.code === "CHALLENGE_EXPIRED") {
        log("warn", "challenge expired during mining; requesting a fresh one");
        client.state.challenge = null;
        client.state.mining = null;
        client.save();
        continue;
      }
      throw err;
    }
    log("info", "solution found", {
      nonce: solution.solution_nonce,
      hashes: solution.hashes,
      speed: solution.speed,
      elapsed_ms: solution.elapsed_ms,
    });
    try {
      const result = await client.api("POST", "/mint", {
        challenge_id: challenge.challenge_id,
        solution_nonce: solution.solution_nonce,
      });
      minted += 1;
      client.state.last_mint = result;
      client.state.challenge = null;
      client.state.mining = null;
      client.save();
      log("success", "mint/claim accepted", result);
      log("success", "mint progress", {
        minted,
        target: endless ? "until-stopped" : target,
        remaining: endless ? "until-stopped" : Math.max(0, target - minted),
      });
    } catch (err) {
      if (err.code === "UNAUTHORIZED") {
        log("warn", "session invalid; rerun login/complete-login, then rerun mine to resume");
        throw err;
      }
      log("warn", "mint failed; dropping challenge and continuing with a fresh one", { error: err.message, code: err.code, status: err.status });
      client.state.challenge = null;
      client.state.mining = null;
      client.save();
    }
  }
  log("success", "pipeline complete", {
    minted,
    target: endless ? "until-stopped" : target,
    remaining: endless ? "until-stopped" : Math.max(0, target - minted),
  });
  if (activeDashboard) activeDashboard.stop("DONE");
}

async function ensureLoginInteractive(client) {
  try {
    const me = await client.api("GET", "/me");
    log("success", "already logged in", me);
    return me;
  } catch (err) {
    if (err.code !== "UNAUTHORIZED") throw err;
  }

  const savedEmail = client.state.email || "";
  const email = await promptDefault("Email login", savedEmail);
  if (!email) throw new Error("email is required");
  await requestMagicLink(client, email);

  while (true) {
    const link = await promptLine("Paste magic link: ");
    if (!link) {
      log("warn", "magic link is required");
      continue;
    }
    await client.followMagicLink(link);
    const me = await client.api("GET", "/me");
    log("success", "session active", me);
    return me;
  }
}

async function interactive(client, args) {
  console.log("RPOW CLI interactive setup");
  console.log("This will store your session in .rpow-cli-state.json. Do not share that file.\n");
  await ensureLoginInteractive(client);
  if (!(await promptYesNo("Start mining now", true))) {
    log("success", "login complete; run node rpow-cli.js mine when you are ready");
    return;
  }
  const defaultEngine = nativeMinerPath() ? "native" : "node";
  const engine = await promptDefault("Engine", defaultEngine);
  const workers = await promptNumber(
    `Workers (max ${maxWorkerCount()} auto-detected)`,
    defaultWorkerCount(),
    (value) => Number.isInteger(value) && value > 0 && value <= maxWorkerCount()
  );
  const count = await promptNumber("How many tokens to mint (0 = until stopped)", 0, (value) => Number.isInteger(value) && value >= 0);
  await runMining(client, { ...args, engine, workers, count });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  globalThis.__RPOW_VERBOSE__ = args.verbose === true;
  const command = args._[0] || "interactive";
  const discovered = discoverFromIndex(args.index || DEFAULT_INDEX);
  const client = new RpowClient({
    apiOrigin: args.api || discovered.apiOrigin,
    siteOrigin: args.site || DEFAULT_SITE_ORIGIN,
    stateFile: args.state || DEFAULT_STATE,
    timeoutMs: args.timeout || 20000,
    retries: args.retries || 5,
  });

  if (command === "interactive" || command === "start") {
    await interactive(client, args);
    return;
  }

  if (command === "map") {
    printApiMap(discovered);
    return;
  }

  if (command === "login") {
    const email = args.email || await promptLine("email: ");
    await requestMagicLink(client, email);
    log("success", "run complete-login with the emailed URL");
    return;
  }

  if (command === "complete-login") {
    const link = args.link || await promptLine("magic link: ");
    await client.followMagicLink(link);
    const me = await client.api("GET", "/me");
    log("success", "session active", me);
    return;
  }

  if (command === "me") {
    log("info", "me", await client.api("GET", "/me"));
    return;
  }

  if (command === "ledger") {
    log("info", "ledger", await client.api("GET", "/ledger", undefined, { allowUnauthorized: true }));
    return;
  }

  if (command === "activity") {
    log("info", "activity", await client.api("GET", "/activity"));
    return;
  }

  if (command === "send") {
    const recipient = args.to || await promptLine("recipient email: ");
    const amount = Number(args.amount || await promptLine("amount: "));
    const idempotency_key = args.idempotency || crypto.randomUUID();
    log("success", "send result", await client.api("POST", "/send", { recipient_email: recipient, amount, idempotency_key }));
    return;
  }

  if (command === "logout") {
    await client.api("POST", "/auth/logout");
    client.state.cookies = {};
    client.save();
    log("success", "logged out");
    return;
  }

  if (command === "mine" || command === "run") {
    await runMining(client, args);
    return;
  }

  console.log(`Usage:
  node rpow-cli.js
  node rpow-cli.js interactive
  node rpow-cli.js map
  node rpow-cli.js login --email you@example.com
  node rpow-cli.js complete-login --link "https://..."
  node rpow-cli.js me
  node rpow-cli.js mine --count 1 --engine native
  node rpow-cli.js mine --count 0 --engine native
  node rpow-cli.js run --count 3 --engine native
  node rpow-cli.js send --to user@example.com --amount 1
  node rpow-cli.js ledger
  node rpow-cli.js activity
  node rpow-cli.js logout

Options:
  --state .rpow-cli-state.json
  --timeout 20000
  --retries 5
  --log-every-ms 5000
  --workers ${defaultWorkerCount()}
  --engine native|node  (native C miner recommended)
  --count 0 means mine until you stop it with Ctrl+C
  --no-dashboard prints plain logs instead of the live dashboard
  --verbose`);
}

main().catch((err) => {
  log("error", err.message, { code: err.code, status: err.status });
  if (activeDashboard) activeDashboard.stop("ERROR");
  process.exitCode = 1;
});
