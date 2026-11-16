import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeStore,
  ZERO_OID,
  buildPack,
  collectReachableObjects,
  isAncestor,
  parsePack,
  parseTag,
} from './store.ts';

function pktLine(payload: string | Buffer): Buffer {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = (buf.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'ascii'), buf]);
}

const FLUSH_PKT = Buffer.from('0000', 'ascii');
const DELIM_PKT = Buffer.from('0001', 'ascii');

interface PktItem {
  readonly type: 'flush' | 'delim' | 'data';
  readonly data: Buffer;
}

function parsePktStream(buf: Buffer): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const hdr = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hdr)) break;
    const len = parseInt(hdr, 16);
    if (len === 0) {
      items.push({ type: 'flush', data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 1) {
      items.push({ type: 'delim', data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) break;
    items.push({ type: 'data', data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { items, rest: buf.subarray(pos) };
}

function wrapSideBand(channel: 1 | 2 | 3, payload: Buffer): Buffer {
  const MAX_CHUNK = 65515;
  const parts: Buffer[] = [];
  for (let off = 0; off < payload.length; off += MAX_CHUNK) {
    const slice = payload.subarray(off, Math.min(off + MAX_CHUNK, payload.length));
    const frame = Buffer.concat([Buffer.from([channel]), slice]);
    parts.push(pktLine(frame));
  }
  return Buffer.concat(parts);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  const text = JSON.stringify({ message }) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createGitHttpHandler(store: ForgeStore, expectedToken: string) {
  return async function handleGitHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://entry');
    const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(url.pathname);
    if (!match) return false;

    const auth = req.headers.authorization ?? '';
    if (!expectedToken || auth !== `Bearer ${expectedToken}`) {
      sendJsonError(res, 401, 'Requires authentication');
      return true;
    }

    const owner = decodeURIComponent(match[1]);
    const repoName = decodeURIComponent(match[2]);
    const subPath = match[3];
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJsonError(res, 404, 'Not Found');
      return true;
    }

    const method = req.method ?? 'GET';
    const gitProtocol = String(req.headers['git-protocol'] ?? '');
    const isV2 = gitProtocol.includes('version=2');

    if (method === 'GET' && subPath === '/info/refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        if (isV2) {
          const out = Buffer.concat([
            pktLine('version 2\n'),
            pktLine('agent=makefun-forge/1.0\n'),
            pktLine('ls-refs=unborn\n'),
            pktLine('fetch=shallow\n'),
            pktLine('object-format=sha1\n'),
            FLUSH_PKT,
          ]);
          sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', out);
          return true;
        }
        const caps = `multi_ack_detailed side-band-64k shallow ofs-delta agent=makefun-forge/1.0`;
        const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH_PKT];
        const sortedRefs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        const headTarget = `refs/heads/${repo.default_branch}`;
        const headOid = repo.refs.get(headTarget);
        const lines: Array<[string, string]> = [];
        if (headOid) lines.push([headOid, 'HEAD']);
        for (const [ref, oid] of sortedRefs) lines.push([oid, ref]);
        if (lines.length === 0) {
          parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
        } else {
          const symrefCap = headOid ? ` symref=HEAD:${headTarget}` : '';
          lines.forEach(([oid, ref], idx) => {
            if (idx === 0) parts.push(pktLine(`${oid} ${ref}\0${caps}${symrefCap}\n`));
            else parts.push(pktLine(`${oid} ${ref}\n`));
          });
        }
        parts.push(FLUSH_PKT);
        sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
        return true;
      }

      if (service === 'git-receive-pack') {
        const caps = 'report-status delete-refs side-band-64k ofs-delta agent=makefun-forge/1.0';
        const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH_PKT];
        const sortedRefs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        if (sortedRefs.length === 0) {
          parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
        } else {
          sortedRefs.forEach(([ref, oid], idx) => {
            if (idx === 0) parts.push(pktLine(`${oid} ${ref}\0${caps}\n`));
            else parts.push(pktLine(`${oid} ${ref}\n`));
          });
        }
        parts.push(FLUSH_PKT);
        sendBytes(res, 200, 'application/x-git-receive-pack-advertisement', Buffer.concat(parts));
        return true;
      }

      sendJsonError(res, 403, 'Unsupported service');
      return true;
    }

    if (method === 'POST' && subPath === '/git-upload-pack') {
      const body = await readRawBody(req);
      const { items } = parsePktStream(body);

      if (isV2) {
        let command = '';
        const args: string[] = [];
        let inArgs = false;
        for (const item of items) {
          if (item.type === 'delim') {
            inArgs = true;
            continue;
          }
          if (item.type === 'flush') break;
          const line = item.data.toString('utf8').replace(/\r?\n$/, '');
          if (!inArgs) {
            if (line.startsWith('command=')) command = line.slice(8);
          } else {
            args.push(line);
          }
        }

        if (command === 'ls-refs') {
          let peel = false;
          let symrefs = false;
          let unborn = false;
          const prefixes: string[] = [];
          for (const a of args) {
            if (a === 'peel') peel = true;
            else if (a === 'symrefs') symrefs = true;
            else if (a === 'unborn') unborn = true;
            else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice(11));
          }
          const matchesPrefix = (ref: string) =>
            prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
          const out: Buffer[] = [];
          const headTarget = `refs/heads/${repo.default_branch}`;
          const headOid = repo.refs.get(headTarget);
          if (matchesPrefix('HEAD')) {
            if (headOid) {
              const extra = symrefs ? ` symref-target:${headTarget}` : '';
              out.push(pktLine(`${headOid} HEAD${extra}\n`));
            } else if (unborn) {
              const extra = symrefs ? ` symref-target:${headTarget}` : '';
              out.push(pktLine(`unborn HEAD${extra}\n`));
            }
          }
          for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (!matchesPrefix(ref)) continue;
            let extra = '';
            if (peel) {
              const obj = repo.objects.get(oid);
              if (obj?.type === 'tag') {
                const peeled = parseTag(obj.data).object;
                extra = ` peeled:${peeled}`;
              }
            }
            out.push(pktLine(`${oid} ${ref}${extra}\n`));
          }
          out.push(FLUSH_PKT);
          sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
          return true;
        }

        if (command === 'fetch') {
          const wants: string[] = [];
          const haves = new Set<string>();
          const clientShallows = new Set<string>();
          let depth: number | undefined;
          let done = false;
          for (const a of args) {
            if (a.startsWith('want ')) wants.push(a.slice(5).trim());
            else if (a.startsWith('have ')) haves.add(a.slice(5).trim());
            else if (a.startsWith('shallow ')) clientShallows.add(a.slice(8).trim());
            else if (a.startsWith('deepen ')) {
              const n = parseInt(a.slice(7).trim(), 10);
              if (Number.isFinite(n) && n > 0) depth = n;
            } else if (a === 'done') done = true;
          }
          if (!done && haves.size > 0) {
            const acks: Buffer[] = [pktLine('acknowledgments\n')];
            let anyAck = false;
            for (const h of haves) {
              if (repo.objects.has(h)) {
                acks.push(pktLine(`ACK ${h}\n`));
                anyAck = true;
              }
            }
            if (!anyAck) acks.push(pktLine('NAK\n'));
            acks.push(FLUSH_PKT);
            sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(acks));
            return true;
          }
          const { oids, shallow } = collectReachableObjects(
            wants,
            haves,
            depth,
            (oid) => repo.objects.get(oid),
            clientShallows,
          );
          const pack = buildPack(oids, (oid) => repo.objects.get(oid));
          const parts: Buffer[] = [];
          if (shallow.length > 0) {
            parts.push(pktLine('shallow-info\n'));
            for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
            parts.push(DELIM_PKT);
          }
          parts.push(pktLine('packfile\n'));
          parts.push(wrapSideBand(1, pack));
          parts.push(FLUSH_PKT);
          sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
          return true;
        }

        sendJsonError(res, 400, `Unsupported git v2 command: ${command}`);
        return true;
      }

      // v0 upload-pack
      const wants: string[] = [];
      const haves = new Set<string>();
      const clientShallows = new Set<string>();
      let depth: number | undefined;
      let useSideBand = false;
      for (const item of items) {
        if (item.type !== 'data') continue;
        const raw = item.data.toString('utf8').replace(/\r?\n$/, '');
        const [line, capsStr] = raw.split('\0');
        if (capsStr && capsStr.includes('side-band-64k')) useSideBand = true;
        if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
        else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
        else if (line.startsWith('shallow ')) clientShallows.add(line.slice(8).trim());
        else if (line.startsWith('deepen ')) {
          const n = parseInt(line.slice(7).trim(), 10);
          if (Number.isFinite(n) && n > 0) depth = n;
        }
      }
      const { oids, shallow } = collectReachableObjects(
        wants,
        haves,
        depth,
        (oid) => repo.objects.get(oid),
        clientShallows,
      );
      const pack = buildPack(oids, (oid) => repo.objects.get(oid));
      const parts: Buffer[] = [];
      if (shallow.length > 0) {
        for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
        parts.push(FLUSH_PKT);
      }
      parts.push(pktLine('NAK\n'));
      if (useSideBand) {
        parts.push(wrapSideBand(1, pack));
        parts.push(FLUSH_PKT);
      } else {
        parts.push(pack);
      }
      sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
      return true;
    }

    if (method === 'POST' && subPath === '/git-receive-pack') {
      const body = await readRawBody(req);
      const { items, rest } = parsePktStream(body);
      interface PushCmd {
        oldOid: string;
        newOid: string;
        ref: string;
      }
      const cmds: PushCmd[] = [];
      let useSideBand = false;
      for (const item of items) {
        if (item.type === 'flush') break;
        if (item.type !== 'data') continue;
        const raw = item.data.toString('utf8').replace(/\r?\n$/, '');
        const [line, capsStr] = raw.split('\0');
        if (capsStr && capsStr.includes('side-band-64k')) useSideBand = true;
        const [oldOid, newOid, ref] = line.trim().split(/\s+/);
        if (oldOid && newOid && ref) cmds.push({ oldOid, newOid, ref });
      }

      let staged = new Map<string, ReturnType<typeof repo.objects.get> & object>();
      if (rest.length > 0) {
        try {
          staged = parsePack(rest, repo.objects) as typeof staged;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unpack failed';
          const report = Buffer.concat([pktLine(`unpack ${msg}\n`), FLUSH_PKT]);
          const payload = useSideBand ? Buffer.concat([wrapSideBand(1, report), FLUSH_PKT]) : report;
          sendBytes(res, 200, 'application/x-git-receive-pack-result', payload);
          return true;
        }
      }

      const lookup = (oid: string) => staged.get(oid) ?? repo.objects.get(oid);
      const reportLines: Buffer[] = [pktLine('unpack ok\n')];
      let anySuccess = false;

      for (const cmd of cmds) {
        const current = repo.refs.get(cmd.ref);
        if (cmd.newOid === ZERO_OID) {
          if (current === undefined) {
            reportLines.push(pktLine(`ng ${cmd.ref} missing ref\n`));
          } else if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) {
            reportLines.push(pktLine(`ng ${cmd.ref} stale old oid\n`));
          } else {
            repo.refs.delete(cmd.ref);
            reportLines.push(pktLine(`ok ${cmd.ref}\n`));
            anySuccess = true;
          }
        } else if (cmd.oldOid === ZERO_OID) {
          if (current !== undefined) {
            reportLines.push(pktLine(`ng ${cmd.ref} already exists\n`));
          } else if (!lookup(cmd.newOid)) {
            reportLines.push(pktLine(`ng ${cmd.ref} missing object\n`));
          } else {
            repo.refs.set(cmd.ref, cmd.newOid);
            reportLines.push(pktLine(`ok ${cmd.ref}\n`));
            anySuccess = true;
          }
        } else {
          if (current !== cmd.oldOid) {
            reportLines.push(pktLine(`ng ${cmd.ref} stale old oid\n`));
          } else if (!lookup(cmd.newOid)) {
            reportLines.push(pktLine(`ng ${cmd.ref} missing object\n`));
          } else if (!isAncestor(cmd.oldOid, cmd.newOid, lookup)) {
            reportLines.push(pktLine(`ng ${cmd.ref} non-fast-forward\n`));
          } else {
            repo.refs.set(cmd.ref, cmd.newOid);
            reportLines.push(pktLine(`ok ${cmd.ref}\n`));
            anySuccess = true;
          }
        }
      }

      if (anySuccess) {
        for (const [oid, obj] of staged) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      }

      reportLines.push(FLUSH_PKT);
      const report = Buffer.concat(reportLines);
      const payload = useSideBand ? Buffer.concat([wrapSideBand(1, report), FLUSH_PKT]) : report;
      sendBytes(res, 200, 'application/x-git-receive-pack-result', payload);
      return true;
    }

    sendJsonError(res, 404, 'Not Found');
    return true;
  };
}
