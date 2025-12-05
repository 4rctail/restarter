/**
 * restart-orchestrator: Restarts multiple Render services when notified by UptimeRobot
 *
 * Usage:
 *   - Configure SERVICES_JSON (see .env.example)
 *   - Configure UPTIMEROBOT_SECRET to validate incoming webhooks
 *   - Optionally set ALERT_WEBHOOK to receive error notifications (Discord/Slack webhook)
 *
 * Endpoint:
 *   POST /webhook/uptimerobot  (header: x-uptimerobot-secret: <secret>)
 *
 * Deploy: Dockerfile included
 */

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "128kb" }));

// CONFIG from ENV
const PORT = Number(process.env.PORT || 3000);
const UPTIMEROBOT_SECRET = process.env.UPTIMEROBOT_SECRET || null;
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || null; // optional: discord/slack webhook URL
// SERVICES_JSON must be a JSON array string of objects:
// [ {"apiKey":"sk_xxx","serviceId":"svc-abc","name":"Account A / Service X"}, ... ]
const SERVICES_JSON = process.env.SERVICES_JSON || "[]";
let SERVICES = [];
try {
  SERVICES = JSON.parse(SERVICES_JSON);
  if (!Array.isArray(SERVICES)) throw new Error("SERVICES_JSON must be an array");
} catch (err) {
  console.error("❌ Failed to parse SERVICES_JSON:", err.message);
  SERVICES = [];
}

// PARAMETERS (tweak as needed)
const SUSPEND_TIMEOUT_MS = Number(process.env.SUSPEND_TIMEOUT_MS || 60_000);
const START_TIMEOUT_MS = Number(process.env.START_TIMEOUT_MS || 180_000);
const STATUS_POLL_INTERVAL_MS = Number(process.env.STATUS_POLL_INTERVAL_MS || 5_000);
const ACTION_RETRY = Number(process.env.ACTION_RETRY || 3);
const DEBUG = (process.env.DEBUG || "false").toLowerCase() === "true";

function log(...args) {
  if (DEBUG) console.log(...args);
  else console.log(...args);
}

// Helper: send alert to webhook if configured
async function sendAlert(text) {
  if (!ALERT_WEBHOOK) return;
  try {
    await fetch(ALERT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
  } catch (e) {
    console.warn("⚠️ Failed to send alert:", e.message || e);
  }
}

// Basic Render API action (suspend/resume). key must be the API key for that account.
async function renderAction(id, action, key) {
  const url = `https://api.render.com/v1/services/${id}/${action}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": "restart-orchestrator/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Render ${action} failed for ${id} (${res.status}): ${body}`);
  }
  return true;
}

// Poll status endpoint until state matches an allowed running/suspended value (or timeout)
async function waitForStatus(id, key, allowedStates = ["live", "running", "healthy"], timeoutMs = START_TIMEOUT_MS) {
  const start = Date.now();
  while (true) {
    try {
      const res = await fetch(`https://api.render.com/v1/services/${id}`, {
        headers: { Authorization: `Bearer ${key}`, "User-Agent": "restart-orchestrator/1.0" },
      });

      if (res.ok) {
        const json = await res.json();
        // Render's payload may contain json.service.status or json.state; handle common variations
        const status = (json.service?.status || json.service?.state || json.state || "").toString().toLowerCase();
        log(`[status] ${id} => ${status}`);
        if (allowedStates.includes(status)) return { ok: true, status };
      } else {
        const txt = await res.text().catch(() => "");
        log(`[status] ${id} fetch returned ${res.status} ${txt}`);
      }
    } catch (err) {
      log(`[status] ${id} fetch error:`, err.message || err);
    }

    if (Date.now() - start > timeoutMs) {
      return { ok: false, reason: "timeout" };
    }
    await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }
}

// Restart sequence: suspend -> confirm -> resume -> confirm
async function restartService(entry) {
  const { apiKey, serviceId, name } = entry;
  const label = name || serviceId;
  log(`--- Restarting ${label} ---`);

  // 1) Suspend (with retries)
  let suspended = false;
  for (let attempt = 1; attempt <= ACTION_RETRY; attempt++) {
    try {
      log(`[${label}] suspend attempt ${attempt}`);
      await renderAction(serviceId, "suspend", apiKey);
      // confirm suspended within timeout
      const r = await waitForStatus(serviceId, apiKey, ["suspended", "inactive", "stopped"], SUSPEND_TIMEOUT_MS);
      if (r.ok) {
        suspended = true;
        log(`[${label}] suspended (confirmed: ${r.status})`);
        break;
      } else {
        log(`[${label}] suspend not confirmed (attempt ${attempt})`);
      }
    } catch (err) {
      log(`[${label}] suspend error (attempt ${attempt}):`, err.message || err);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt)); // backoff
  }

  if (!suspended) {
    const msg = `⚠️ ${label} — suspend step failed after ${ACTION_RETRY} attempts. Attempting resume anyway.`;
    console.warn(msg);
    await sendAlert(msg);
  }

  // small wait to allow Render to settle
  await new Promise((r) => setTimeout(r, 2000));

  // 2) Resume (with retries)
  let resumed = false;
  for (let attempt = 1; attempt <= ACTION_RETRY; attempt++) {
    try {
      log(`[${label}] resume attempt ${attempt}`);
      await renderAction(serviceId, "resume", apiKey);
      const r = await waitForStatus(serviceId, apiKey, ["live", "running", "healthy"], START_TIMEOUT_MS);
      if (r.ok) {
        resumed = true;
        log(`[${label}] resumed and live (status: ${r.status})`);
        break;
      } else {
        log(`[${label}] resume not confirmed (attempt ${attempt})`);
      }
    } catch (err) {
      log(`[${label}] resume error (attempt ${attempt}):`, err.message || err);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }

  if (!resumed) {
    const msg = `❌ ${label} — resume failed after ${ACTION_RETRY} attempts.`;
    console.error(msg);
    await sendAlert(msg);
    return { ok: false, error: msg };
  }

  return { ok: true };
}

// Orchestrator: iterate through SERVICES and restart each in sequence (or parallel if you want)
async function orchestrateRestartAll() {
  if (!Array.isArray(SERVICES) || SERVICES.length === 0) {
    const msg = "No services configured in SERVICES_JSON";
    console.warn(msg);
    await sendAlert(msg);
    return { ok: false, reason: "no-services" };
  }

  const results = [];
  for (const s of SERVICES) {
    try {
      const res = await restartService(s);
      results.push({ service: s.serviceId || s.name, result: res });
    } catch (err) {
      const message = `Exception restarting ${s.name || s.serviceId}: ${err.message || err}`;
      console.error(message);
      await sendAlert(message);
      results.push({ service: s.serviceId || s.name, result: { ok: false, error: message } });
    }
  }
  return results;
}

// Webhook endpoint for UptimeRobot
app.post("/webhook/uptimerobot", async (req, res) => {
  try {
    // Verify secret header
    const secret = req.headers["x-uptimerobot-secret"] || null;
    if (!UPTIMEROBOT_SECRET || secret !== UPTIMEROBOT_SECRET) {
      log("Unauthorized webhook call (invalid secret)");
      return res.status(401).json({ ok: false, reason: "unauthorized" });
    }

    // Basic event validation — UptimeRobot sends monitor info. We'll accept any body and trigger restart.
    log("UptimeRobot webhook received:", JSON.stringify(req.body).slice(0, 400));

    // Optionally you could inspect req.body.monitor or req.body.alert to decide whether to restart
    // For now, always restart all services on valid webhook
    orchestrateRestartAll().catch((e) => {
      console.error("orchestrateRestartAll error:", e);
      sendAlert(`orchestrator error: ${e.message || e}`);
    });

    return res.json({ ok: true, message: "Restart initiated" });
  } catch (err) {
    console.error("Webhook handling error:", err);
    await sendAlert(`Webhook handling error: ${err.message || err}`);
    return res.status(500).json({ ok: false, error: "internal" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, services: SERVICES.length }));

// start server
app.listen(PORT, () => {
  console.log(`restart-orchestrator listening on port ${PORT} (PID ${process.pid})`);
});
