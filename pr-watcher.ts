#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const FAST_MS = 15_000
const NORMAL_MS = 60_000
const IDLE_MS = 5 * 60_000

const log = (...args: unknown[]) => console.error('[pr-watcher]', ...args)

type Pr = {
  number: number
  url: string
  headSha: string
  branch: string
  state: string
  title: string
  reviewDecision: string
  repo: string
}

type CheckState = { state: string; bucket: string; url: string }

type Snapshot = {
  branch: string | null
  pr: Pr | null
  checks: Map<string, CheckState>
  reviewIds: Set<number>
  reviewCommentIds: Set<number>
  issueCommentIds: Set<number>
  noPrAnnouncedForBranch: string | null
}

type ShellResult = { ok: boolean; stdout: string; stderr: string }

async function sh(cmd: string, args: string[]): Promise<ShellResult> {
  const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { ok: code === 0, stdout, stderr }
}

async function getCurrentBranch(): Promise<string | null> {
  const r = await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!r.ok) return null
  const b = r.stdout.trim()
  if (!b || b === 'HEAD') return null
  return b
}

async function getPr(): Promise<Pr | null> {
  const r = await sh('gh', [
    'pr', 'view',
    '--json', 'number,url,headRefOid,headRefName,state,title,reviewDecision,baseRepository',
  ])
  if (!r.ok) return null
  let data: any
  try { data = JSON.parse(r.stdout) } catch { return null }
  const owner = data?.baseRepository?.owner?.login ?? ''
  const name = data?.baseRepository?.name ?? ''
  if (!owner || !name || typeof data.number !== 'number') return null
  return {
    number: data.number,
    url: data.url ?? '',
    headSha: data.headRefOid ?? '',
    branch: data.headRefName ?? '',
    state: data.state ?? '',
    title: data.title ?? '',
    reviewDecision: data.reviewDecision ?? '',
    repo: `${owner}/${name}`,
  }
}

async function getChecks(): Promise<Map<string, CheckState>> {
  const checks = new Map<string, CheckState>()
  const r = await sh('gh', ['pr', 'checks', '--json', 'name,state,bucket,link'])
  if (!r.ok) return checks
  try {
    const arr = JSON.parse(r.stdout) as Array<{ name: string; state: string; bucket: string; link: string }>
    for (const c of arr) {
      checks.set(c.name, { state: c.state ?? '', bucket: c.bucket ?? '', url: c.link ?? '' })
    }
  } catch {}
  return checks
}

type ReviewRaw = { id: number; user?: { login?: string }; state: string; body?: string; html_url: string }
type InlineCommentRaw = {
  id: number
  user?: { login?: string }
  path?: string
  line?: number | null
  original_line?: number | null
  body?: string
  html_url: string
}
type IssueCommentRaw = { id: number; user?: { login?: string }; body?: string; html_url: string }

async function ghApi<T>(path: string): Promise<T[]> {
  const r = await sh('gh', ['api', path])
  if (!r.ok) return []
  try {
    const data = JSON.parse(r.stdout)
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

const getReviews = (repo: string, n: number) =>
  ghApi<ReviewRaw>(`repos/${repo}/pulls/${n}/reviews`)
const getReviewComments = (repo: string, n: number) =>
  ghApi<InlineCommentRaw>(`repos/${repo}/pulls/${n}/comments`)
const getIssueComments = (repo: string, n: number) =>
  ghApi<IssueCommentRaw>(`repos/${repo}/issues/${n}/comments`)

const snap: Snapshot = {
  branch: null,
  pr: null,
  checks: new Map(),
  reviewIds: new Set(),
  reviewCommentIds: new Set(),
  issueCommentIds: new Set(),
  noPrAnnouncedForBranch: null,
}

const mcp = new Server(
  { name: 'pr-watcher', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'Events from this channel arrive as <channel source="pr-watcher" kind="..." ...>. ' +
      'Possible kind values: startup, no_pr, pr_changed, commits_pushed, ci_status, review, ' +
      'review_comment, issue_comment, pr_state. Meta attributes vary per kind and may include: ' +
      'pr, repo, url, head_sha, old_sha, new_sha, branch, prev_pr, check, state, bucket, ' +
      'author, path, line. The body contains a short factual summary or the included text.',
  },
)

async function emit(kind: string, content: string, meta: Record<string, string> = {}) {
  const cleaned: Record<string, string> = { kind }
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null || v === '') continue
    if (!/^[a-zA-Z0-9_]+$/.test(k)) continue
    cleaned[k] = String(v)
  }
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta: cleaned },
    })
  } catch (e) {
    log('notify failed', e)
  }
}

function cadenceFor(checks: Map<string, CheckState>, hasPr: boolean): number {
  if (!hasPr) return IDLE_MS
  for (const c of checks.values()) {
    if (c.bucket === 'pending') return FAST_MS
  }
  return NORMAL_MS
}

function resetForNoPr() {
  snap.pr = null
  snap.checks.clear()
  snap.reviewIds.clear()
  snap.reviewCommentIds.clear()
  snap.issueCommentIds.clear()
}

async function bootstrapForPr(pr: Pr) {
  snap.checks = await getChecks()
  const reviews = await getReviews(pr.repo, pr.number)
  snap.reviewIds = new Set(reviews.map(r => r.id))
  const reviewComments = await getReviewComments(pr.repo, pr.number)
  snap.reviewCommentIds = new Set(reviewComments.map(c => c.id))
  const issueComments = await getIssueComments(pr.repo, pr.number)
  snap.issueCommentIds = new Set(issueComments.map(c => c.id))
}

async function tick(): Promise<number> {
  const branch = await getCurrentBranch()

  if (!branch) {
    if (snap.pr || snap.branch) {
      resetForNoPr()
      snap.branch = null
      snap.noPrAnnouncedForBranch = null
    }
    return IDLE_MS
  }

  if (snap.branch !== branch) {
    snap.branch = branch
    snap.noPrAnnouncedForBranch = null
  }

  const pr = await getPr()

  if (!pr) {
    if (snap.pr) resetForNoPr()
    if (snap.noPrAnnouncedForBranch !== branch) {
      snap.noPrAnnouncedForBranch = branch
      await emit('no_pr', `Branch ${branch} has no open PR.`, { branch })
    }
    return IDLE_MS
  }

  const isFirstOrNewPr = !snap.pr || snap.pr.number !== pr.number || snap.pr.repo !== pr.repo
  if (isFirstOrNewPr) {
    const prev = snap.pr
    snap.pr = pr
    await bootstrapForPr(pr)
    if (prev) {
      await emit(
        'pr_changed',
        `Now watching PR #${pr.number} (was #${prev.number}). ${pr.title}`,
        {
          pr: String(pr.number),
          repo: pr.repo,
          head_sha: pr.headSha,
          url: pr.url,
          prev_pr: String(prev.number),
        },
      )
    } else {
      await emit(
        'startup',
        `Watching PR #${pr.number} in ${pr.repo} at ${pr.headSha.slice(0, 7)}. ${pr.title}`,
        {
          pr: String(pr.number),
          repo: pr.repo,
          head_sha: pr.headSha,
          url: pr.url,
        },
      )
    }
    return cadenceFor(snap.checks, true)
  }

  const prev = snap.pr!
  const events: Array<() => Promise<void>> = []

  if (prev.headSha !== pr.headSha) {
    const oldSha = prev.headSha
    events.push(() =>
      emit(
        'commits_pushed',
        `Head moved ${oldSha.slice(0, 7)} → ${pr.headSha.slice(0, 7)}`,
        {
          pr: String(pr.number),
          old_sha: oldSha,
          new_sha: pr.headSha,
          url: pr.url,
        },
      ),
    )
  }

  if (prev.state !== pr.state) {
    events.push(() =>
      emit('pr_state', `PR #${pr.number} is now ${pr.state}`, {
        pr: String(pr.number),
        state: pr.state,
        url: pr.url,
      }),
    )
  }

  snap.pr = pr

  const newChecks = await getChecks()
  for (const [name, cur] of newChecks) {
    const p = snap.checks.get(name)
    if (!p || p.state !== cur.state || p.bucket !== cur.bucket) {
      const summary = `Check "${name}": ${cur.state || cur.bucket}${cur.url ? ` — ${cur.url}` : ''}`
      events.push(() =>
        emit('ci_status', summary, {
          pr: String(pr.number),
          check: name,
          state: cur.state,
          bucket: cur.bucket,
          url: cur.url,
        }),
      )
    }
  }
  snap.checks = newChecks

  const reviews = await getReviews(pr.repo, pr.number)
  for (const rv of reviews) {
    if (snap.reviewIds.has(rv.id)) continue
    snap.reviewIds.add(rv.id)
    const body = (rv.body ?? '').trim().slice(0, 1000) || '(no body)'
    events.push(() =>
      emit('review', body, {
        pr: String(pr.number),
        author: rv.user?.login ?? '',
        state: rv.state,
        url: rv.html_url,
      }),
    )
  }

  const reviewComments = await getReviewComments(pr.repo, pr.number)
  for (const c of reviewComments) {
    if (snap.reviewCommentIds.has(c.id)) continue
    snap.reviewCommentIds.add(c.id)
    const body = (c.body ?? '').trim() || '(no body)'
    events.push(() =>
      emit('review_comment', body, {
        pr: String(pr.number),
        author: c.user?.login ?? '',
        path: c.path ?? '',
        line: String(c.line ?? c.original_line ?? 0),
        url: c.html_url,
      }),
    )
  }

  const issueComments = await getIssueComments(pr.repo, pr.number)
  for (const c of issueComments) {
    if (snap.issueCommentIds.has(c.id)) continue
    snap.issueCommentIds.add(c.id)
    const body = (c.body ?? '').trim() || '(no body)'
    events.push(() =>
      emit('issue_comment', body, {
        pr: String(pr.number),
        author: c.user?.login ?? '',
        url: c.html_url,
      }),
    )
  }

  for (const e of events) await e()

  return cadenceFor(snap.checks, true)
}

async function loop() {
  while (true) {
    let next = NORMAL_MS
    try {
      next = await tick()
    } catch (e) {
      log('tick error', e)
      next = NORMAL_MS
    }
    await new Promise(r => setTimeout(r, next))
  }
}

await mcp.connect(new StdioServerTransport())
log('connected; entering poll loop')
loop().catch(e => log('loop crashed', e))
