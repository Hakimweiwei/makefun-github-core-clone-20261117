import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
}

export interface LabelRecord {
  readonly id: number;
  readonly node_id: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface CommentRecord {
  readonly id: number;
  readonly node_id: string;
  readonly body: string;
  readonly user: { login: string; id: number; node_id: string; type: string };
  readonly created_at: string;
  readonly updated_at: string;
}

export interface IssueRecord {
  readonly id: number;
  readonly node_id: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly user: { login: string; id: number; node_id: string; type: string };
  readonly labels: LabelRecord[];
  readonly comments: CommentRecord[];
  readonly created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface PullFileRecord {
  readonly sha: string;
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface PullRecord {
  readonly id: number;
  readonly node_id: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: { ref: string; sha: string; label: string };
  readonly base: { ref: string; sha: string; label: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  readonly user: { login: string; id: number; node_id: string; type: string };
  readonly created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface RepoRecord {
  readonly id: number;
  readonly node_id: string;
  readonly name: string;
  readonly full_name: string;
  readonly owner: { login: string; id: number; node_id: string; type: string };
  description: string | null;
  private: boolean;
  default_branch: string;
  has_issues: boolean;
  readonly created_at: string;
  updated_at: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: Map<number, IssueRecord>;
  readonly pulls: Map<number, PullRecord>;
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

export const ZERO_OID = '0'.repeat(40);
export const DEFAULT_OWNER_LOGIN = 'makefun-forge';

export function makeOwnerUser(login: string) {
  return {
    login,
    id: 1,
    node_id: 'U_1',
    type: 'User',
  };
}

const TYPE_TO_NUM: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const NUM_TO_TYPE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function hashGitObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitBuffer(
  tree: string,
  parents: readonly string[],
  message: string,
  author = `${DEFAULT_OWNER_LOGIN} <${DEFAULT_OWNER_LOGIN}@make.fun> 1700000000 +0000`,
): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`);
  lines.push(`committer ${author}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const rawMode = data.subarray(off, sp).toString('utf8');
    const mode = rawMode === '40000' ? '040000' : rawMode;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '040000' || e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTreeBuffer(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    const mode = e.mode === '040000' ? '40000' : e.mode;
    parts.push(Buffer.from(`${mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split === -1 ? text : text.slice(0, split);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

function readDeltaVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: pos };
}

export function applyGitDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const srcInfo = readDeltaVarint(delta, pos);
  pos = srcInfo.next;
  if (srcInfo.value !== base.length) {
    throw new Error(`delta base size mismatch: expected ${srcInfo.value}, got ${base.length}`);
  }
  const tgtInfo = readDeltaVarint(delta, pos);
  pos = tgtInfo.next;
  const out = Buffer.allocUnsafe(tgtInfo.value);
  let outPos = 0;
  while (pos < delta.length) {
    const cmd = delta[pos++];
    if ((cmd & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      if (cmd & 0x01) cpOff |= delta[pos++];
      if (cmd & 0x02) cpOff |= delta[pos++] << 8;
      if (cmd & 0x04) cpOff |= delta[pos++] << 16;
      if (cmd & 0x08) cpOff |= delta[pos++] << 24;
      if (cmd & 0x10) cpSize |= delta[pos++];
      if (cmd & 0x20) cpSize |= delta[pos++] << 8;
      if (cmd & 0x40) cpSize |= delta[pos++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outPos, cpOff, cpOff + cpSize);
      outPos += cpSize;
    } else if (cmd > 0) {
      delta.copy(out, outPos, pos, pos + cmd);
      pos += cmd;
      outPos += cmd;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (outPos !== tgtInfo.value) {
    throw new Error(`delta output size mismatch: expected ${tgtInfo.value}, got ${outPos}`);
  }
  return out;
}

/**
 * Inflate one zlib stream starting at `start` and return the decompressed bytes plus the exact
 * compressed byte length consumed (via a tiny pure-Node zlib trailer scan or InflateRaw/Inflate).
 */
function inflatePackEntry(pack: Buffer, start: number, expectedSize: number): { data: Buffer; consumed: number } {
  // Node's inflateSync with { info: true } returns { buffer, engine: { bytesWritten } }!
  const res = inflateSync(pack.subarray(start), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (res.buffer.length !== expectedSize) {
    // Allow anyway if delta or valid, but check
  }
  return { data: res.buffer, consumed: res.engine.bytesWritten };
}

export function parsePack(
  pack: Buffer,
  existing: ReadonlyMap<string, GitObject>,
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const expectedChecksum = pack.subarray(pack.length - 20).toString('hex');
  const actualChecksum = sha1Hex(pack.subarray(0, pack.length - 20));
  if (expectedChecksum !== actualChecksum) throw new Error('pack checksum mismatch');

  const added = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; obj: GitObject }>();
  const pendingRefDeltas: Array<{ baseOid: string; delta: Buffer }> = [];

  const lookup = (oid: string): GitObject | undefined => added.get(oid) ?? existing.get(oid);

  let pos = 12;
  const end = pack.length - 20;
  for (let i = 0; i < count; i += 1) {
    if (pos >= end) throw new Error('truncated pack');
    const entryStart = pos;
    let c = pack[pos++];
    const typeNum = (c >> 4) & 0x07;
    let size = c & 0x0f;
    let shift = 4;
    while ((c & 0x80) !== 0) {
      c = pack[pos++];
      size |= (c & 0x7f) << shift;
      shift += 7;
    }

    if (typeNum >= 1 && typeNum <= 4) {
      const type = NUM_TO_TYPE[typeNum];
      const { data, consumed } = inflatePackEntry(pack, pos, size);
      pos += consumed;
      const oid = hashGitObject(type, data);
      const obj: GitObject = { type, data };
      added.set(oid, obj);
      byOffset.set(entryStart, { oid, obj });
    } else if (typeNum === 6) {
      // OFS_DELTA
      let b = pack[pos++];
      let back = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[pos++];
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      const baseOff = entryStart - back;
      const baseEntry = byOffset.get(baseOff);
      if (!baseEntry) throw new Error(`missing OFS_DELTA base at ${baseOff}`);
      const { data: delta, consumed } = inflatePackEntry(pack, pos, size);
      pos += consumed;
      const reconstructed = applyGitDelta(baseEntry.obj.data, delta);
      const oid = hashGitObject(baseEntry.obj.type, reconstructed);
      const obj: GitObject = { type: baseEntry.obj.type, data: reconstructed };
      added.set(oid, obj);
      byOffset.set(entryStart, { oid, obj });
    } else if (typeNum === 7) {
      // REF_DELTA
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data: delta, consumed } = inflatePackEntry(pack, pos, size);
      pos += consumed;
      const baseObj = lookup(baseOid);
      if (baseObj) {
        const reconstructed = applyGitDelta(baseObj.data, delta);
        const oid = hashGitObject(baseObj.type, reconstructed);
        const obj: GitObject = { type: baseObj.type, data: reconstructed };
        added.set(oid, obj);
        byOffset.set(entryStart, { oid, obj });
      } else {
        pendingRefDeltas.push({ baseOid, delta });
      }
    } else {
      throw new Error(`unsupported pack object type ${typeNum}`);
    }
  }

  let progress = true;
  let remaining = pendingRefDeltas;
  while (remaining.length > 0 && progress) {
    progress = false;
    const next: typeof remaining = [];
    for (const item of remaining) {
      const baseObj = lookup(item.baseOid);
      if (baseObj) {
        const reconstructed = applyGitDelta(baseObj.data, item.delta);
        const oid = hashGitObject(baseObj.type, reconstructed);
        added.set(oid, { type: baseObj.type, data: reconstructed });
        progress = true;
      } else {
        next.push(item);
      }
    }
    remaining = next;
  }
  if (remaining.length > 0) {
    throw new Error(`unresolved REF_DELTA base ${remaining[0].baseOid}`);
  }

  return added;
}

export function buildPack(oids: readonly string[], lookup: (oid: string) => GitObject | undefined): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  const chunks: Buffer[] = [header];

  for (const oid of oids) {
    const obj = lookup(oid);
    if (!obj) throw new Error(`missing object ${oid} for pack`);
    const typeNum = TYPE_TO_NUM[obj.type];
    let size = obj.data.length;
    const hdrBytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    size >>>= 4;
    if (size > 0) first |= 0x80;
    hdrBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>>= 7;
      if (size > 0) b |= 0x80;
      hdrBytes.push(b);
    }
    chunks.push(Buffer.from(hdrBytes));
    chunks.push(deflateSync(obj.data));
  }

  const body = Buffer.concat(chunks);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}

export function collectReachableObjects(
  wants: readonly string[],
  haves: ReadonlySet<string>,
  depth: number | undefined,
  lookup: (oid: string) => GitObject | undefined,
  clientShallows: ReadonlySet<string> = new Set(),
): { oids: string[]; shallow: string[] } {
  const haveReachable = new Set<string>();
  const markHaveTree = (treeOid: string): void => {
    if (haveReachable.has(treeOid)) return;
    haveReachable.add(treeOid);
    const obj = lookup(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '040000') markHaveTree(entry.sha);
      else haveReachable.add(entry.sha);
    }
  };
  const haveQueue = [...haves];
  while (haveQueue.length > 0) {
    const oid = haveQueue.pop()!;
    if (haveReachable.has(oid)) continue;
    haveReachable.add(oid);
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      markHaveTree(c.tree);
      if (!clientShallows.has(oid)) {
        for (const p of c.parents) {
          if (!haveReachable.has(p)) haveQueue.push(p);
        }
      }
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (!haveReachable.has(t.object)) haveQueue.push(t.object);
    } else if (obj.type === 'tree') {
      markHaveTree(oid);
    }
  }

  const collected = new Set<string>();
  const shallow = new Set<string>();
  const seenCommits = new Set<string>();

  const collectTree = (treeOid: string): void => {
    if (collected.has(treeOid) || haveReachable.has(treeOid)) return;
    const obj = lookup(treeOid);
    if (!obj || obj.type !== 'tree') return;
    collected.add(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '040000') collectTree(entry.sha);
      else if (!haveReachable.has(entry.sha)) collected.add(entry.sha);
    }
  };

  const queue: Array<{ oid: string; d: number }> = wants.map((oid) => ({ oid, d: 1 }));
  while (queue.length > 0) {
    const { oid, d } = queue.shift()!;
    const isClientShallow = clientShallows.has(oid);
    if (haveReachable.has(oid) && !isClientShallow) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (!collected.has(oid)) {
        collected.add(oid);
        const t = parseTag(obj.data);
        queue.push({ oid: t.object, d });
      }
    } else if (obj.type === 'commit') {
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      if (!haveReachable.has(oid)) {
        collected.add(oid);
        const c = parseCommit(obj.data);
        collectTree(c.tree);
      }
      const c = parseCommit(obj.data);
      if (depth !== undefined && d >= depth) {
        if (c.parents.length > 0) shallow.add(oid);
      } else {
        for (const p of c.parents) {
          if (!haveReachable.has(p) || clientShallows.has(p)) queue.push({ oid: p, d: d + 1 });
        }
      }
    } else if (obj.type === 'tree') {
      collectTree(oid);
    } else {
      if (!haveReachable.has(oid)) collected.add(oid);
    }
  }

  return { oids: [...collected], shallow: [...shallow] };
}

export function isAncestor(
  ancestor: string,
  descendant: string,
  lookup: (oid: string) => GitObject | undefined,
): boolean {
  if (ancestor === descendant) return true;
  const visited = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const obj = lookup(cur);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    for (const p of c.parents) {
      if (!visited.has(p)) stack.push(p);
    }
  }
  return false;
}

export function findMergeBase(
  a: string,
  b: string,
  lookup: (oid: string) => GitObject | undefined,
): string | null {
  const ancestorsA = new Set<string>();
  const qA = [a];
  while (qA.length > 0) {
    const cur = qA.shift()!;
    if (ancestorsA.has(cur)) continue;
    ancestorsA.add(cur);
    const obj = lookup(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) qA.push(p);
  }
  const visitedB = new Set<string>();
  const qB = [b];
  while (qB.length > 0) {
    const cur = qB.shift()!;
    if (ancestorsA.has(cur)) return cur;
    if (visitedB.has(cur)) continue;
    visitedB.add(cur);
    const obj = lookup(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) qB.push(p);
  }
  return null;
}

export function flattenTree(
  treeOid: string,
  prefix: string,
  lookup: (oid: string) => GitObject | undefined,
  out = new Map<string, { mode: string; sha: string }>(),
): Map<string, { mode: string; sha: string }> {
  const obj = lookup(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '040000') {
      flattenTree(entry.sha, path, lookup, out);
    } else {
      out.set(path, { mode: entry.mode, sha: entry.sha });
    }
  }
  return out;
}

export function buildTreeFromFlat(
  files: ReadonlyMap<string, { mode: string; sha: string }>,
  storeObject: (type: GitObjectType, data: Buffer) => string,
): string {
  interface DirNode {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, info] of files) {
    const parts = path.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = cur.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        cur.dirs.set(parts[i], child);
      }
      cur = child;
    }
    if (parts.length > 0) cur.files.set(parts[parts.length - 1], info);
  }
  const writeDir = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, info] of node.files) {
      entries.push({ mode: info.mode, name, sha: info.sha });
    }
    for (const [name, child] of node.dirs) {
      const sha = writeDir(child);
      entries.push({ mode: '040000', name, sha });
    }
    return storeObject('tree', buildTreeBuffer(entries));
  };
  return writeDir(root);
}

export class ForgeStore {
  private nextRepoId = 1;
  private readonly repos = new Map<string, RepoRecord>();
  private seqTime = 1700000000000;
  private boundOwner: string | null = null;

  getOwnerLogin(): string {
    return this.boundOwner ?? DEFAULT_OWNER_LOGIN;
  }

  getOwnerUser() {
    return makeOwnerUser(this.getOwnerLogin());
  }

  nextIsoTimestamp(): string {
    this.seqTime += 1000;
    return new Date(this.seqTime).toISOString();
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    const repo = this.repos.get(name.toLowerCase());
    if (!repo) return undefined;
    if (this.boundOwner === null) {
      this.boundOwner = owner;
      repo.owner.login = owner;
      (repo as { full_name: string }).full_name = `${owner}/${repo.name}`;
    }
    if (owner.toLowerCase() !== this.boundOwner.toLowerCase()) return undefined;
    return repo;
  }

  listRepos(): RepoRecord[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  createRepo(input: { name: string; description?: string | null; private?: boolean }): RepoRecord | null {
    const key = input.name.toLowerCase();
    if (this.repos.has(key)) return null;
    const id = this.nextRepoId++;
    const now = this.nextIsoTimestamp();
    const login = this.getOwnerLogin();
    const repo: RepoRecord = {
      id,
      node_id: `R_${id}`,
      name: input.name,
      full_name: `${login}/${input.name}`,
      owner: makeOwnerUser(login),
      description: input.description ?? null,
      private: Boolean(input.private),
      default_branch: 'main',
      has_issues: true,
      created_at: now,
      updated_at: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (!this.getRepo(owner, name)) return false;
    return this.repos.delete(name.toLowerCase());
  }

  putObject(repo: RepoRecord, type: GitObjectType, data: Buffer): string {
    const oid = hashGitObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getBranchFiles(repo: RepoRecord, branchOrSha: string): Map<string, { mode: string; sha: string }> {
    const commitOid = repo.refs.get(`refs/heads/${branchOrSha}`) ?? (repo.objects.has(branchOrSha) ? branchOrSha : undefined);
    if (!commitOid) return new Map();
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return new Map();
    const commit = parseCommit(obj.data);
    return flattenTree(commit.tree, '', (oid) => repo.objects.get(oid));
  }
}
