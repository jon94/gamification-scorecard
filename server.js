#!/usr/bin/env node
/**
 * server.js — Datadog Adoption Scorecard local server
 *
 * Serves the static dashboard AND auto-refreshes data from Datadog APIs.
 * API keys stay server-side — never exposed to the browser.
 *
 * Usage:
 *   node server.js          # starts on port 3000
 *   PORT=8080 node server.js
 *
 * Endpoints:
 *   GET /              → index.html
 *   GET /api/data      → latest scorecard data (JSON)
 *   POST /api/refresh  → trigger an immediate Datadog API refresh
 *   GET /api/status    → last refresh time + next refresh countdown
 */

'use strict';

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { URL } = require('url');

// ─── Config ──────────────────────────────────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

const DD_API_KEY     = process.env.DD_API_KEY;
const DD_APP_KEY     = process.env.DD_APP_KEY;
const DD_SITE        = process.env.DD_SITE || 'datadoghq.com';
const DD_ORG_NAME    = process.env.DD_ORG_NAME || 'My Org';
const DD_USER_DOMAIN = process.env.DD_USER_DOMAIN || '';
const DD_USER_EMAILS = (process.env.DD_USER_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const DD_USER_LIMIT  = parseInt(process.env.DD_USER_LIMIT || '0', 10); // 0 = no limit

const PORT            = parseInt(process.env.PORT || '3000', 10);
const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS || String(30 * 60 * 1000), 10); // default 30 min

if (!DD_API_KEY || !DD_APP_KEY) {
  console.error('\n❌  DD_API_KEY and DD_APP_KEY must be set in .env\n');
  process.exit(1);
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
let cache = {
  data:        null,   // the full data object (JSON-serialisable)
  lastRefresh: null,   // Date
  refreshing:  false,
  error:       null,
};

// ─── In-memory manual overrides (not persisted; cleared on restart) ───────────
// Structure: { [email]: { [milestone_id]: boolean } }
const manualOverrides = {};

// ─── MIME types ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// ─── Datadog API helpers ──────────────────────────────────────────────────────
function ddHeaders() {
  return {
    'DD-API-KEY':         DD_API_KEY,
    'DD-APPLICATION-KEY': DD_APP_KEY,
    'Content-Type':       'application/json',
  };
}

function apiRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function ddGet(p)        { return apiRequest({ hostname: `api.${DD_SITE}`, path: p, method: 'GET',  headers: ddHeaders() }); }
function ddPost(p, body) {
  const s = JSON.stringify(body);
  return apiRequest({ hostname: `api.${DD_SITE}`, path: p, method: 'POST',
    headers: { ...ddHeaders(), 'Content-Length': Buffer.byteLength(s) } }, body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Milestone definitions (aligned to committed Datadog SKUs) ────────────────
const MILESTONES = {
  core: [
    { id: 'dashboard_created', name: 'Dashboard Created',                 icon: '📊', points: 150, type: 'audit', audit_query: '@action:created @evt.name:Dashboard' },
    { id: 'monitor_created',   name: 'Alert Configured',                  icon: '🔔', points: 150, type: 'audit', audit_query: '@action:created @evt.name:Monitor' },
    { id: 'slo_created',       name: 'SLO Created',                       icon: '🎯', points: 200, type: 'audit', audit_query: '@action:created @evt.name:SLO' },
    { id: 'notebook_created',  name: 'Notebook Authored',                 icon: '📓', points: 100, type: 'audit', audit_query: '@action:created @evt.name:Notebook' },
    { id: 'case_created',      name: 'Case Created',                      icon: '📋', points: 100, type: 'audit', audit_query: '@action:created @evt.name:Case Management' },
    { id: 'user_invited',      name: 'Team Member Invited',               icon: '👥', points: 100, type: 'audit', audit_query: '@action:created @evt.name:Access Management @asset.type:user' },
    { id: 'bits_ai_sre',       name: 'Trigger Bits AI SRE Investigation', icon: '🤖', points: 200, type: 'audit', audit_query: '@action:created @evt.name:Bits AI SRE' },
  ],
  org: [
    { id: 'infra_hosts',     name: 'Infra Hosts',        icon: '🖥️',  type: 'metric', metric: 'datadog.estimated_usage.hosts' },
    { id: 'containers',      name: 'Containers',         icon: '📦',  type: 'metric', metric: 'datadog.estimated_usage.containers' },
    { id: 'apm_active',      name: 'APM',                icon: '🔭',  type: 'metric', metric: 'datadog.estimated_usage.apm_hosts' },
    { id: 'ingested_spans',  name: 'APM Ingested Spans', icon: '🕸️',  type: 'metric', metric: 'datadog.estimated_usage.apm.ingested_spans' },
    { id: 'logs_active',     name: 'Log Management',     icon: '📋',  type: 'metric', metric: 'datadog.estimated_usage.logs.ingested_events' },
    { id: 'rum_active',      name: 'RUM',                icon: '🌐',  type: 'metric', metric: 'datadog.estimated_usage.rum.sessions' },
    { id: 'custom_metrics',  name: 'Custom Metrics',     icon: '📐',  type: 'metric', metric: 'datadog.estimated_usage.metrics.custom' },
    { id: 'serverless',      name: 'Serverless',         icon: '☁️',  type: 'metric', metric: 'datadog.estimated_usage.fargate_tasks' },
  ],
  day1: [
    { id: 'session_1', name: 'Observability Overview & Platform Fundamentals', icon: '🎓', points: 100, type: 'manual' },
    { id: 'session_2', name: 'APM Fundamentals & Application Troubleshooting', icon: '🔭', points: 100, type: 'manual' },
    { id: 'session_3', name: 'RUM & End-to-End User Journey Visibility',       icon: '🌐', points: 100, type: 'manual' },
  ],
  day2: [
    { id: 'session_4', name: 'Bits AI for Incident Investigation & Postmortem', icon: '🤖', points: 100, type: 'manual' },
    { id: 'session_5', name: 'Monitor & Alerting Best Practices',               icon: '🔔', points: 100, type: 'manual' },
    { id: 'session_6', name: 'Dashboarding for Operational Visibility',         icon: '📊', points: 100, type: 'manual' },
  ],
  self_learning: [
    { id: 'learning_path', name: 'Persona Based Learning Path', icon: '🎯', points: 150, type: 'manual' },
  ],
  special: [
    { id: 'dbm_active',       name: 'DBM Enabled',        icon: '🗄️',  points: 300, type: 'metric', metric: 'datadog.estimated_usage.dbm.hosts' },
    { id: 'profiling_active', name: 'Continuous Profiler', icon: '🔍',  points: 300, type: 'metric', metric: 'datadog.estimated_usage.profiling.hosts' },
    { id: 'network_active',   name: 'Network Monitoring',  icon: '🕸️',  points: 300, type: 'metric', metric: 'datadog.estimated_usage.network.hosts' },
  ],
  advance: [
    { id: 'cert_fundamentals', name: 'Datadog Fundamentals',   icon: '📜', points: 500, type: 'manual' },
    { id: 'cert_apm',          name: 'Datadog APM Cert',       icon: '🏆', points: 500, type: 'manual' },
    { id: 'cert_logs',         name: 'Datadog Log Management', icon: '🪵', points: 500, type: 'manual' },
  ],
};

const CERT_TIERS = [
  // Bronze: complete Day 1 opening session + first dashboard + first monitor
  { id: 'bronze',   icon: '🥉', color: '#cd7f32', gc_bonus: 200,
    required: ['session_1', 'dashboard_created', 'monitor_created'] },
  // Silver: full Day 1 + SLO
  { id: 'silver',   icon: '🥈', color: '#c0c0c0', gc_bonus: 300,
    required: ['session_1', 'session_2', 'session_3', 'dashboard_created', 'monitor_created', 'slo_created'] },
  // Gold: full Day 2 + notebook + Bits AI SRE
  { id: 'gold',     icon: '🥇', color: '#f0b429', gc_bonus: 400,
    required: ['session_1', 'session_2', 'session_3', 'dashboard_created', 'monitor_created', 'slo_created',
               'session_4', 'session_5', 'session_6', 'notebook_created', 'bits_ai_sre'] },
  // Platinum: Gold + learning path + case + invited team member + 2 special achievements
  { id: 'platinum', icon: '💎', color: '#a78bfa', gc_bonus: 500,
    required: ['session_1', 'session_2', 'session_3', 'dashboard_created', 'monitor_created', 'slo_created',
               'session_4', 'session_5', 'session_6', 'notebook_created', 'bits_ai_sre',
               'learning_path', 'case_created', 'user_invited'],
    special_count: 2 },
];

// ─── Data fetch logic (same as refresh.js but returns object instead of writing file) ──
async function fetchData() {
  console.log(`\n[${new Date().toISOString()}] 🔄 Refreshing data from Datadog…`);

  // 1. Users
  let users = [];

  if (DD_USER_EMAILS.length > 0) {
    // When specific emails are set: build user objects directly from emails,
    // then try to enrich display names from a single page lookup (best-effort, fast).
    const nameMap = {};
    try {
      // Fetch first 1000 users and see if any of our targets are there
      for (let p = 0; p < 10; p++) {
        const res = await ddGet(`/api/v2/users?page[size]=100&page[number]=${p}`);
        if (res.status !== 200) break;
        const page = res.body.data || [];
        for (const u of page) {
          const email = (u.attributes?.email || '').toLowerCase();
          if (DD_USER_EMAILS.includes(email)) nameMap[email] = u.attributes?.name || email;
        }
        // Stop early if we found all targets
        if (DD_USER_EMAILS.every(e => nameMap[e])) break;
        if (page.length < 100) break;
        await sleep(100);
      }
    } catch (_) { /* non-critical */ }

    users = DD_USER_EMAILS.map(email => ({
      id:    email,
      email: email.toLowerCase(),
      // Use display name from API if found; otherwise derive from email local-part
      name:  nameMap[email] || email.split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '),
      title: '',
    }));
    console.log(`  Using ${users.length} user(s) from DD_USER_EMAILS.`);

  } else {
    // Paginate until we have enough users (capped at 10 pages if no domain/limit set)
    let allData = [];
    let pageNumber = 0;
    const targetLimit = DD_USER_LIMIT > 0 ? DD_USER_LIMIT : null;
    while (true) {
      const res = await ddGet(`/api/v2/users?page[size]=100&page[number]=${pageNumber}`);
      if (res.status !== 200) { console.warn(`  Users API ${res.status}`); break; }
      const page = res.body.data || [];
      allData = allData.concat(page);
      const total = res.body.meta?.page?.total_filtered_count || 0;
      if (page.length === 0 || allData.length >= total) break;
      if (!DD_USER_DOMAIN && !targetLimit && pageNumber >= 9) {
        console.log(`  (capped at ${allData.length} users — set DD_USER_DOMAIN or DD_USER_LIMIT)`);
        break;
      }
      // Stop early if we already have enough active users after filtering
      if (targetLimit) {
        const activeCount = allData.filter(u =>
          (u.attributes?.status || '').toLowerCase() === 'active' &&
          !u.attributes?.service_account &&
          (u.attributes?.email || '').includes('@') &&
          (!DD_USER_DOMAIN || (u.attributes?.email || '').endsWith('@' + DD_USER_DOMAIN))
        ).length;
        if (activeCount >= targetLimit) break;
      }
      pageNumber++;
      await sleep(150);
    }
    users = allData
      .filter(u => u.type === 'users')
      .filter(u => (u.attributes?.status || '').toLowerCase() === 'active' && !u.attributes?.service_account)
      .map(u => ({ id: u.id, name: u.attributes?.name || u.attributes?.email || u.id, email: (u.attributes?.email || '').toLowerCase(), title: u.attributes?.title || '' }))
      .filter(u => u.email);
    if (DD_USER_DOMAIN) users = users.filter(u => u.email.endsWith('@' + DD_USER_DOMAIN));
  }

  if (DD_USER_DOMAIN) users = users.filter(u => u.email.endsWith('@' + DD_USER_DOMAIN));
  if (DD_USER_LIMIT > 0 && users.length > DD_USER_LIMIT) users = users.slice(0, DD_USER_LIMIT);
  console.log(`  ${users.length} users`);

  // 2. Org-level metrics — collect evidence alongside the boolean result
  const checkedAt = new Date().toISOString();
  const nowMs     = Date.now();
  const oneYearAgoMs = nowMs - 365 * 24 * 60 * 60 * 1000;

  const orgResults  = {};  // id -> boolean (backward compat)
  const orgEvidence = {};  // id -> evidence object

  for (const ms of [...MILESTONES.org, ...MILESTONES.special.filter(s => s.type === 'metric')]) {
    const now  = Math.floor(nowMs / 1000);
    const from = now - 3600;
    const metricQuery = `max:${ms.metric}{*}`;
    try {
      const res = await ddGet(`/api/v1/query?query=${encodeURIComponent(metricQuery)}&from=${from}&to=${now}`);
      let maxVal = null;
      if (res.status === 200) {
        for (const s of (res.body.series || [])) {
          for (const pt of (s.pointlist || [])) {
            if (pt[1] !== null && (maxVal === null || pt[1] > maxVal)) maxVal = pt[1];
          }
        }
      }
      const active = maxVal !== null && maxVal > 0;
      orgResults[ms.id] = active;
      orgEvidence[ms.id] = {
        type:       'metric',
        metric:     ms.metric,
        value:      maxVal,
        passed:     active,
        checked_at: checkedAt,
        verify_url: `https://app.${DD_SITE}/metric/summary?filter=${ms.metric}`,
      };
    } catch (_) {
      orgResults[ms.id]  = false;
      orgEvidence[ms.id] = { type: 'metric', metric: ms.metric, value: null, passed: false, checked_at: checkedAt, verify_url: '' };
    }
    await sleep(150);
  }

  // 3. Overrides
  const overrides = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'overrides.json'), 'utf8'));
      delete raw._comment; return raw;
    } catch (_) { return {}; }
  })();

  // Apply in-memory manual overrides (set via POST /api/manual-override)
  for (const [email, vals] of Object.entries(manualOverrides)) {
    if (!overrides[email]) overrides[email] = {};
    Object.assign(overrides[email], vals);
  }

  // 4. BATCH audit check — 1 query per milestone covering all users (was N_users × N_milestones)
  const auditMilestones = [
    ...MILESTONES.core,
    ...MILESTONES.special.filter(s => s.type === 'audit'),
  ];
  const userEmailSet   = new Set(users.map(u => u.email.toLowerCase()));
  const milestoneHits  = {}; // milestone_id -> Set of emails that passed

  console.log(`Checking ${auditMilestones.length} audit milestones across ${users.length} users (batched)…`);
  for (const am of auditMilestones) {
    milestoneHits[am.id] = new Set();
    process.stdout.write(`  ${am.icon} ${am.name}… `);
    try {
      // Add email filter so only results for our tracked users are returned
      const emailFilter = users.map(u => `@usr.email:"${u.email}"`).join(' OR ');
      const batchQuery  = `${am.audit_query} (${emailFilter})`;
      let cursor = null;
      for (let page = 0; page < 5; page++) {
        const body = { filter: { query: batchQuery, from: 'now-1y', to: 'now' }, page: { limit: 200 } };
        if (cursor) body.page.cursor = cursor;
        const res = await ddPost('/api/v2/audit/events/search', body);
        if (res.status !== 200) break;
        for (const event of res.body.data || []) {
          const email = (event.attributes?.attributes?.usr?.email || '').toLowerCase();
          if (userEmailSet.has(email)) milestoneHits[am.id].add(email);
        }
        if (milestoneHits[am.id].size >= users.length) break;
        cursor = res.body.meta?.page?.after;
        if (!cursor) break;
      }
    } catch (_) { /* leaves empty set — all users get false */ }
    console.log(`${milestoneHits[am.id].size}/${users.length} ✅`);
    await sleep(200); // one small gap between milestone queries
  }

  // 5. Build per-user results from batch data — no more per-user API calls
  const userResults = [];
  for (const user of users) {
    const ms  = {};
    const ev  = {};
    const email = user.email.toLowerCase();

    // Org + metric specials (shared)
    for (const om of [...MILESTONES.org, ...MILESTONES.special.filter(s => s.type === 'metric')]) {
      ms[om.id] = orgResults[om.id];
      ev[om.id] = orgEvidence[om.id];
    }

    // Audit milestones from batch results
    for (const am of auditMilestones) {
      const passed    = milestoneHits[am.id].has(email);
      const userQuery = `${am.audit_query} @usr.email:${user.email}`;
      ms[am.id] = passed;
      ev[am.id] = {
        type: 'audit', query: userQuery,
        count: passed ? 1 : 0, last_event_at: null, last_event_name: null,
        passed, checked_at: checkedAt,
        verify_url: `https://app.${DD_SITE}/audit-trail?query=${encodeURIComponent(userQuery)}&from_ts=${oneYearAgoMs}&to_ts=${nowMs}&live=false`,
      };
    }

    // Manual milestones from overrides
    const userOvr = overrides[user.email] || {};
    for (const mm of [...MILESTONES.day1, ...MILESTONES.day2, ...MILESTONES.self_learning, ...MILESTONES.advance]) {
      ms[mm.id] = !!userOvr[mm.id];
      ev[mm.id] = { type: 'manual', checked_at: checkedAt, source: 'overrides.json' };
    }

    // Certification + scoring
    const allMs      = [...MILESTONES.core, ...MILESTONES.day1, ...MILESTONES.day2, ...MILESTONES.self_learning, ...MILESTONES.advance, ...MILESTONES.special];
    const milestoneGC = allMs.reduce((sum, m) => sum + (ms[m.id] ? m.points : 0), 0);
    const done        = allMs.filter(m => ms[m.id]).length;
    let cert = null, bonus = 0;
    for (const tier of [...CERT_TIERS].reverse()) {
      const hasAll    = tier.required.every(id => ms[id]);
      const specialOk = !tier.special_count || MILESTONES.special.filter(s => ms[s.id]).length >= tier.special_count;
      if (hasAll && specialOk) { cert = tier.id; bonus = tier.gc_bonus; break; }
    }
    userResults.push({ ...user, milestones: ms, evidence: ev, completion_pct: Math.round((done / allMs.length) * 100), total_gc: milestoneGC + bonus, milestone_gc: milestoneGC, bonus_gc: bonus, certification: cert });
  }
  console.log(`Built results for ${userResults.length} users.`);

  userResults.sort((a, b) => b.total_gc - a.total_gc);

  return {
    meta: { org_name: DD_ORG_NAME, last_updated: new Date().toISOString(), is_sample: false },
    milestones: MILESTONES,
    certification_tiers: CERT_TIERS,
    users: userResults,
  };
}

// ─── Refresh loop ─────────────────────────────────────────────────────────────
async function doRefresh() {
  if (cache.refreshing) return;
  cache.refreshing = true;
  cache.error = null;
  try {
    cache.data = await fetchData();
    cache.lastRefresh = new Date();
    console.log(`[${cache.lastRefresh.toISOString()}] ✅ Data refreshed (${cache.data.users.length} users)`);
  } catch (err) {
    cache.error = err.message;
    console.error(`[${new Date().toISOString()}] ❌ Refresh failed: ${err.message}`);
  } finally {
    cache.refreshing = false;
  }
}

// Initial fetch + schedule
doRefresh();
setInterval(doRefresh, REFRESH_INTERVAL_MS);

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── API: GET /api/data ──
  if (url.pathname === '/api/data' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    if (cache.refreshing && !cache.data) {
      res.writeHead(202);
      return res.end(JSON.stringify({ status: 'refreshing', message: 'First data fetch in progress — try again in a moment.' }));
    }
    if (!cache.data) {
      res.writeHead(503);
      return res.end(JSON.stringify({ status: 'error', error: cache.error || 'No data yet' }));
    }
    res.writeHead(200);
    return res.end(JSON.stringify(cache.data));
  }

  // ── API: POST /api/refresh ──
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    if (cache.refreshing) {
      res.writeHead(202);
      return res.end(JSON.stringify({ status: 'already_refreshing' }));
    }
    doRefresh(); // fire and forget
    res.writeHead(202);
    return res.end(JSON.stringify({ status: 'refresh_started' }));
  }

  // ── API: GET /api/status ──
  if (url.pathname === '/api/status' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    const nextMs = cache.lastRefresh
      ? Math.max(0, REFRESH_INTERVAL_MS - (Date.now() - cache.lastRefresh.getTime()))
      : null;
    res.writeHead(200);
    return res.end(JSON.stringify({
      refreshing:    cache.refreshing,
      lastRefresh:   cache.lastRefresh?.toISOString() || null,
      nextRefreshMs: nextMs,
      userCount:     cache.data?.users?.length || 0,
      error:         cache.error || null,
    }));
  }

  // ── API: GET /api/evidence ──
  if (url.pathname === '/api/evidence' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    if (!cache.data) {
      res.writeHead(503);
      return res.end(JSON.stringify({ status: 'error', error: cache.error || 'No data yet' }));
    }
    const evidenceMap = {};
    for (const user of cache.data.users) {
      evidenceMap[user.email] = user.evidence || {};
    }
    res.writeHead(200);
    return res.end(JSON.stringify(evidenceMap));
  }

  // ── API: GET /api/evidence/:email ──
  const evidenceEmailMatch = url.pathname.match(/^\/api\/evidence\/(.+)$/);
  if (evidenceEmailMatch && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    if (!cache.data) {
      res.writeHead(503);
      return res.end(JSON.stringify({ status: 'error', error: cache.error || 'No data yet' }));
    }
    const email = decodeURIComponent(evidenceEmailMatch[1]).toLowerCase();
    const user  = cache.data.users.find(u => u.email === email);
    if (!user) {
      res.writeHead(404);
      return res.end(JSON.stringify({ status: 'error', error: 'User not found' }));
    }
    res.writeHead(200);
    return res.end(JSON.stringify(user.evidence || {}));
  }

  // ── API: POST /api/manual-override ──
  if (url.pathname === '/api/manual-override' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { email, milestone_id, value } = JSON.parse(body);
        if (!email || !milestone_id || typeof value !== 'boolean') {
          res.writeHead(400);
          return res.end(JSON.stringify({ status: 'error', error: 'Required: email, milestone_id (string), value (boolean)' }));
        }
        const e = email.toLowerCase();
        if (!manualOverrides[e]) manualOverrides[e] = {};
        manualOverrides[e][milestone_id] = value;

        // ── Persist to overrides.json so state survives server restarts ──
        const overridesPath = path.join(__dirname, 'overrides.json');
        try {
          let stored = {};
          if (fs.existsSync(overridesPath)) {
            const raw = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
            delete raw._comment;
            stored = raw;
          }
          if (!stored[e]) stored[e] = {};
          stored[e][milestone_id] = value;
          fs.writeFileSync(overridesPath, JSON.stringify(stored, null, 2));
        } catch (writeErr) {
          console.warn(`Could not write overrides.json: ${writeErr.message}`);
        }

        // Apply immediately to in-memory cache data if it exists
        if (cache.data) {
          const user = cache.data.users.find(u => u.email === e);
          if (user) {
            user.milestones[milestone_id] = value;
            if (user.evidence) {
              user.evidence[milestone_id] = { type: 'manual', checked_at: new Date().toISOString(), source: 'overrides.json' };
            }
          }
        }

        res.writeHead(200);
        return res.end(JSON.stringify({ status: 'ok', email: e, milestone_id, value, persisted: true }));
      } catch (err) {
        res.writeHead(400);
        return res.end(JSON.stringify({ status: 'error', error: 'Invalid JSON: ' + err.message }));
      }
    });
    return;
  }

  // ── Static file serving ──
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

  // Block data.js — browser should use /api/data instead when running locally
  if (filePath === '/data.js') {
    res.writeHead(404);
    return res.end('Not found — use /api/data');
  }

  filePath = path.join(__dirname, filePath);
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n🐶 Datadog Adoption Scorecard`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Org: ${DD_ORG_NAME} | Site: ${DD_SITE}`);
  console.log(`   Auto-refresh every ${Math.round(REFRESH_INTERVAL_MS / 60000)} min`);
  console.log(`   Users: ${DD_USER_EMAILS.length ? DD_USER_EMAILS.join(', ') : (DD_USER_DOMAIN ? '@' + DD_USER_DOMAIN : 'all active')}`);
  console.log(`\n   Fetching initial data… (this takes ~${(DD_USER_EMAILS.length || 5) * 2}s)\n`);
});
