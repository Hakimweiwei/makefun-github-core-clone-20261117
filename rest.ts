import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeStore,
  buildCommitBuffer,
  buildTreeFromFlat,
  findMergeBase,
  flattenTree,
  parseCommit,
  parseTree,
} from './store.ts';
import type { IssueRecord, LabelRecord, PullFileRecord, PullRecord, RepoRecord } from './store.ts';

export interface RestReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

function repoJson(r: RepoRecord) {
  return {
    id: r.id,
    node_id: r.node_id,
    name: r.name,
    full_name: r.full_name,
    owner: r.owner,
    description: r.description,
    private: r.private,
    default_branch: r.default_branch,
    has_issues: r.has_issues,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function issueJson(i: IssueRecord) {
  return {
    id: i.id,
    node_id: i.node_id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    user: i.user,
    labels: i.labels,
    comments: i.comments.length,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
  };
}

function pullJson(p: PullRecord, repo: RepoRecord) {
  return {
    id: p.id,
    node_id: p.node_id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    user: p.user,
    head: { ref: p.head.ref, sha: p.head.sha, label: p.head.label, repo: repoJson(repo) },
    base: { ref: p.base.ref, sha: p.base.sha, label: p.base.label, repo: repoJson(repo) },
    merged: p.merged,
    merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha,
    mergeable: p.mergeable,
    created_at: p.created_at,
    updated_at: p.updated_at,
    closed_at: p.closed_at,
  };
}

function paginate<T>(items: readonly T[], url: URL): { slice: T[]; linkHeader?: string } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const nextUrl = new URL(url.toString());
    nextUrl.searchParams.set('page', String(page + 1));
    nextUrl.searchParams.set('per_page', String(perPage));
    return { slice, linkHeader: `<${nextUrl.pathname}${nextUrl.search}>; rel="next"` };
  }
  return { slice };
}

function computeThreeWayMerge(
  repo: RepoRecord,
  baseSha: string,
  headSha: string,
): { ok: true; files: Map<string, { mode: string; sha: string }> } | { ok: false } {
  const lookup = (oid: string) => repo.objects.get(oid);
  const baseCommitObj = lookup(baseSha);
  const headCommitObj = lookup(headSha);
  if (!baseCommitObj || baseCommitObj.type !== 'commit' || !headCommitObj || headCommitObj.type !== 'commit') {
    return { ok: false };
  }
  const baseFiles = flattenTree(parseCommit(baseCommitObj.data).tree, '', lookup);
  const headFiles = flattenTree(parseCommit(headCommitObj.data).tree, '', lookup);
  const mbSha = findMergeBase(baseSha, headSha, lookup);
  const mbCommitObj = mbSha ? lookup(mbSha) : undefined;
  const mbFiles =
    mbCommitObj && mbCommitObj.type === 'commit'
      ? flattenTree(parseCommit(mbCommitObj.data).tree, '', lookup)
      : new Map<string, { mode: string; sha: string }>();

  const allPaths = new Set<string>([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  const merged = new Map<string, { mode: string; sha: string }>();

  for (const p of allPaths) {
    const mb = mbFiles.get(p);
    const b = baseFiles.get(p);
    const h = headFiles.get(p);
    const bSameAsMb = b?.sha === mb?.sha && b?.mode === mb?.mode;
    const hSameAsMb = h?.sha === mb?.sha && h?.mode === mb?.mode;
    const bSameAsH = b?.sha === h?.sha && b?.mode === h?.mode;

    if (bSameAsH) {
      if (b) merged.set(p, b);
    } else if (bSameAsMb) {
      if (h) merged.set(p, h);
    } else if (hSameAsMb) {
      if (b) merged.set(p, b);
    } else {
      return { ok: false };
    }
  }
  return { ok: true, files: merged };
}

function computePullFiles(repo: RepoRecord, baseSha: string, headSha: string): PullFileRecord[] {
  const lookup = (oid: string) => repo.objects.get(oid);
  const mbSha = findMergeBase(baseSha, headSha, lookup) ?? baseSha;
  const mbCommit = lookup(mbSha);
  const headCommit = lookup(headSha);
  const mbFiles =
    mbCommit && mbCommit.type === 'commit'
      ? flattenTree(parseCommit(mbCommit.data).tree, '', lookup)
      : new Map<string, { mode: string; sha: string }>();
  const headFiles =
    headCommit && headCommit.type === 'commit'
      ? flattenTree(parseCommit(headCommit.data).tree, '', lookup)
      : new Map<string, { mode: string; sha: string }>();

  const allPaths = [...new Set([...mbFiles.keys(), ...headFiles.keys()])].sort();
  const out: PullFileRecord[] = [];
  for (const filename of allPaths) {
    const prev = mbFiles.get(filename);
    const next = headFiles.get(filename);
    if (!prev && next) {
      const lines = lookup(next.sha)?.data.toString('utf8').split('\n').length ?? 1;
      out.push({ sha: next.sha, filename, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (prev && !next) {
      const lines = lookup(prev.sha)?.data.toString('utf8').split('\n').length ?? 1;
      out.push({ sha: prev.sha, filename, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (prev && next && prev.sha !== next.sha) {
      const prevLines = lookup(prev.sha)?.data.toString('utf8').split('\n').length ?? 1;
      const nextLines = lookup(next.sha)?.data.toString('utf8').split('\n').length ?? 1;
      out.push({
        sha: next.sha,
        filename,
        status: 'modified',
        additions: nextLines,
        deletions: prevLines,
        changes: nextLines + prevLines,
      });
    }
  }
  return out;
}

export function dispatchRest(store: ForgeStore, method: string, rawPath: string, body?: unknown): RestReply {
  const url = new URL(rawPath, 'http://entry');
  const path = url.pathname;
  const objBody = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    return { status: 200, body: { verifiable_password_authentication: false, installed_version: '1.0.0' } };
  }
  if (method === 'GET' && path === '/api/v3/user') {
    return { status: 200, body: store.getOwnerUser() };
  }
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const all = store.listRepos().map(repoJson);
    const { slice, linkHeader } = paginate(all, url);
    return { status: 200, body: slice, headers: linkHeader ? { link: linkHeader } : undefined };
  }
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const name = typeof objBody.name === 'string' ? objBody.name.trim() : '';
    if (!name) return { status: 422, body: { message: 'Repository name is required' } };
    const created = store.createRepo({
      name,
      description: typeof objBody.description === 'string' ? objBody.description : null,
      private: Boolean(objBody.private),
    });
    if (!created) return { status: 422, body: { message: 'Repository creation failed: name already exists' } };
    return { status: 201, body: repoJson(created) };
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!repoMatch) {
    return { status: 404, body: { message: 'Not Found' } };
  }

  const owner = decodeURIComponent(repoMatch[1]);
  const repoName = decodeURIComponent(repoMatch[2]);
  const sub = repoMatch[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    return { status: 404, body: { message: 'Not Found' } };
  }

  if (sub === '' || sub === '/') {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      if (typeof objBody.description === 'string' || objBody.description === null) {
        repo.description = objBody.description as string | null;
      }
      if (typeof objBody.default_branch === 'string' && objBody.default_branch) {
        repo.default_branch = objBody.default_branch;
      }
      if (typeof objBody.private === 'boolean') repo.private = objBody.private;
      if (typeof objBody.has_issues === 'boolean') repo.has_issues = objBody.has_issues;
      repo.updated_at = store.nextIsoTimestamp();
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
  }

  if (method === 'GET' && sub === '/branches') {
    const branches: Array<{ name: string; commit: { sha: string } }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) {
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
    }
    branches.sort((a, b) => a.name.localeCompare(b.name));
    return { status: 200, body: branches };
  }

  if (method === 'GET' && sub === '/commits') {
    const shaParam = url.searchParams.get('sha') ?? repo.default_branch;
    let cur = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : undefined);
    const commits: Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }> = [];
    const seen = new Set<string>();
    while (cur && !seen.has(cur) && commits.length < 100) {
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') break;
      const parsed = parseCommit(obj.data);
      commits.push({
        sha: cur,
        commit: { message: parsed.message, author: { name: store.getOwnerLogin(), date: repo.updated_at } },
      });
      cur = parsed.parents[0];
    }
    return { status: 200, body: commits };
  }

  if (method === 'POST' && sub === '/git/refs') {
    const ref = typeof objBody.ref === 'string' ? objBody.ref : '';
    const sha = typeof objBody.sha === 'string' ? objBody.sha : '';
    if (!ref || !sha || !repo.objects.has(sha)) {
      return { status: 422, body: { message: 'Invalid ref or sha' } };
    }
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
  }

  // Contents API
  if (sub === '/contents' || sub.startsWith('/contents/')) {
    const filePath = sub.length > '/contents/'.length ? decodeURIComponent(sub.slice('/contents/'.length)) : '';
    const branch =
      (typeof objBody.branch === 'string' && objBody.branch) ||
      url.searchParams.get('ref') ||
      repo.default_branch;

    if (method === 'GET') {
      const files = store.getBranchFiles(repo, branch);
      if (filePath && files.has(filePath)) {
        const entry = files.get(filePath)!;
        const blob = repo.objects.get(entry.sha);
        if (!blob) return { status: 404, body: { message: 'Not Found' } };
        const name = filePath.split('/').pop() ?? filePath;
        return {
          status: 200,
          body: {
            name,
            path: filePath,
            sha: entry.sha,
            size: blob.data.length,
            type: 'file',
            encoding: 'base64',
            content: blob.data.toString('base64'),
          },
        };
      }
      // Check directory listing
      const prefix = filePath ? `${filePath.replace(/\/+$/, '')}/` : '';
      const dirMap = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }>();
      for (const [p, info] of files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          const blob = repo.objects.get(info.sha);
          dirMap.set(rest, { name: rest, path: p, sha: info.sha, type: 'file', size: blob?.data.length ?? 0 });
        } else {
          const dirName = rest.slice(0, slash);
          if (!dirMap.has(dirName)) {
            dirMap.set(dirName, { name: dirName, path: `${prefix}${dirName}`, sha: info.sha, type: 'dir', size: 0 });
          }
        }
      }
      if (dirMap.size > 0) {
        return { status: 200, body: [...dirMap.values()].sort((a, b) => a.name.localeCompare(b.name)) };
      }
      return { status: 404, body: { message: 'Not Found' } };
    }

    if (method === 'PUT') {
      if (!filePath) return { status: 422, body: { message: 'Path is required' } };
      const message = typeof objBody.message === 'string' ? objBody.message : 'Update file';
      const contentB64 = typeof objBody.content === 'string' ? objBody.content : '';
      const rawBuf = Buffer.from(contentB64, 'base64');
      const files = store.getBranchFiles(repo, branch);
      const existing = files.get(filePath);
      const providedSha = typeof objBody.sha === 'string' ? objBody.sha : undefined;
      if (existing) {
        if (providedSha !== existing.sha) {
          return { status: 409, body: { message: `${filePath} does not match ${existing.sha}` } };
        }
      } else if (providedSha) {
        return { status: 409, body: { message: `${filePath} does not exist` } };
      }

      const blobSha = store.putObject(repo, 'blob', rawBuf);
      files.set(filePath, { mode: '100644', sha: blobSha });
      const treeSha = buildTreeFromFlat(files, (t, d) => store.putObject(repo, t, d));
      const parentSha = repo.refs.get(`refs/heads/${branch}`);
      const parents = parentSha ? [parentSha] : [];
      const commitSha = store.putObject(repo, 'commit', buildCommitBuffer(treeSha, parents, message));
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      repo.updated_at = store.nextIsoTimestamp();

      const name = filePath.split('/').pop() ?? filePath;
      return {
        status: existing ? 200 : 201,
        body: {
          content: {
            name,
            path: filePath,
            sha: blobSha,
            size: rawBuf.length,
            type: 'file',
            encoding: 'base64',
            content: contentB64,
          },
          commit: { sha: commitSha, message },
        },
      };
    }

    if (method === 'DELETE') {
      if (!filePath) return { status: 422, body: { message: 'Path is required' } };
      const message = typeof objBody.message === 'string' ? objBody.message : 'Delete file';
      const files = store.getBranchFiles(repo, branch);
      const existing = files.get(filePath);
      if (!existing) return { status: 404, body: { message: 'Not Found' } };
      if (typeof objBody.sha === 'string' && objBody.sha !== existing.sha) {
        return { status: 409, body: { message: `${filePath} does not match ${existing.sha}` } };
      }
      files.delete(filePath);
      const treeSha = buildTreeFromFlat(files, (t, d) => store.putObject(repo, t, d));
      const parentSha = repo.refs.get(`refs/heads/${branch}`);
      const commitSha = store.putObject(repo, 'commit', buildCommitBuffer(treeSha, parentSha ? [parentSha] : [], message));
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      repo.updated_at = store.nextIsoTimestamp();
      return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
    }
  }

  // Labels
  if (sub === '/labels') {
    if (method === 'GET') return { status: 200, body: [...repo.labels.values()] };
    if (method === 'POST') {
      const name = typeof objBody.name === 'string' ? objBody.name.trim() : '';
      if (!name) return { status: 422, body: { message: 'Label name is required' } };
      const key = name.toLowerCase();
      if (repo.labels.has(key)) return { status: 422, body: { message: 'Label already exists' } };
      const id = repo.nextLabelId++;
      const label: LabelRecord = {
        id,
        node_id: `L_${repo.id}_${id}`,
        name,
        color: typeof objBody.color === 'string' ? objBody.color : 'ededed',
        description: typeof objBody.description === 'string' ? objBody.description : '',
      };
      repo.labels.set(key, label);
      return { status: 201, body: label };
    }
  }

  // Issues
  if (sub === '/issues') {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const mapped = list.map(issueJson);
      const { slice, linkHeader } = paginate(mapped, url);
      return { status: 200, body: slice, headers: linkHeader ? { link: linkHeader } : undefined };
    }
    if (method === 'POST') {
      const title = typeof objBody.title === 'string' ? objBody.title : '';
      if (!title) return { status: 422, body: { message: 'title is required' } };
      const reqLabels = Array.isArray(objBody.labels) ? objBody.labels : [];
      const resolvedLabels: LabelRecord[] = [];
      for (const l of reqLabels) {
        const lName = typeof l === 'string' ? l : (l as Record<string, unknown>)?.name;
        if (typeof lName !== 'string') return { status: 422, body: { message: 'Invalid label' } };
        const found = repo.labels.get(lName.toLowerCase());
        if (!found) return { status: 422, body: { message: `Label ${lName} does not exist` } };
        resolvedLabels.push(found);
      }
      const number = repo.nextNumber++;
      const now = store.nextIsoTimestamp();
      const issue: IssueRecord = {
        id: repo.id * 1_000_000 + number,
        node_id: `I_${repo.id}_${number}`,
        number,
        title,
        body: typeof objBody.body === 'string' ? objBody.body : '',
        state: 'open',
        user: store.getOwnerUser(),
        labels: resolvedLabels,
        comments: [],
        created_at: now,
        updated_at: now,
        closed_at: null,
      };
      repo.issues.set(number, issue);
      return { status: 201, body: issueJson(issue) };
    }
  }

  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(sub);
  if (issueMatch) {
    const num = parseInt(issueMatch[1], 10);
    const issue = repo.issues.get(num);
    if (!issue) return { status: 404, body: { message: 'Not Found' } };
    if (issueMatch[2] === '/comments') {
      if (method === 'GET') return { status: 200, body: issue.comments };
      if (method === 'POST') {
        const cBody = typeof objBody.body === 'string' ? objBody.body : '';
        const cid = repo.nextCommentId++;
        const now = store.nextIsoTimestamp();
        const comment = {
          id: cid,
          node_id: `IC_${repo.id}_${cid}`,
          body: cBody,
          user: store.getOwnerUser(),
          created_at: now,
          updated_at: now,
        };
        issue.comments.push(comment);
        issue.updated_at = now;
        return { status: 201, body: comment };
      }
    } else {
      if (method === 'GET') return { status: 200, body: issueJson(issue) };
      if (method === 'PATCH') {
        if (typeof objBody.title === 'string') issue.title = objBody.title;
        if (typeof objBody.body === 'string') issue.body = objBody.body;
        if (objBody.state === 'open' || objBody.state === 'closed') {
          issue.state = objBody.state;
          issue.closed_at = objBody.state === 'closed' ? store.nextIsoTimestamp() : null;
        }
        issue.updated_at = store.nextIsoTimestamp();
        return { status: 200, body: issueJson(issue) };
      }
    }
  }

  // Pulls
  if (sub === '/pulls') {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const mapped = list.map((p) => pullJson(p, repo));
      const { slice, linkHeader } = paginate(mapped, url);
      return { status: 200, body: slice, headers: linkHeader ? { link: linkHeader } : undefined };
    }
    if (method === 'POST') {
      const title = typeof objBody.title === 'string' ? objBody.title : '';
      const head = typeof objBody.head === 'string' ? objBody.head : '';
      const base = typeof objBody.base === 'string' ? objBody.base : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!title || !headSha || !baseSha) {
        return { status: 422, body: { message: 'Invalid pull request head, base, or title' } };
      }
      const number = repo.nextNumber++;
      const now = store.nextIsoTimestamp();
      const mergeCheck = computeThreeWayMerge(repo, baseSha, headSha);
      const pr: PullRecord = {
        id: repo.id * 1_000_000 + number,
        node_id: `PR_${repo.id}_${number}`,
        number,
        title,
        body: typeof objBody.body === 'string' ? objBody.body : '',
        state: 'open',
        head: { ref: head, sha: headSha, label: `${store.getOwnerLogin()}:${head}` },
        base: { ref: base, sha: baseSha, label: `${store.getOwnerLogin()}:${base}` },
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        mergeable: mergeCheck.ok,
        user: store.getOwnerUser(),
        created_at: now,
        updated_at: now,
        closed_at: null,
      };
      repo.pulls.set(number, pr);
      return { status: 201, body: pullJson(pr, repo) };
    }
  }

  const pullMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(sub);
  if (pullMatch) {
    const num = parseInt(pullMatch[1], 10);
    const pr = repo.pulls.get(num);
    if (!pr) return { status: 404, body: { message: 'Not Found' } };
    if (pullMatch[2] === '/files' && method === 'GET') {
      return { status: 200, body: computePullFiles(repo, pr.base.sha, pr.head.sha) };
    }
    if (pullMatch[2] === '/merge' && method === 'PUT') {
      if (pr.merged || pr.state === 'closed') {
        return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      }
      const currentBaseSha = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
      const currentHeadSha = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
      const mergeRes = computeThreeWayMerge(repo, currentBaseSha, currentHeadSha);
      if (!mergeRes.ok) {
        pr.mergeable = false;
        return { status: 405, body: { message: 'Merge conflict' } };
      }
      const treeSha = buildTreeFromFlat(mergeRes.files, (t, d) => store.putObject(repo, t, d));
      const commitMsg =
        typeof objBody.commit_title === 'string' && objBody.commit_title
          ? objBody.commit_title
          : `${pr.title} (#${pr.number})`;
      const commitSha = store.putObject(repo, 'commit', buildCommitBuffer(treeSha, [currentBaseSha], commitMsg));
      repo.refs.set(`refs/heads/${pr.base.ref}`, commitSha);
      const now = store.nextIsoTimestamp();
      pr.merged = true;
      pr.state = 'closed';
      pr.merged_at = now;
      pr.closed_at = now;
      pr.updated_at = now;
      pr.merge_commit_sha = commitSha;
      pr.mergeable = false;
      repo.updated_at = now;
      return {
        status: 200,
        body: { sha: commitSha, merged: true, message: 'Pull Request successfully merged' },
      };
    }
    if (!pullMatch[2] && method === 'GET') {
      if (pr.state === 'open') {
        const currentBaseSha = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
        const currentHeadSha = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
        pr.mergeable = computeThreeWayMerge(repo, currentBaseSha, currentHeadSha).ok;
      }
      return { status: 200, body: pullJson(pr, repo) };
    }
  }

  return { status: 404, body: { message: 'Not Found' } };
}

function sendJsonReply(res: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>): void {
  const reqId = randomUUID();
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': reqId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId,
    ...headers,
  });
  res.end(text);
}

function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createRestHandler(store: ForgeStore, expectedToken: string) {
  return async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://entry');
    if (url.pathname !== '/api/v3' && !url.pathname.startsWith('/api/v3/')) {
      return false;
    }

    const auth = req.headers.authorization ?? '';
    if (!expectedToken || auth !== `Bearer ${expectedToken}`) {
      sendJsonReply(res, 401, { message: 'Requires authentication' });
      return true;
    }

    const method = req.method ?? 'GET';
    let parsedBody: unknown = undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBodyText(req);
      if (raw.trim() !== '') {
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          sendJsonReply(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
      }
    }

    const reply = dispatchRest(store, method, `${url.pathname}${url.search}`, parsedBody);
    const headers = reply.headers ? { ...reply.headers } : undefined;
    if (headers?.link && req.headers.host) {
      headers.link = headers.link.replace('<', `<http://${req.headers.host}`);
    }
    sendJsonReply(res, reply.status, reply.body, headers);
    return true;
  };
}
