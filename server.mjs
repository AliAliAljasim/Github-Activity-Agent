// Serves the Activity Monitor and /api/data (live GitHub data via the `gh` CLI).
// Usage: REPOS=owner/a,owner/b node server.mjs   (PORT defaults to 8000)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.dirname(new URL(import.meta.url).pathname);

// Load .env (KEY=value lines); real environment variables win.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const PORT = +process.env.PORT || 8000;
const H = 36e5;
const TTL = 60e3;

const gh = async (endpoint) => {
  const { stdout } = await run('gh', ['api', endpoint], { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
};
const SINCE_DAYS = 45;
const QUERY = `query($o:String!,$n:String!,$since:GitTimestamp!){repository(owner:$o,name:$n){defaultBranchRef{name}
refs(refPrefix:"refs/heads/",first:100){nodes{name target{... on Commit{committedDate history(first:100,since:$since){nodes{oid messageHeadline committedDate author{name user{login}}}}}}}}}}`;

// Every commit on every branch in the window, grouped into "pushes" (same branch + author, <=30 min apart).
// A commit that exists on several branches is attributed to the non-default one, where the work happened.
async function branchPushes(repo) {
  const [o, n] = repo.split('/');
  const since = new Date(Date.now() - SINCE_DAYS * 864e5).toISOString();
  const { stdout } = await run('gh', ['api', 'graphql', '-f', `query=${QUERY}`, '-F', `o=${o}`, '-F', `n=${n}`, '-F', `since=${since}`], { maxBuffer: 64 * 1024 * 1024 });
  const r = JSON.parse(stdout).data.repository;
  const def = r.defaultBranchRef?.name;
  const owner = new Map();
  for (const b of r.refs.nodes) {
    for (const c of b.target?.history?.nodes || []) {
      const cur = owner.get(c.oid);
      if (!cur || (cur.branch === def && b.name !== def)) owner.set(c.oid, { branch: b.name, c });
    }
  }
  const groups = new Map();
  for (const { branch, c } of owner.values()) {
    const author = c.author.user?.login || c.author.name;
    const k = `${branch}\u0000${author}`;
    (groups.get(k) || groups.set(k, []).get(k)).push({ ts: Date.parse(c.committedDate), sha: c.oid.slice(0, 7), msg: c.messageHeadline, branch, author });
  }
  const branches = r.refs.nodes.map((b) => ({ repo, name: b.name, date: Date.parse(b.target?.committedDate) || 0, def: b.name === def }));
  const pushes = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.ts - b.ts);
    let cur = null;
    for (const c of list) {
      if (cur && c.ts - cur.ts <= 30 * 60e3) { cur.commits.push({ sha: c.sha, msg: c.msg }); cur.ts = c.ts; }
      else pushes.push((cur = { type: 'push', repo, author: c.author, ts: c.ts, branch: c.branch, commits: [{ sha: c.sha, msg: c.msg }] }));
    }
  }
  pushes.forEach((p) => p.commits.reverse());
  return { pushes, branches };
}

const safe = (p, fallback) => p.catch(() => fallback);

async function repoList() {
  if (process.env.REPOS) return process.env.REPOS.split(',').map((s) => s.trim()).filter(Boolean);
  const { stdout } = await run('gh', ['repo', 'list', '--limit', '4', '--json', 'nameWithOwner', '--jq', '.[].nameWithOwner']);
  return stdout.split('\n').filter(Boolean);
}

const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

async function loadPR(repo, p, now) {
  const [d, reviews, files, checks] = await Promise.all([
    gh(`repos/${repo}/pulls/${p.number}`),
    safe(gh(`repos/${repo}/pulls/${p.number}/reviews?per_page=50`), []),
    safe(gh(`repos/${repo}/pulls/${p.number}/files?per_page=30`), []),
    safe(gh(`repos/${repo}/commits/${p.head.sha}/check-runs?per_page=50`), { check_runs: [] }),
  ]);
  const ago = (t) => (now - Date.parse(t)) / H;
  const revs = reviews.filter((r) => r.submitted_at && r.user).map((r) => ({
    by: r.user.login,
    s: r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes' : 'comment',
    h: ago(r.submitted_at),
    body: r.body || '',
  }));
  const runs = checks.check_runs || [];
  const ci = runs.some((c) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion)) ? 'fail'
    : runs.some((c) => c.status !== 'completed') ? 'running' : 'pass';
  const state = d.merged_at ? 'merged' : d.state === 'closed' ? 'closed'
    : revs.some((r) => r.s !== 'comment') || d.requested_reviewers?.length ? 'review' : 'open';
  const pr = {
    n: d.number, repo, by: d.user.login, title: d.title, status: state, ci,
    opened: ago(d.created_at), branch: d.head.ref, base: d.base.ref, baseSha: d.base.sha, headSha: d.head.sha, adds: d.additions, dels: d.deletions,
    reviews: revs, fileCount: d.changed_files,
    files: files.map((f) => ({ path: f.filename, a: f.additions, d: f.deletions })),
  };
  if (d.merged_at) pr.merged = ago(d.merged_at);
  else if (d.closed_at) pr.closed = ago(d.closed_at);
  const last = [...revs].sort((a, b) => a.h - b.h).find((x) => x.s !== 'comment');
  pr.rv = last ? last.s : 'pending';
  return pr;
}

// Issues (not PRs) and their comments from the last 60 days, so the assistant can answer questions about them.
async function loadIssues(repo, now) {
  const since = new Date(now - 60 * 864e5).toISOString();
  const [list, comments] = await Promise.all([
    safe(gh(`repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=30`), []),
    safe(gh(`repos/${repo}/issues/comments?since=${since}&per_page=100`), []),
  ]);
  const byIssue = new Map();
  for (const c of comments) {
    const n = +c.issue_url.split('/').pop();
    (byIssue.get(n) || byIssue.set(n, []).get(n)).push({ by: c.user?.login || 'ghost', ts: Date.parse(c.created_at), body: c.body || '' });
  }
  return list.filter((i) => !i.pull_request).map((i) => ({
    repo, n: i.number, title: i.title, by: i.user?.login || 'ghost', state: i.state, opened: Date.parse(i.created_at),
    labels: i.labels.map((l) => l.name), body: i.body || '', comments: (byIssue.get(i.number) || []).sort((a, b) => a.ts - b.ts),
  }));
}

async function build() {
  const now = Date.now();
  const repos = await repoList();
  const prs = [], events = [], branches = [], issues = [], people = {};
  const person = (login) => { if (login && !people[login]) people[login] = { name: login, hue: hue(login) }; };

  await Promise.all(repos.map(async (repo) => {
    const [list, bp, iss] = await Promise.all([
      safe(gh(`repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=25`), []),
      safe(branchPushes(repo), { pushes: [], branches: [] }),
      safe(loadIssues(repo, now), []),
    ]);
    issues.push(...iss);
    const full = await Promise.all(list.map((p) => safe(loadPR(repo, p, now), null)));
    full.filter(Boolean).forEach((pr) => {
      prs.push(pr);
      const b = { repo, pr: pr.n, title: pr.title, branch: pr.branch, adds: pr.adds, dels: pr.dels, files: pr.files, fileCount: pr.fileCount };
      const at = (h) => now - h * H;
      events.push({ ...b, type: 'pr_open', author: pr.by, ts: at(pr.opened) });
      pr.reviews.forEach((v) => events.push({ ...b, type: 'review', author: v.by, ts: at(v.h), review: v.s, body: v.body }));
      if (pr.merged != null) events.push({ ...b, type: 'pr_merge', author: pr.by, ts: at(pr.merged) });
      if (pr.closed != null) events.push({ ...b, type: 'pr_close', author: pr.by, ts: at(pr.closed) });
    });
    events.push(...bp.pushes);
    branches.push(...bp.branches);
  }));

  events.forEach((e) => person(e.author));
  prs.forEach((p) => person(p.by));
  events.sort((a, b) => b.ts - a.ts);
  events.forEach((e, i) => { e.id = 'e' + (events.length - i); });
  prs.sort((a, b) => b.n - a.n);
  return { now, repos, people, prs, events, branches, issues };
}

// ---- caching ---------------------------------------------------------------------------------
// /api/data: served from memory while fresh (TTL), then stale-while-revalidate; persisted to .cache/ so a restart is instant.
// /api/compare: refs that are commit SHAs never change, so those are cached forever (on disk); branch refs for 60s.
// /api/ask: identical prompts are answered from memory for 10 minutes.
const CACHE_DIR = path.join(ROOT, '.cache');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); } catch { return fb; } };
const writeJson = (f, v) => { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, f), JSON.stringify(v)); } catch {} };

const dataCache = readJson('data.json', null) || { at: 0, key: '', value: null }; // { at, key, value }
let building = null;
const reposKey = () => process.env.REPOS || '';
function refreshData() {
  if (!building) {
    building = build().then((value) => {
      dataCache.value = value; dataCache.at = Date.now(); dataCache.key = reposKey();
      writeJson('data.json', dataCache);
      return value;
    }).finally(() => { building = null; });
    building.catch(() => {});
  }
  return building;
}
// Returns { value, at }. `force` waits for fresh data; otherwise stale data is returned at once and refreshed behind the scenes.
async function data(force = false) {
  const usable = dataCache.value && dataCache.value.issues && dataCache.key === reposKey();
  if (!usable) { Object.assign(dataCache, { value: null, at: 0 }); await refreshData(); return dataCache; }
  if (force || Date.now() - dataCache.at > TTL * 10) await refreshData();
  else if (Date.now() - dataCache.at > TTL) refreshData();
  return dataCache;
}

// ---- "Ask" panel: answers questions by running the Claude CLI headlessly (uses your Claude subscription login).
const rel = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`) + ' ago';

// Dashboard context (PRs, issues, recent activity) as prompt sections. Used by the dashboard chat and, scoped to one repo, by the compare chat.
function dashSections(d, { ctx, repos = [], authors = [], max = 250 }) {
  const okR = (r) => !repos.length || repos.includes(r), okA = (a) => !authors.length || authors.includes(a);
  const prs = d.prs.filter((p) => okR(p.repo) && okA(p.by)).map((p) => ({
    ref: `${p.repo}#${p.n}`, title: p.title, by: p.by, status: p.status, ci: p.ci, review: p.rv,
    opened: rel(p.opened), merged: p.merged != null ? rel(p.merged) : undefined, closed: p.closed != null ? rel(p.closed) : undefined,
    branch: p.branch, changes: `+${p.adds} -${p.dels} in ${p.fileCount} files`,
    reviews: p.reviews.map((v) => `${v.by}: ${v.s} ${rel(v.h)}${v.body ? ' - ' + v.body.replace(/\s+/g, ' ').slice(0, 200) : ''}`),
    files: p.files.slice(0, 10).map((f) => f.path),
  }));
  const evs = d.events.filter((e) => okR(e.repo) && okA(e.author) && d.now - e.ts < 30 * 864e5).slice(0, 250).map((e) =>
    `${rel((d.now - e.ts) / 36e5)} | ${e.repo} | ${e.author} | ${e.type}${e.pr ? ' #' + e.pr : ''}${e.branch ? ' @' + e.branch : ''} | ` +
    (e.type === 'push' ? e.commits.map((c) => `${c.sha} ${c.msg}`).join('; ') : e.title || ''));
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const issues = (d.issues || []).filter((i) => okR(i.repo)).map((i) => ({
    ref: `${i.repo}#${i.n}`, title: i.title, by: i.by, state: i.state, opened: day(i.opened), labels: i.labels,
    body: i.body.replace(/\s+/g, ' ').slice(0, 400),
    comments: i.comments.slice(-30).map((c) => `${day(c.ts)} ${c.by}: ${c.body.replace(/\s+/g, ' ').slice(0, 400)}`),
  }));
  let focus = '';
  if (ctx?.kind === 'pr') { const p = d.prs.find((x) => x.n === ctx.id && (!ctx.repo || x.repo === ctx.repo)); if (p) focus = `The user is asking about PR ${p.repo}#${p.n}.`; }
  if (ctx?.kind === 'event') { const e = d.events.find((x) => x.id === ctx.id); if (e) focus = `The user is asking about this event: ${rel((d.now - e.ts) / 36e5)} | ${e.repo} | ${e.author} | ${e.type} ${e.pr ? '#' + e.pr : ''} ${e.branch || ''}`; }
  const sections = [
    `Repos: ${d.repos.join(', ')}`,
    `Pull requests (JSON):\n${JSON.stringify(prs)}`,
    issues.length ? `Issues and their comments from the last 60 days (JSON; comment dates are absolute, today is ${day(d.now)}):\n${JSON.stringify(issues)}` : '',
    `Recent events (last 30 days, newest first):\n${evs.join('\n')}`,
  ].filter(Boolean);
  return { sections, focus };
}

// Page-aware chat: one prompt builder for both pages. `page` says where the user is asking from, so the model
// assumes that's what the question is about, but every section it has is available if the question strays.
const hist = (history) => history.length ? `Conversation so far:\n${history.map((m) => `${m.role}${m.page ? ' [on the ' + m.page + ' page]' : ''}: ${m.text}`).join('\n')}` : '';
const PAGE_NOTE = {
  dashboard: 'The user is on the DASHBOARD page (activity feed, pull requests, pushes, issues). Their question most likely concerns that activity, but they may ask about code or comparisons too: the diffs of commits in scope are included below when available.',
  compare: 'The user is on the COMPARE page, looking at a code comparison. Their question most likely concerns that comparison, but they may also ask about pull requests, issues, reviews or activity: that dashboard data is included below.',
};
function buildPrompt(d, { question, ctx, repos = [], authors = [], history = [], page = 'dashboard', canvas, edit }, diffs = '') {
  const { sections, focus } = dashSections(d, { ctx, repos, authors });
  if (canvas) return [edit ? EDIT_INSTR : 'You are the assistant inside a GitHub Activity Monitor. Use ONLY the data below and the conversation. ' + CANVAS_INSTR, ...sections, diffs, hist(history), `Question: ${question}`].filter(Boolean).join('\n\n');
  return [
    'You are the assistant inside a GitHub Activity Monitor. Answer the question using ONLY the data below (pull requests, issues with comments, push events and commit diffs). Be concise and concrete (a few sentences or a short bullet list).',
    'Format for a narrow chat panel: short paragraphs, **bold** lead-ins for key points, `inline code` for identifiers, and numbered or - bulleted lists (one item per line, no nesting) when listing several things. No headings, tables or code fences.',
    'When you mention a pull request or issue write it as owner/repo#123 so it can be linked. If the data does not contain the answer, say so; if a commit has no diff below, say its diff was not loaded rather than guessing.',
    'When listing findings or changes, give each item a **bold lead-in sentence** followed by one or two sentences of detail. Cite commits by their plain 7-character sha (for example "From 9c6a0ad"), never inside bold. To point at code, cite it as path:LINE or path:START-END using the new-file line numbers (the number before "|" in the patches below); never invent line numbers. Use `inline code` for identifiers, file names and branches.',
    PAGE_NOTE[page] || PAGE_NOTE.dashboard,
    ...sections,
    diffs,
    hist(history),
    focus,
    `Question: ${question}`,
  ].filter(Boolean).join('\n\n');
}

// Diffs for the commits in scope of a dashboard question: ones named in the conversation, the push/PR the user pressed Ask on,
// and the pushes visible in the current view. Capped so the prompt stays a sensible size.
async function scopeDiffs(d, q) {
  const bySha = new Map(), picked = new Map();
  for (const e of d.events) if (e.type === 'push') for (const c of e.commits) bySha.set(c.sha, { repo: e.repo, c, e });
  const add = (repo, c, meta) => { const k = repo + '@' + c.sha; if (picked.size < 24 && !picked.has(k)) picked.set(k, { repo, sha: c.sha, msg: c.msg, ...meta }); };
  const addPush = (e) => e.commits.forEach((c) => add(e.repo, c, { branch: e.branch, author: e.author, ts: e.ts }));
  for (const t of [...(q.history || []).map((h) => h.text), q.question]) for (const m of String(t || '').match(/\b[0-9a-f]{7}\b/g) || []) { const x = bySha.get(m); if (x) addPush({ ...x.e, commits: [x.c] }); }
  if (q.ctx?.kind === 'event') { const e = d.events.find((x) => x.id === q.ctx.id); if (e?.type === 'push') addPush(e); }
  if (q.ctx?.kind === 'pr') {
    const p = d.prs.find((x) => x.n === q.ctx.id && (!q.ctx.repo || x.repo === q.ctx.repo));
    if (p) {
      try {
        const cmp = await compare(new URL('http://x/?' + new URLSearchParams({ repo: p.repo, base: p.baseSha || p.base, head: p.headSha || p.branch })));
        cmp.commits.forEach((c) => add(p.repo, c, { branch: p.branch, author: c.author, ts: c.date }));
      } catch {}
    }
  }
  // A question that names a push by topic ("the telemetry active-agent push") matches branch names and commit messages.
  const STOP = new Set('about after also and any are been before change changed changes commit commits could did does file files for from have how into last latest list main make many more most need push pushes recent review show summarise summarize tell than that the their them then there these they things this those through what when where which while who whose will with work would'.split(' '));
  const words = [...new Set(String(q.question || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))];
  // "14d", "3 days", "2 weeks" in the question is an age hint: pushes about that old rank higher.
  const am = /\b(\d+)\s*(h|hours?|d|days?|w|weeks?)\b/i.exec(String(q.question || ''));
  const target = am ? +am[1] * ({ h: 36e5, d: 864e5, w: 6048e5 }[am[2][0].toLowerCase()]) : 0;
  if (words.length >= 2 && !q.canvas) {
    d.events.filter((e) => e.type === 'push' && (!q.repos?.length || q.repos.includes(e.repo)))
      .map((e) => {
        const hay = (e.branch + ' ' + e.commits.map((c) => c.msg).join(' ')).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
        const n = words.filter((w) => hay.includes(w)).length;
        return { e, n, score: n + (target && Math.abs(d.now - e.ts - target) <= Math.max(target * 0.25, 12 * 36e5) ? 2 : 0) };
      })
      .filter((x) => x.n >= 2).sort((x, y) => y.score - x.score || y.e.ts - x.e.ts).slice(0, 3).forEach((x) => addPush(x.e));
  }
  // the pushes on screen come last: they fill whatever room is left
  for (const v of (q.visible || []).slice(0, 40)) { const x = bySha.get(String(v.sha || '').slice(0, 7)); if (x && x.repo === v.repo) addPush({ ...x.e, commits: [x.c] }); }
  if (!picked.size) return '';
  const byRepo = new Map();
  for (const x of picked.values()) (byRepo.get(x.repo) || byRepo.set(x.repo, []).get(x.repo)).push(x);
  let budget = 45000;
  const out = [];
  for (const [repo, list] of byRepo) {
    const details = await commitDetails(repo, list);
    list.slice(0, 60).forEach((x, k) => {
      const f = details[k];
      const head = `## commit ${x.sha} (${repo}${x.branch ? ' @' + x.branch : ''}${x.author ? ', ' + x.author : ''}) ${x.msg}`;
      if (!f) { out.push(head + '\n(diff not loaded)'); return; }
      const body = f.map((y) => `--- ${y.path}\n${annotate(y.patch || '')}`).join('\n');
      const t = body.length <= budget ? body : body.slice(0, Math.max(0, budget)) + '\n…(truncated)';
      budget -= t.length; out.push(head + '\n' + (t || '(no textual diff)'));
    });
  }
  return `Commit diffs for the commits in scope, patch lines prefixed with their new-file line number (commits not listed here have no diff loaded):\n${out.join('\n\n')}`;
}

const askCache = new Map();
function askClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--tools', '', '--no-session-persistence', '--setting-sources', ''];
    if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
    const c = spawn('claude', args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { c.kill(); reject(new Error('claude timed out')); }, 120e3);
    c.stdout.on('data', (b) => (out += b));
    c.stderr.on('data', (b) => (err += b));
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('close', (code) => { clearTimeout(t); code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(err || `claude exited ${code}`)); });
    c.stdin.end(prompt);
  });
}

// Like askClaude, but calls onDelta(text) as tokens arrive (stream-json partial messages). Resolves with the full text.
function askClaudeStream(prompt, onDelta) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
    if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
    const c = spawn('claude', args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', full = '', err = '';
    const t = setTimeout(() => { c.kill(); reject(new Error('claude timed out')); }, 120e3);
    const line = (l) => {
      let j; try { j = JSON.parse(l); } catch { return; }
      const d = j.type === 'stream_event' && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta' ? j.event.delta.text : '';
      if (d) { full += d; onDelta(d); }
    };
    c.stdout.on('data', (b) => { buf += b; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    c.stderr.on('data', (b) => (err += b));
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('close', (code) => { clearTimeout(t); if (buf) line(buf); code === 0 && full.trim() ? resolve(full.trim()) : reject(new Error(err || `claude exited ${code}`)); });
    c.stdin.end(prompt);
  });
}

const readBody = (req) => new Promise((res, rej) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => res(b)); req.on('error', rej); });

const REF = /^[\w./^~@+-]{1,400}$/;
const SHA_REF = /^[0-9a-f]{7,40}(\+[0-9a-f]{7,40})*\^?$/;
const cmpCache = new Map(Object.entries(readJson('compare.json', {})));
let cmpSaveT = null;
async function compare(url) {
  const key = ['repo', 'base', 'head'].map((k) => url.searchParams.get(k)).join('|');
  const hit = cmpCache.get(key);
  if (hit && (hit.forever || (!url.searchParams.has('fresh') && Date.now() - hit.at < TTL))) return hit.value;
  const value = await compareUncached(url);
  const forever = SHA_REF.test(url.searchParams.get('base') || '') && SHA_REF.test(url.searchParams.get('head') || '');
  cmpCache.set(key, { at: Date.now(), forever, value });
  if (cmpCache.size > 300) cmpCache.delete(cmpCache.keys().next().value);
  clearTimeout(cmpSaveT);
  cmpSaveT = setTimeout(() => writeJson('compare.json', Object.fromEntries([...cmpCache].filter(([, v]) => v.forever))), 2000);
  return value;
}
async function compareUncached(url) {
  let base = url.searchParams.get('base'), head = url.searchParams.get('head');
  const repo = url.searchParams.get('repo');
  if (!(await data()).value.repos.includes(repo) || !REF.test(base || '') || !REF.test(head || '') || base.startsWith('-') || head.startsWith('-')) throw Object.assign(new Error('bad request'), { status: 400 });
  // GitHub's compare endpoint doesn't understand "sha^", so resolve the parent ourselves.
  const parentOf = async (sha) => (await gh(`repos/${repo}/commits/${sha}`)).parents[0]?.sha || sha;
  const cmp = (x, y) => gh(`repos/${repo}/compare/${x}...${y}?per_page=100`);
  // "a+b+c" is a push's commit list; commit dates can disagree with the graph, so pick its first (base) or last (head) commit by parentage.
  const fromSet = async (spec, tip) => {
    const shas = spec.split('+');
    if (shas.length === 1) return shas[0];
    const cs = await Promise.all(shas.map((s) => gh(`repos/${repo}/commits/${s}`)));
    const all = new Set(cs.map((x) => x.sha));
    const parents = new Set(cs.flatMap((x) => x.parents.map((p) => p.sha)));
    const pick = tip ? cs.find((x) => !parents.has(x.sha)) : cs.find((x) => !x.parents.some((p) => all.has(p.sha)));
    return (pick || cs[0]).sha;
  };
  const wasCaret = base.endsWith('^');
  base = (await fromSet(wasCaret ? base.slice(0, -1) : base, false)) + (wasCaret ? '^' : '');
  head = await fromSet(head, true);
  const caret = base.endsWith('^');
  let c = await cmp(caret ? await parentOf(base.slice(0, -1)) : base, head);
  // A push's commits can arrive in either order (commit dates are unreliable), so retry the other way round.
  if (caret && c.total_commits === 0) {
    const swapped = await cmp(await parentOf(head), base.slice(0, -1));
    if (swapped.total_commits > 0) c = swapped;
  }
  return {
    status: c.status, ahead: c.ahead_by, behind: c.behind_by, total: c.total_commits, url: c.html_url,
    commits: c.commits.map((x) => ({ sha: x.sha.slice(0, 7), msg: x.commit.message.split('\n')[0], author: x.author?.login || x.commit.author.name, date: Date.parse(x.commit.author.date) })),
    files: (c.files || []).map((f) => ({ path: f.filename, status: f.status, a: f.additions, d: f.deletions, patch: f.patch || '' })),
  };
}

// ---- "Ask" on the compare page: the model sees the commits and (annotated) patches of the current comparison.
// Patch lines are prefixed with their line number in the new file ("-" for removed lines) so answers can cite path:LINE.
function annotate(patch) {
  let n = 0;
  return patch.split('\n').map((t) => {
    if (t[0] === '@') { const m = /\+(\d+)/.exec(t); n = m ? +m[1] : n; return t; }
    if (t[0] === '-') return '-| ' + t.slice(1);
    if (t[0] === '\\') return t;
    return `${n++}| ${t.slice(1)}`;
  }).join('\n');
}
// Per-commit files + patches (immutable by sha, so cached forever), so the assistant can say which commit/push touched what.
const commitCache = new Map(Object.entries(readJson('commits.json', {})));
let commitSaveT = null;
async function commitDetail(repo, sha) {
  const key = repo + '@' + sha;
  if (commitCache.has(key)) return commitCache.get(key);
  const c = await gh(`repos/${repo}/commits/${sha}`);
  const v = (c.files || []).map((f) => ({ path: f.filename, status: f.status, a: f.additions, d: f.deletions, patch: f.patch || '' }));
  commitCache.set(key, v);
  clearTimeout(commitSaveT);
  commitSaveT = setTimeout(() => writeJson('commits.json', Object.fromEntries(commitCache)), 2000);
  return v;
}
async function commitDetails(repo, commits) {
  const list = commits.slice(0, 60), out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < list.length) { const k = i++; out[k] = await safe(commitDetail(repo, list[k].sha), null); }
  }));
  return out;
}
// Editing a highlighted part of a canvas: the model sees only that excerpt and returns only its replacement.
const EDIT_INSTR = 'You are editing a short excerpt of a Slack canvas (Markdown). Apply the instruction to the highlighted part only and keep every other word of the excerpt exactly as it is, with the same Markdown structure (list markers, **bold** lead-ins, `inline code`) and the same citations (path:LINE, shas) unless the instruction changes them. Use the data below only to check facts. Never write URLs or link markup, and no square-bracket labels. Return ONLY the replacement excerpt: no preamble, no code fences, no explanation. If the instruction is to delete the highlighted part, return the excerpt without it.';
const CANVAS_INSTR = 'You are writing a clean, shareable Slack canvas (Markdown) from the conversation below, NOT a transcript. Structure: "# <short descriptive title>", one italic line of context, "## TL;DR" (2-3 sentences), "## Key findings" (numbered list; each item a **bold title** then 1-2 sentences with path:LINE or sha citations), "## Where it changed" (bullets: commit sha and what it did; omit if the conversation was not about code), "## Risks and follow-ups" (bullets). Merge duplicates, drop chit-chat, questions, and anything not supported by the data below; omit empty sections; keep it under about 400 words. Use `inline code` for identifiers. Write commit shas as plain 7-character text and never write URLs or link markup (no <url|text>, no [text](url)); links are added automatically. Never use square brackets for labels (write "High risk:" not "[High]"). No tables or code fences.';
function buildComparePrompt(c, details, pushes, {canvas, edit, repo, baseLabel, headLabel, question, history = [], selection, file }, extra = []) {
  let budget = 55000;
  const files = c.files.map((f) => {
    const p = annotate(f.patch || '');
    const body = p.length <= budget ? p : p.slice(0, Math.max(0, budget)) + '\n…(truncated)';
    budget -= body.length;
    return `### ${f.path} (${f.status}, +${f.a} -${f.d})\n${body || '(no textual diff)'}`;
  });
  // Which push (same branch+author burst) each commit belongs to.
  const pushOf = new Map();
  for (const p of pushes) for (const x of p.commits) pushOf.set(x.sha, p);
  const rel = (ts) => { const h = (Date.now() - ts) / 36e5; return h < 1 ? 'minutes ago' : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`; };
  const commitLines = c.commits.map((x, k) => {
    const p = pushOf.get(x.sha), d = details[k];
    return `${x.sha} ${x.author}: ${x.msg}` + (p ? ` [push: ${p.branch}, ${p.commits.length} commit${p.commits.length === 1 ? '' : 's'}, ${rel(p.ts)}]` : '') + (d ? ` {${d.map((f) => `${f.path} +${f.a}/-${f.d}`).join(', ')}}` : '');
  });
  let pb = 45000;
  const perCommit = c.commits.map((x, k) => {
    const d = details[k]; if (!d) return '';
    const body = d.map((f) => `--- ${f.path}\n${f.patch}`).join('\n');
    const t = body.length <= pb ? body : body.slice(0, Math.max(0, pb)) + '\n…(truncated)';
    pb -= t.length; return pb < 0 && !t ? '' : `## commit ${x.sha}\n${t}`;
  }).filter(Boolean);
  const focus = selection?.text ? `The user highlighted this code in ${selection.path || 'the diff'}:\n"""\n${String(selection.text).slice(0, 6000)}\n"""` : file ? `The user is asking about the file ${file}.` : '';
  return [
    'You are the assistant inside a GitHub Activity Monitor, looking at a code comparison. Answer using ONLY the data below. Be concise and concrete. ' + (canvas
      ? (edit ? EDIT_INSTR : CANVAS_INSTR)
      : 'Format for a narrow chat panel: short paragraphs, **bold** lead-ins for key points, `inline code` for identifiers, and numbered or - bulleted lists (one item per line, no nesting) when listing several things. No headings, tables or code fences.'),
    'You CAN tell which commit and push touched or introduced a piece of code: use the per-commit patches and the [push] info. Cite commits by their 7-character sha. If a commit patch is truncated or absent, say so rather than guessing.',
    'To point at code, cite it as path:LINE or path:START-END using new-file line numbers (the number before "|"); these become clickable highlights. Never invent line numbers.',
    `Repo: ${repo}\nBase: ${baseLabel}\nCompare: ${headLabel}\nStatus: ${c.status}, ${c.total} commits`,
    `Commits (sha author: message [push] {files touched}):\n${commitLines.join('\n')}`,
    `Files (combined diff, new-file line numbers):\n${files.join('\n\n')}`,
    perCommit.length ? `Per-commit patches (use these to say which commit/push introduced or changed a given piece of code; match by code content, line numbers differ from the combined diff):\n${perCommit.join('\n\n')}` : '',
    ...(canvas ? [] : [PAGE_NOTE.compare, ...extra]),
    hist(history),
    focus,
    `Question: ${question}`,
  ].filter(Boolean).join('\n\n');
}

// ---- saved assistant chats (one JSON file, id -> chat)
const chats = readJson('chats.json', {});
let chatsSaveT = null;
const saveChats = () => { clearTimeout(chatsSaveT); chatsSaveT = setTimeout(() => writeJson('chats.json', chats), 300); };
const CHAT_ID = /^[\w-]{1,48}$/;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/data') {
    try {
      const d = await data(url.searchParams.has('refresh'));
      const body = JSON.stringify({ ...d.value, fetchedAt: d.at });
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    } catch (e) {
      const auth = /auth|login|401|403/i.test(String(e.stderr || e.message));
      res.writeHead(auth ? 401 : 502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.stderr || e.message) }));
    }
    return;
  }
  if (url.pathname === '/api/compare') {
    try {
      const body = JSON.stringify(await compare(url));
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    } catch (e) {
      res.writeHead(e.status || 502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.stderr || e.message).slice(0, 500) }));
    }
    return;
  }
  if (url.pathname === '/api/ask' && req.method === 'POST') {
    try {
      const q = JSON.parse(await readBody(req));
      const d = (await data()).value;
      const prompt = buildPrompt(d, q, await scopeDiffs(d, q));
      const k = crypto.createHash('sha256').update(prompt).digest('hex');
      const hit = askCache.get(k);
      let answer = hit && Date.now() - hit.at < 600e3 ? hit.answer : null;
      if (!answer) { answer = await askClaude(prompt); askCache.set(k, { at: Date.now(), answer }); if (askCache.size > 100) askCache.delete(askCache.keys().next().value); }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answer }));
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.message).slice(0, 500) }));
    }
    return;
  }
  if (url.pathname === '/api/ask-compare' && req.method === 'POST') {
    try {
      const q = JSON.parse(await readBody(req));
      const d = (await data()).value;
      let prompt;
      if (q.repo && q.base && q.head) {
        const cmp = await compare(new URL('http://x/?' + new URLSearchParams({ repo: q.repo, base: q.base, head: q.head })));
        const evs = d.events.filter((e) => e.type === 'push' && e.repo === q.repo);
        const { sections } = dashSections(d, { repos: [q.repo] });
        prompt = buildComparePrompt(cmp, await commitDetails(q.repo, cmp.commits), evs, q, sections);
      } else {
        // On the compare page with nothing selected yet: still answer from the dashboard data.
        prompt = buildPrompt(d, { ...q, page: q.page || 'compare' }, await scopeDiffs(d, q));
      }
      const k = crypto.createHash('sha256').update(prompt).digest('hex');
      const hit = askCache.get(k);
      let answer = hit && Date.now() - hit.at < 600e3 ? hit.answer : null;
      // NDJSON stream: {d:"text"} chunks, then {done:true}; or {error:"..."}.
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      const send = (o) => res.write(JSON.stringify(o) + '\n');
      try {
        if (answer) for (let i = 0; i < answer.length; i += 24) { send({ d: answer.slice(i, i + 24) }); await new Promise((r) => setTimeout(r, 12)); }
        else {
          answer = await askClaudeStream(prompt, (d) => send({ d }));
          askCache.set(k, { at: Date.now(), answer }); if (askCache.size > 100) askCache.delete(askCache.keys().next().value);
        }
        send({ done: true });
      } catch (e) { send({ error: String(e.message).slice(0, 500) }); }
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(e.status || 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message).slice(0, 500) }));
    }
    return;
  }
  if (url.pathname.startsWith('/api/chats')) {
    const id = decodeURIComponent(url.pathname.slice('/api/chats'.length).replace(/^\//, ''));
    const json = (code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    try {
      if (!id && req.method === 'GET') return json(200, Object.values(chats).sort((a, b) => b.updated - a.updated));
      if (!CHAT_ID.test(id)) return json(400, { error: 'bad id' });
      if (req.method === 'PUT') {
        const c = JSON.parse(await readBody(req));
        if (!Array.isArray(c.msgs)) return json(400, { error: 'bad chat' });
        chats[id] = { id, title: String(c.title || 'Untitled').slice(0, 120), repo: c.repo, a: c.a, b: c.b, created: c.created || Date.now(), updated: Date.now(),
          msgs: c.msgs.slice(-200).map((m) => ({ role: m.role === 'user' ? 'user' : 'ai', text: String(m.text || '').slice(0, 30000), ctx: m.ctx ? String(m.ctx).slice(0, 300) : undefined, page: m.page === 'compare' || m.page === 'dashboard' ? m.page : undefined, err: m.err ? 1 : undefined })) };
        saveChats();
        return json(200, chats[id]);
      }
      if (req.method === 'DELETE') { delete chats[id]; saveChats(); return json(200, { ok: true }); }
      return json(405, { error: 'method' });
    } catch (e) { return json(400, { error: String(e.message).slice(0, 300) }); }
  }
  // The shell (shell.html) owns the chat and never reloads; the dashboard and compare pages load inside it as /_dashboard and /_compare.
  const name = { '/': 'shell.html', '/compare': 'shell.html', '/_dashboard': 'index.html', '/_compare': 'compare.html' }[url.pathname] || decodeURIComponent(url.pathname.slice(1));
  const file = path.join(ROOT, name);
  if (!['shell.html', 'index.html', 'compare.html', 'support.js'].includes(name) || !fs.existsSync(file)) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain', 'cache-control': 'no-cache' }).end(fs.readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log(`Activity Monitor: http://localhost:${PORT}`));
