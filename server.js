/**
 * AUTORESTART WATCHDOG (NO UPTIMEROBOT, NO WEBHOOKS)
 * -------------------------------------------------
 * Directly pings each Render service.
 *
 * RULES:
 *   Check service 1:
 *     - If fail → wait 20 min → check again.
 *     - If fail again → restart service 1.
 *
 *   Check service 2:
 *     - If fail → wait 20 min → check again.
 *     - If fail again → restart service 2.
 *
 * Runs forever, every X minutes (configurable).
 */

import express from "express";
import fetch from "node-fetch";

// Load ENV
const PORT = Number(process.env.PORT || 3000);
const DEBUG = (process.env.DEBUG || "false").toLowerCase() === "true";

// Render Accounts
const RenderAPI_1 = process.env.RenderAPI_1;
const RenderAPI_2 = process.env.RenderAPI_2;

const RenderServiceID_1 = process.env.RenderServiceID_1;
const RenderServiceID_2 = process.env.RenderServiceID_2;

// HEALTH URLS (REQUIRED)
const HEALTH_URL_1 = process.env.HEALTH_URL_1;  // e.g.: https://bot1.onrender.com/
const HEALTH_URL_2 = process.env.HEALTH_URL_2;  // e.g.: https://bot2.onrender.com/

// Timing
const FIRST_RETRY_DELAY = 20 * 60 * 1000; // 20 minutes
const CHECK_INTERVAL = 5 * 60 * 1000;     // check every 5 minutes
const STATUS_POLL_INTERVAL_MS = 5000;
const RESUME_TIMEOUT_MS = 180000;
const SUSPEND_TIMEOUT_MS = 60000;
const ACTION_RETRY = 3;

function log(...msg) {
  console.log("[Watchdog]", ...msg);
}

// ------------------------------------------------------
//  Render API helpers
// ------------------------------------------------------
async function renderAction(id, action, key) {
  const res = await fetch(`https://api.render.com/v1/services/${id}/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "User-Agent": "autorestart-watchdog",
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${action} ${id} failed: ${res.status} ${text}`);
  }
}

async function waitForStatus(id, key, allowed, timeout) {
  const start = Date.now();
  while (true) {
    try {
      const res = await fetch(`https://api.render.com/v1/services/${id}`, {
        headers: { Authorization: `Bearer ${key}` }
      });

      if (res.ok) {
        const json = await res.json();
        const status =
          json.service?.status?.toLowerCase() ||
          json.state?.toLowerCase() ||
          "";

        if (DEBUG) log(`Status ${id}: ${status}`);

        if (allowed.includes(status)) return true;
      }
    } catch {}

    if (Date.now() - start >= timeout) return false;
    await new Promise(r => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }
}

// Restart sequence for one service
async function restartService(name, serviceID, apiKey) {
  log(`🔄 Restarting "${name}" (${serviceID})...`);

  // Suspend with retries
  for (let i = 1; i <= ACTION_RETRY; i++) {
    try {
      await renderAction(serviceID, "suspend", apiKey);
      const ok = await waitForStatus(
        serviceID,
        apiKey,
        ["suspended", "inactive", "stopped"],
        SUSPEND_TIMEOUT_MS
      );
      if (ok) break;
    } catch (err) {
      log(`Suspend fail (${i}):`, err.message);
    }
  }

  // Resume with retries
  for (let i = 1; i <= ACTION_RETRY; i++) {
    try {
      await renderAction(serviceID, "resume", apiKey);
      const ok = await waitForStatus(
        serviceID,
        apiKey,
        ["running", "healthy", "live"],
        RESUME_TIMEOUT_MS
      );
      if (ok) {
        log(`✅ Restart OK: ${name}`);
        return;
      }
    } catch (err) {
      log(`Resume fail (${i}):`, err.message);
    }
  }

  log(`❌ FAILED RESTART: ${name}`);
}

// ------------------------------------------------------
//  HEALTH CHECK LOGIC (YOUR RULESET)
// ------------------------------------------------------
async function checkService(name, url, serviceID, apiKey) {
  log(`Checking ${name} at ${url} ...`);

  let ok1 = false;
  try {
    const res = await fetch(url, { method: "GET" });
    ok1 = res.ok;
  } catch {}

  if (ok1) {
    log(`✔ ${name} is healthy`);
    return;
  }

  log(`⚠ ${name} FAILED first check → waiting 20 minutes...`);
  await new Promise(r => setTimeout(r, FIRST_RETRY_DELAY));

  log(`Retrying check for ${name}...`);

  let ok2 = false;
  try {
    const res = await fetch(url, { method: "GET" });
    ok2 = res.ok;
  } catch {}

  if (ok2) {
    log(`✔ ${name} recovered on second try`);
    return;
  }

  log(`❌ ${name} FAILED second check → RESTARTING NOW`);
  await restartService(name, serviceID, apiKey);
}

// ------------------------------------------------------
// MAIN LOOP
// ------------------------------------------------------
async function mainLoop() {
  await checkService("SERVICE 1", HEALTH_URL_1, RenderServiceID_1, RenderAPI_1);
  await checkService("SERVICE 2", HEALTH_URL_2, RenderServiceID_2, RenderAPI_2);
}

setInterval(mainLoop, CHECK_INTERVAL);
mainLoop();

// ------------------------------------------------------
// EXPRESS SERVER (optional)
// ------------------------------------------------------
const app = express();
app.get("/", (req, res) =>
  res.json({ ok: true, message: "Watchdog running", time: Date.now() })
);
app.listen(PORT, () => log(`Server running on port ${PORT}`));
