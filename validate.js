#!/usr/bin/env node
/**
 * validate.js — Datadog Adoption Scorecard evidence reporter
 *
 * Re-runs every milestone check, collects full evidence (counts, timestamps,
 * event names, actual metric values), prints a formatted report, and writes
 * evidence.json.
 *
 * Usage: node validate.js
 *
 * Required env vars (same .env as refresh.js):
 *   DD_API_KEY, DD_APP_KEY, DD_SITE, DD_ORG_NAME, DD_USER_EMAILS / DD_USER_DOMAIN
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ─── Load .env ────────────────────────────────────────────────────────────────
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
} else {
  try { require('dotenv').config(); } catch (_) {}
}

const DD_API_KEY     = process.env.DD_API_KEY;
const DD_APP_KEY     = process.env.DD_APP_KEY;
const DD_SITE        = process.env.DD_SITE || 'datadoghq.com';
const DD_ORG_NAME    = process.env.DD_ORG_NAME || 'My Org';
const DD_USER_DOMAIN = process.env.DD_USER_DOMAIN || '';
const DD_USER_EMAILS = (process.env.DD_USER_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

if (!DD_API_KEY || !DD_APP_KEY) {
  console.error('ERROR: DD_API_KEY and DD_APP_KEY must be set.');
  process.exit(1);
}

// ─── Milestone definitions (mirrors refresh.js) ───────────────────────────────
const MILESTONES = {
  core: [
    { id: 'dashboard_created',  name: 'Dashboard Created',    icon: '📊', points: 150, type: 'audit',  audit_query: '@action:created @evt.name:dashboard' },
    { id: 'monitor_created',    name: 'Alert Configured',     icon: '🔔', points: 150, type: 'audit',  audit_query: '@action:created @evt.name:monitor' },
    { id: 'slo_created',        name: 'SLO Created',          icon: '🎯', points: 200, type: 'audit',  audit_query: '@action:created @evt.name:slo' },
    { id: 'synthetics_created', name: 'Synthetic Test',       icon: '🔬', points: 200, type: 'audit',  audit_query: '@action:created @evt.name:synthetics_test' },
    { id: 'notebook_created',   name: 'Notebook Authored',    icon: '📓', points: 100, type: 'audit',  audit_query: '@action:created @evt.name:notebook' },
  ],
  org: [
    { id: 'agent_deployed',  name: 'Agent Deployed', icon: '🖥️',  points: 100, type: 'metric', metric: 'datadog.estimated_usage.hosts' },
    { id: 'logs_active',     name: 'Log Management', icon: '📋',  points: 150, type: 'metric', metric: 'datadog.estimated_usage.logs.ingested_events' },
    { id: 'apm_active',      name: 'APM Active',     icon: '🔭',  points: 200, type: 'metric', metric: 'datadog.estimated_usage.apm_hosts' },
    { id: 'rum_active',      name: 'RUM Enabled',    icon: '🌐',  points: 200, type: 'metric', metric: 'datadog.estimated_usage.rum.sessions' },
  ],
  manual: [
    { id: 'training_part1', name: 'Training Part 1',       icon: '📚', points: 100, type: 'manual' },
    { id: 'training_part2', name: 'Training Part 2',       icon: '📚', points: 100, type: 'manual' },
    { id: 'tags_applied',   name: 'Tags Applied',          icon: '🏷️', points: 100, type: 'manual' },
    { id: 'team_training',  name: 'Team Training Done',    icon: '👥', points: 150, type: 'manual' },
    { id: 'presentation',   name: 'Doghouse Presentation', icon: '🐾', points: 200, type: 'manual' },
  ],
  special: [
    { id: 'dbm_active',       name: 'DBM Enabled',     icon: '🗄️',  points: 300, type: 'metric', metric: 'datadog.estimated_usage.dbm.hosts' },
    { id: 'asm_enabled',      name: 'App Security',    icon: '🛡️',  points: 300, type: 'metric', metric: 'datadog.estimated_usage.asm.hosts' },
    { id: 'profiling_active', name: 'Profiler Active', icon: '🔍',  points: 300, type: 'metric', metric: 'datadog.estimated_usage.profiling.hosts' },
  ],
};

const CERT_TIERS = [
  { id: 'bronze',   name: 'Bronze',   icon: '🥉', gc_bonus: 200,
    required: ['agent_deployed','dashboard_created','monitor_created','training_part1'] },
  { id: 'silver',   name: 'Silver',   icon: '🥈', gc_bonus: 300,
    required: ['agent_deployed','dashboard_created','monitor_created','training_part1','logs_active','apm_active','tags_applied'] },
  { id: 'gold',     name: 'Gold',     icon: '🥇', gc_bonus: 400,
    required: ['agent_deployed','dashboard_created','monitor_created','training_part1','logs_active','apm_active','tags_applied','rum_active','synthetics_created','slo_created','training_part2'] },
  { id: 'platinum', name: 'Platinum', icon: '💎', gc_bonus: 500,
    required: ['agent_deployed','dashboard_created','monitor_created','training_part1','logs_active','apm_active','tags_applied','rum_active','synthetics_created','slo_created','training_part2','presentation'],
    special_count: 2 },
];

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function apiRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function ddHeaders() {
  return { 'DD-API-KEY': DD_API_KEY, 'DD-APPLICATION-KEY': DD_APP_KEY, 'Content-Type': 'application/json' };
}
function ddGet(p) {
  return apiRequest({ hostname: `api.${DD_SITE}`, path: p, method: 'GET', headers: ddHeaders() });
}
function ddPost(p, body) {
  const s = JSON.stringify(body);
  return apiRequest({ hostname: `api.${DD_SITE}`, path: p, method: 'POST',
    headers: { ...ddHeaders(), 'Content-Length': Buffer.byteLength(s) } }, body);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Verify URL builders ──────────────────────────────────────────────────────
function auditVerifyUrl(query, nowMs, oneYearAgoMs) {
  return `https://app.${DD_SITE}/audit-trail?query=${encodeURIComponent(query)}&from_ts=${oneYearAgoMs}&to_ts=${nowMs}&live=false`;
}

function metricVerifyUrl(metricName) {
  return `https://app.${DD_SITE}/metric/summary?filter=${metricName}`;
}

// ─── Fetch users ──────────────────────────────────────────────────────────────
async function fetchUsers() {
  if (DD_USER_EMAILS.length > 0) {
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
    return DD_USER_EMAILS.map(email => ({
      id: email, email,
      name: nameMap[email] || email.split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '),
      title: '',
    }));
  }

  let allData = [], pageNumber = 0;
  while (true) {
    const res = await ddGet(`/api/v2/users?page[size]=100&page[number]=${pageNumber}`);
    if (res.status !== 200) break;
    const page = res.body.data || [];
    allData = allData.concat(page);
    const total = res.body.meta?.page?.total_filtered_count || 0;
    if (allData.length >= total || page.length === 0) break;
    if (!DD_USER_DOMAIN && pageNumber >= 9) break;
    pageNumber++;
    await sleep(200);
  }
  let users = allData
    .filter(u => u.type === 'users')
    .filter(u => (u.attributes?.status || '').toLowerCase() === 'active' && !u.attributes?.service_account)
    .map(u => ({ id: u.id, name: u.attributes?.name || u.attributes?.email || u.id, email: (u.attributes?.email || '').toLowerCase(), title: u.attributes?.title || '' }))
    .filter(u => u.email);
  if (DD_USER_DOMAIN) users = users.filter(u => u.email.endsWith('@' + DD_USER_DOMAIN));
  return users;
}

// ─── Audit evidence check ─────────────────────────────────────────────────────
async function checkAuditEvidence(userEmail, auditQuery, nowMs, oneYearAgoMs) {
  const query = `${auditQuery} @usr.email:${userEmail}`;
  const verifyUrl = auditVerifyUrl(query, nowMs, oneYearAgoMs);
  try {
    const res = await ddPost('/api/v2/audit/events/search', {
      filter: { query, from: 'now-1y', to: 'now' },
      page: { limit: 25 },
    });
    if (res.status !== 200) {
      return { passed: false, count: 0, last_event_at: null, last_event_name: null,
               last_events: [], error: `API ${res.status}`, verifyUrl, query };
    }
    const items = res.body.data || [];
    const count = items.length;
    const passed = count > 0;

    // Extract last 3 event details
    const last_events = items.slice(0, 3).map(item => {
      const attrs = item.attributes || {};
      const name = attrs['@resource_name'] || attrs.resource_name ||
                   attrs['evt.name'] || attrs.resource?.name || attrs.evt?.name || null;
      return {
        timestamp: attrs.timestamp || null,
        name: name || null,
      };
    });

    return {
      passed,
      count,
      last_event_at:   last_events[0]?.timestamp || null,
      last_event_name: last_events[0]?.name || null,
      last_events,
      verifyUrl,
      query,
    };
  } catch (err) {
    return { passed: false, count: 0, last_event_at: null, last_event_name: null,
             last_events: [], error: err.message, verifyUrl, query };
  }
}

// ─── Metric evidence check ────────────────────────────────────────────────────
async function checkMetricEvidence(metricName) {
  const now  = Math.floor(Date.now() / 1000);
  const from = now - 3600;
  const metricQuery = `max:${metricName}{*}`;
  const verifyUrl = metricVerifyUrl(metricName);
  try {
    const res = await ddGet(`/api/v1/query?query=${encodeURIComponent(metricQuery)}&from=${from}&to=${now}`);
    if (res.status !== 200) {
      return { passed: false, value: null, error: `API ${res.status}`, verifyUrl, metricQuery };
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
    return { passed: maxVal !== null && maxVal > 0, value: maxVal, verifyUrl, metricQuery };
  } catch (err) {
    return { passed: false, value: null, error: err.message, verifyUrl, metricQuery };
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
function pad(str, width) {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function fmtNumber(n) {
  if (n === null || n === undefined) return 'null';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtTimestamp(ts) {
  if (!ts) return 'null';
  try { return new Date(ts).toISOString(); } catch (_) { return String(ts); }
}

function shortDate(iso) {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
  } catch (_) { return iso; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const oneYearAgoMs = nowMs - 365 * 24 * 60 * 60 * 1000;

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' DATADOG ADOPTION SCORECARD — VALIDATION REPORT');
  console.log(` Org: ${DD_ORG_NAME} | Generated: ${nowIso}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // 1. Fetch users
  process.stdout.write('Fetching users… ');
  const users = await fetchUsers();
  console.log(`${users.length} found.\n`);
  if (users.length === 0) { console.error('No users found — check credentials.'); process.exit(1); }

  // 2. Read overrides
  const overrides = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'overrides.json'), 'utf8'));
      delete raw._comment; return raw;
    } catch (_) { return {}; }
  })();

  // ─── ORG-LEVEL METRICS ──────────────────────────────────────────────────────
  console.log('─── ORG-LEVEL METRICS ───────────────────────────────\n');

  const orgEvidence = {};
  const checkedAt = now.toISOString();

  for (const ms of [...MILESTONES.org, ...MILESTONES.special]) {
    process.stdout.write(`  ${ms.icon}  ${ms.name}… `);
    const ev = await checkMetricEvidence(ms.metric);
    orgEvidence[ms.id] = {
      type:       'metric',
      metric:     ms.metric,
      value:      ev.value,
      passed:     ev.passed,
      checked_at: checkedAt,
      verify_url: ev.verifyUrl,
      ...(ev.error ? { error: ev.error } : {}),
    };
    console.log(ev.passed ? '✅ PASS' : '❌ FAIL');
    console.log(`      Metric : ${ev.metricQuery}`);
    console.log(`      Value  : ${ev.value !== null ? fmtNumber(ev.value) : '(no data)'}`);
    console.log(`      Verify : ${ev.verifyUrl}\n`);
    await sleep(200);
  }

  // ─── PER-USER AUDIT MILESTONES ───────────────────────────────────────────────
  const allUserResults = [];

  for (const user of users) {
    console.log(`─── USER: ${user.name} <${user.email}> ${'─'.repeat(Math.max(0, 44 - user.name.length - user.email.length))}\n`);

    const userEvidence = {};
    const userMilestones = {};

    // Org milestones — copy from orgEvidence
    for (const ms of [...MILESTONES.org, ...MILESTONES.special]) {
      userMilestones[ms.id] = orgEvidence[ms.id].passed;
      userEvidence[ms.id] = orgEvidence[ms.id];
    }

    // Audit milestones
    for (const am of MILESTONES.core) {
      process.stdout.write(`  ${am.icon}  ${am.name}… `);
      const ev = await checkAuditEvidence(user.email, am.audit_query, nowMs, oneYearAgoMs);
      console.log(ev.passed ? '✅ PASS' : '❌ FAIL');

      userEvidence[am.id] = {
        type:            'audit',
        query:           ev.query,
        count:           ev.count,
        last_event_at:   ev.last_event_at,
        last_event_name: ev.last_event_name,
        passed:          ev.passed,
        checked_at:      checkedAt,
        verify_url:      ev.verifyUrl,
        ...(ev.error ? { error: ev.error } : {}),
      };
      userMilestones[am.id] = ev.passed;

      // Print details
      console.log(`      Audit query : ${ev.query}`);
      console.log(`      Events found: ${ev.count} in last 1 year`);
      if (ev.last_events.length > 0) {
        console.log(`      Most recent :`);
        ev.last_events.forEach((e, i) => {
          const ts   = fmtTimestamp(e.timestamp);
          const name = e.name ? `  "${e.name}"` : '';
          console.log(`        [${i + 1}] ${ts}${name}`);
        });
      }
      console.log(`      Verify      : ${ev.verifyUrl}\n`);
      await sleep(300);
    }

    // Manual milestones
    const userOvr = overrides[user.email] || {};
    for (const mm of MILESTONES.manual) {
      const val = userOvr[mm.id] === true;
      userMilestones[mm.id] = val;
      userEvidence[mm.id] = {
        type:       'manual',
        passed:     val,
        checked_at: checkedAt,
        source:     'overrides.json',
      };
    }

    // Calculate cert
    let cert = null, bonus = 0;
    const allMs = [...MILESTONES.core, ...MILESTONES.org, ...MILESTONES.manual, ...MILESTONES.special];
    const milestoneGC = allMs.reduce((s, m) => s + (userMilestones[m.id] ? m.points : 0), 0);
    for (const tier of [...CERT_TIERS].reverse()) {
      const hasAll = tier.required.every(id => userMilestones[id]);
      const specialOk = !tier.special_count || MILESTONES.special.filter(s => userMilestones[s.id]).length >= tier.special_count;
      if (hasAll && specialOk) { cert = tier.id; bonus = tier.gc_bonus; break; }
    }

    allUserResults.push({
      name: user.name, email: user.email, title: user.title,
      milestones: userMilestones, evidence: userEvidence,
      certification: cert, total_gc: milestoneGC + bonus, milestone_gc: milestoneGC, bonus_gc: bonus,
    });
  }

  // ─── SUMMARY TABLE ──────────────────────────────────────────────────────────
  console.log('─── SUMMARY TABLE ───────────────────────────────────\n');

  const nameW  = Math.max(16, ...allUserResults.map(u => u.name.length));
  const certW  = 8;
  const gcW    = 6;

  // Header
  const coreIds = MILESTONES.core.map(m => m.id);
  const colHdr  = ['Dashboard','Alert','SLO','Synth','Note','Agent','Logs','APM','RUM','DBM','ASM','Prof','Tr1','Tr2','Tags','Team','Pres'];

  process.stdout.write('  ' + pad('Name', nameW) + '  ' + pad('Cert', certW) + '  ' + pad('GC', gcW) + '  ');
  colHdr.forEach(h => process.stdout.write(pad(h.slice(0,5), 6)));
  console.log('');
  console.log('  ' + '─'.repeat(nameW + certW + gcW + 6 + colHdr.length * 6));

  const allIds = [
    ...MILESTONES.core.map(m => m.id),
    ...MILESTONES.org.map(m => m.id),
    ...MILESTONES.special.map(m => m.id),
    ...MILESTONES.manual.map(m => m.id),
  ];

  allUserResults.forEach(u => {
    const certTier = CERT_TIERS.find(t => t.id === u.certification);
    const certStr  = certTier ? certTier.icon + ' ' + u.certification : 'none';
    process.stdout.write('  ' + pad(u.name, nameW) + '  ' + pad(certStr, certW) + '  ' + pad(u.total_gc, gcW) + '  ');
    allIds.forEach(id => {
      const ev = u.evidence[id];
      const sym = !ev ? ' ?' : ev.type === 'manual'
        ? (ev.passed ? ' ✓ ' : ' ─ ')
        : (ev.passed ? ' ✅' : ' ❌');
      process.stdout.write(pad(sym, 6));
    });
    console.log('');
  });
  console.log('');

  // ─── Write evidence.json ─────────────────────────────────────────────────────
  const evidenceOutput = {
    meta: { org_name: DD_ORG_NAME, generated_at: checkedAt, dd_site: DD_SITE },
    org_evidence: orgEvidence,
    users: allUserResults.map(u => ({
      name: u.name, email: u.email, title: u.title,
      certification: u.certification, total_gc: u.total_gc,
      milestones: u.milestones,
      evidence:   u.evidence,
    })),
  };

  const outPath = path.join(__dirname, 'evidence.json');
  fs.writeFileSync(outPath, JSON.stringify(evidenceOutput, null, 2), 'utf8');
  console.log(`Saved to: ${outPath}\n`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
