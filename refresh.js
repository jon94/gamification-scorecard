#!/usr/bin/env node
/**
 * refresh.js — Datadog Adoption Scorecard data fetcher
 *
 * Calls Datadog APIs to detect milestone completions, then writes data.js.
 * Usage: node refresh.js
 *
 * Required env vars (in .env or environment):
 *   DD_API_KEY   — Datadog API key
 *   DD_APP_KEY   — Datadog Application key
 *   DD_SITE      — Datadog site (default: datadoghq.com)
 *   DD_ORG_NAME  — Human-readable org name (default: "My Org")
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ─── Load .env ───────────────────────────────────────────────────────────────
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} else {
  try {
    require('dotenv').config();
  } catch (_) {
    // dotenv not installed — that's fine, rely on env vars
  }
}

const DD_API_KEY     = process.env.DD_API_KEY;
const DD_APP_KEY     = process.env.DD_APP_KEY;
const DD_SITE        = process.env.DD_SITE || 'datadoghq.com';
const DD_ORG_NAME    = process.env.DD_ORG_NAME || 'My Org';
// Optional: filter users by email domain (e.g. "hkjc.org.hk") or exact comma-separated emails
const DD_USER_DOMAIN = process.env.DD_USER_DOMAIN || '';
const DD_USER_EMAILS = (process.env.DD_USER_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

if (!DD_API_KEY || !DD_APP_KEY) {
  console.error('ERROR: DD_API_KEY and DD_APP_KEY must be set.');
  console.error('Copy .env.example to .env and fill in your credentials.');
  process.exit(1);
}

// ─── Milestone definitions (aligned to committed Datadog SKUs) ────────────────
const MILESTONES = {
  // Per-user milestones detected via Audit Trail
  core: [
    { id: 'dashboard_created', name: 'Dashboard Created',                 icon: '📊', points: 150, type: 'audit', audit_query: '@action:created @evt.name:Dashboard' },
    { id: 'monitor_created',   name: 'Alert Configured',                  icon: '🔔', points: 150, type: 'audit', audit_query: '@action:created @evt.name:Monitor' },
    { id: 'slo_created',       name: 'SLO Created',                       icon: '🎯', points: 200, type: 'audit', audit_query: '@action:created @evt.name:SLO' },
    { id: 'notebook_created',  name: 'Notebook Authored',                 icon: '📓', points: 100, type: 'audit', audit_query: '@action:created @evt.name:Notebook' },
    { id: 'case_created',      name: 'Case Created',                      icon: '📋', points: 100, type: 'audit', audit_query: '@action:created @evt.name:Case Management' },
    { id: 'user_invited',      name: 'Team Member Invited',               icon: '👥', points: 100, type: 'audit', audit_query: '@action:created @evt.name:Access Management @asset.type:user' },
    { id: 'bits_ai_sre',       name: 'Trigger Bits AI SRE Investigation', icon: '🤖', points: 200, type: 'audit', audit_query: '@action:created @evt.name:Bits AI SRE' },
  ],
  // Org-wide product activation (shown in status bar, not scored individually)
  org: [
    { id: 'infra_hosts',      name: 'Infra Hosts',         icon: '🖥️',  type: 'metric', metric: 'datadog.estimated_usage.hosts' },
    { id: 'containers',       name: 'Containers',          icon: '📦',  type: 'metric', metric: 'datadog.estimated_usage.containers' },
    { id: 'apm_active',       name: 'APM',                 icon: '🔭',  type: 'metric', metric: 'datadog.estimated_usage.apm_hosts' },
    { id: 'ingested_spans',   name: 'APM Ingested Spans',  icon: '🕸️',  type: 'metric', metric: 'datadog.estimated_usage.apm.ingested_spans' },
    { id: 'logs_active',      name: 'Log Management',      icon: '📋',  type: 'metric', metric: 'datadog.estimated_usage.logs.ingested_events' },
    { id: 'rum_active',       name: 'RUM',                 icon: '🌐',  type: 'metric', metric: 'datadog.estimated_usage.rum.sessions' },
    { id: 'custom_metrics',   name: 'Custom Metrics',      icon: '📐',  type: 'metric', metric: 'datadog.estimated_usage.metrics.custom' },
    { id: 'serverless',       name: 'Serverless',          icon: '☁️',  type: 'metric', metric: 'datadog.estimated_usage.fargate_tasks' },
  ],
  // HKJC onsite enablement — Day 1
  day1: [
    { id: 'session_1', name: 'Observability Overview & Platform Fundamentals', icon: '🎓', points: 100, type: 'manual' },
    { id: 'session_2', name: 'APM Fundamentals & Application Troubleshooting', icon: '🔭', points: 100, type: 'manual' },
    { id: 'session_3', name: 'RUM & End-to-End User Journey Visibility',       icon: '🌐', points: 100, type: 'manual' },
  ],
  // HKJC onsite enablement — Day 2
  day2: [
    { id: 'session_4', name: 'Bits AI for Incident Investigation & Postmortem', icon: '🤖', points: 100, type: 'manual' },
    { id: 'session_5', name: 'Monitor & Alerting Best Practices',               icon: '🔔', points: 100, type: 'manual' },
    { id: 'session_6', name: 'Dashboarding for Operational Visibility',         icon: '📊', points: 100, type: 'manual' },
  ],
  // Self-paced learning
  self_learning: [
    { id: 'learning_path', name: 'Persona Based Learning Path', icon: '🎯', points: 150, type: 'manual' },
  ],
  // Special achievements — advanced committed-product adoption
  special: [
    { id: 'dbm_active',       name: 'DBM Enabled',        icon: '🗄️',  points: 300, type: 'metric', metric: 'datadog.estimated_usage.dbm.hosts' },
    { id: 'profiling_active', name: 'Continuous Profiler', icon: '🔍',  points: 300, type: 'metric', metric: 'datadog.estimated_usage.profiling.hosts' },
    { id: 'network_active',   name: 'Network Monitoring',  icon: '🕸️',  points: 300, type: 'metric', metric: 'datadog.estimated_usage.network.hosts' },
  ],
  // Advanced certifications — manual
  advance: [
    { id: 'cert_fundamentals', name: 'Datadog Fundamentals',   icon: '📜', points: 500, type: 'manual' },
    { id: 'cert_apm',          name: 'Datadog APM Cert',       icon: '🏆', points: 500, type: 'manual' },
    { id: 'cert_logs',         name: 'Datadog Log Management', icon: '🪵', points: 500, type: 'manual' },
  ],
};

// Certification based on individual actions only (org milestones excluded)
const CERTIFICATION_TIERS = [
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

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function apiRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function ddHeaders() {
  return {
    'DD-API-KEY':         DD_API_KEY,
    'DD-APPLICATION-KEY': DD_APP_KEY,
    'Content-Type':       'application/json',
  };
}

function ddGet(path) {
  return apiRequest({
    hostname: `api.${DD_SITE}`,
    path,
    method: 'GET',
    headers: ddHeaders(),
  });
}

function ddPost(path, body) {
  const bodyStr = JSON.stringify(body);
  return apiRequest({
    hostname: `api.${DD_SITE}`,
    path,
    method: 'POST',
    headers: { ...ddHeaders(), 'Content-Length': Buffer.byteLength(bodyStr) },
  }, body);
}

// ─── Fetch all active users ───────────────────────────────────────────────────
async function fetchUsers() {
  console.log('Fetching org users…');
  let allData = [];

  if (DD_USER_EMAILS.length > 0) {
    // Build user objects directly from emails; enrich names from first 1000 users (best-effort)
    const nameMap = {};
    for (let p = 0; p < 10; p++) {
      const res = await ddGet(`/api/v2/users?page[size]=100&page[number]=${p}`);
      if (res.status !== 200) break;
      const page = res.body.data || [];
      for (const u of page) {
        const email = (u.attributes?.email || '').toLowerCase();
        if (DD_USER_EMAILS.includes(email)) nameMap[email] = u.attributes?.name || email;
      }
      if (DD_USER_EMAILS.every(e => nameMap[e])) break;
      if (page.length < 100) break;
      await sleep(150);
    }
    const users = DD_USER_EMAILS.map(email => ({
      id:    email,
      email: email.toLowerCase(),
      name:  nameMap[email] || email.split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '),
      title: '',
    }));
    console.log(`  Found ${users.length} active users.`);
    return users;
  } else {
    // Paginate (capped at 10 pages unless domain filter applied)
    let pageNumber = 0;
    while (true) {
      const res = await ddGet(`/api/v2/users?page[size]=100&page[number]=${pageNumber}`);
      if (res.status !== 200) {
        console.warn(`  WARNING: Users API returned ${res.status}. Check your API key.`);
        break;
      }
      const page = res.body.data || [];
      allData = allData.concat(page);
      const total = res.body.meta?.page?.total_filtered_count || 0;
      if (allData.length >= total || page.length === 0) break;
      if (!DD_USER_DOMAIN && pageNumber >= 9) {
        console.log(`  (capped at ${allData.length} — set DD_USER_DOMAIN or DD_USER_EMAILS in .env)`);
        break;
      }
      pageNumber++;
      await sleep(200);
    }
  }

  let users = allData
    .filter(u => u.type === 'users')
    .filter(u => (u.attributes?.status || '').toLowerCase() === 'active' && !u.attributes?.service_account)
    .map(u => ({
      id:    u.id,
      name:  u.attributes?.name || u.attributes?.email || u.id,
      email: (u.attributes?.email || '').toLowerCase(),
      title: u.attributes?.title || '',
    }))
    .filter(u => u.email);

  if (DD_USER_DOMAIN) {
    users = users.filter(u => u.email.endsWith('@' + DD_USER_DOMAIN));
    console.log(`  Filtered to ${users.length} user(s) with domain @${DD_USER_DOMAIN}.`);
  }

  console.log(`  Found ${users.length} active users.`);
  return users;
}

// ─── Check per-user audit milestone ──────────────────────────────────────────
// Returns { passed, count, last_event_at, last_event_name }
async function checkAuditMilestone(userEmail, auditQuery) {
  const query = `${auditQuery} @usr.email:${userEmail}`;
  try {
    const res = await ddPost('/api/v2/audit/events/search', {
      filter: { query, from: 'now-1y', to: 'now' },
      page: { limit: 5 },
    });
    if (res.status !== 200) {
      console.warn(`    WARN audit search (${res.status}): ${JSON.stringify(res.body).slice(0, 120)}`);
      return { passed: false, count: 0, last_event_at: null, last_event_name: null };
    }
    const items = res.body.data || [];
    const count = items.length;
    const passed = count > 0;
    const first = items[0];
    const firstAttrs = first ? (first.attributes || {}) : {};
    const last_event_at = firstAttrs.timestamp || null;
    const last_event_name = firstAttrs['@resource_name'] || firstAttrs.resource_name ||
                            firstAttrs['evt.name'] || firstAttrs.resource?.name || firstAttrs.evt?.name || null;
    return { passed, count, last_event_at, last_event_name };
  } catch (err) {
    console.warn(`    WARN audit exception: ${err.message}`);
    return { passed: false, count: 0, last_event_at: null, last_event_name: null };
  }
}

// ─── Check org-level metric ───────────────────────────────────────────────────
// Returns { passed, value } where value is the numeric max (or null if no data)
async function checkOrgMetric(metricName) {
  const now   = Math.floor(Date.now() / 1000);
  const from  = now - 3600; // last hour
  const query = `max:${metricName}{*}`;
  try {
    const res = await ddGet(`/api/v1/query?query=${encodeURIComponent(query)}&from=${from}&to=${now}`);
    if (res.status !== 200) {
      console.warn(`    WARN metric query (${res.status}): ${metricName}`);
      return { passed: false, value: null };
    }
    const series = res.body.series || [];
    let maxVal = null;
    for (const s of series) {
      for (const pt of (s.pointlist || [])) {
        if (pt[1] !== null) {
          if (maxVal === null || pt[1] > maxVal) maxVal = pt[1];
        }
      }
    }
    return { passed: maxVal !== null && maxVal > 0, value: maxVal };
  } catch (err) {
    console.warn(`    WARN metric exception (${metricName}): ${err.message}`);
    return { passed: false, value: null };
  }
}

// ─── Read overrides.json ──────────────────────────────────────────────────────
function readOverrides() {
  const overridesPath = path.join(__dirname, 'overrides.json');
  if (!fs.existsSync(overridesPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    // Remove comment key
    delete raw._comment;
    return raw;
  } catch (err) {
    console.warn(`WARN: Could not parse overrides.json: ${err.message}`);
    return {};
  }
}

// ─── Certification calculation ────────────────────────────────────────────────
function calculateCertification(userMilestones) {
  // Org milestones excluded — individual scoring only
  const allMs = [...MILESTONES.core, ...MILESTONES.day1, ...MILESTONES.day2, ...MILESTONES.self_learning, ...MILESTONES.advance, ...MILESTONES.special];

  let milestoneGC = 0;
  allMs.forEach(ms => {
    if (userMilestones[ms.id]) milestoneGC += ms.points;
  });

  let cert  = null;
  let bonus = 0;
  const tiers = [...CERTIFICATION_TIERS].reverse(); // highest first

  for (const tier of tiers) {
    const hasAll = tier.required.every(id => userMilestones[id]);
    let specialOk = true;
    if (tier.special_count) {
      const specialDone = MILESTONES.special.filter(s => userMilestones[s.id]).length;
      specialOk = specialDone >= tier.special_count;
    }
    if (hasAll && specialOk) {
      cert  = tier.id;
      bonus = tier.gc_bonus;
      break;
    }
  }

  return { certification: cert, milestone_gc: milestoneGC, bonus_gc: bonus, total_gc: milestoneGC + bonus };
}

// ─── Rate-limit helper ────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🐶 Datadog Adoption Scorecard — refresh.js`);
  console.log(`   Site: ${DD_SITE}`);
  console.log(`   Org:  ${DD_ORG_NAME}\n`);

  const overrides = readOverrides();
  console.log(`Loaded overrides for ${Object.keys(overrides).length} user(s).\n`);

  // 1. Fetch users
  let users = await fetchUsers();

  if (users.length === 0) {
    console.warn('No users found — check your API credentials and org access.');
    process.exit(1);
  }

  // 2. Check org-level metrics + metric-based specials (once, shared across all users)
  console.log('Checking org-level metrics…');
  const orgResults  = {};
  const orgEvidence = {};
  const checkedAt = new Date().toISOString();

  const metricMilestones = [
    ...MILESTONES.org,
    ...MILESTONES.special.filter(s => s.type === 'metric'),
  ];
  for (const ms of metricMilestones) {
    process.stdout.write(`  ${ms.icon}  ${ms.name}… `);
    const { passed, value } = await checkOrgMetric(ms.metric);
    orgResults[ms.id] = passed;
    orgEvidence[ms.id] = {
      type:       'metric',
      metric:     ms.metric,
      value,
      passed,
      checked_at: checkedAt,
      verify_url: `https://app.${DD_SITE}/metric/summary?filter=${ms.metric}`,
    };
    console.log(passed ? '✅' : '❌');
    await sleep(200);
  }
  console.log('');

  // 3. BATCH audit check — 1 query per milestone for all users (was N_users × N_milestones)
  const nowMs = Date.now();
  const oneYearAgoMs = nowMs - 365 * 24 * 60 * 60 * 1000;
  const auditMilestones = [
    ...MILESTONES.core,
    ...MILESTONES.special.filter(s => s.type === 'audit'),
  ];
  const userEmailSet  = new Set(users.map(u => u.email.toLowerCase()));
  const milestoneHits = {}; // milestone_id -> Set of emails that passed

  console.log(`Checking ${auditMilestones.length} audit milestones across ${users.length} users (batched)…`);
  for (const am of auditMilestones) {
    milestoneHits[am.id] = new Set();
    process.stdout.write(`  ${am.icon} ${am.name}… `);
    try {
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
    } catch (_) { /* leaves empty set */ }
    console.log(`${milestoneHits[am.id].size}/${users.length} ✅`);
    await sleep(200);
  }

  // 4. Build per-user results from batch data
  const userResults = [];
  for (const user of users) {
    const ms  = {};
    const ev  = {};
    const email = user.email.toLowerCase();

    for (const om of [...MILESTONES.org, ...MILESTONES.special.filter(s => s.type === 'metric')]) {
      ms[om.id] = orgResults[om.id];
      ev[om.id] = orgEvidence[om.id];
    }

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

    const userOverrides = overrides[user.email] || {};
    for (const mm of [...MILESTONES.day1, ...MILESTONES.day2, ...MILESTONES.self_learning, ...MILESTONES.advance]) {
      ms[mm.id] = userOverrides[mm.id] === true;
      ev[mm.id] = { type: 'manual', checked_at: checkedAt, source: 'overrides.json' };
    }

    const calc = calculateCertification(ms);
    userResults.push({
      id: user.id, name: user.name, email: user.email, title: user.title,
      milestones: ms, evidence: ev,
      certification: calc.certification, total_gc: calc.total_gc,
      milestone_gc: calc.milestone_gc, bonus_gc: calc.bonus_gc,
    });
  }

  // 4. Sort by total GC
  userResults.sort((a, b) => b.total_gc - a.total_gc);

  // 5. Build data object
  const now = new Date().toISOString();
  const output = {
    meta: {
      org_name:    DD_ORG_NAME,
      last_updated: now,
      is_sample:   false,
    },
    milestones:          MILESTONES,
    certification_tiers: CERTIFICATION_TIERS,
    users:               userResults,
  };

  // 6. Write data.js
  const outputPath = path.join(__dirname, 'data.js');
  const js = `// Auto-generated by refresh.js — do not edit manually\n// Last updated: ${now}\nwindow.DD_DATA = ${JSON.stringify(output, null, 2)};\n`;
  fs.writeFileSync(outputPath, js, 'utf8');

  console.log(`\n✅ data.js written to ${outputPath}`);
  console.log(`   ${userResults.length} users processed`);
  console.log(`   Top champion: ${userResults[0]?.name} (${userResults[0]?.total_gc} GC)`);
  console.log('\nOpen index.html in your browser to view the scorecard.\n');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
