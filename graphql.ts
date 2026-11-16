import type {IncomingMessage, ServerResponse} from 'node:http';

/** Shared-state port: dispatch to the same REST/store operations used by rest.ts. */
export interface ApiReply {status: number; body: any}
export interface ForgeApi {
  request(method: string, path: string, body?: unknown): ApiReply | Promise<ApiReply>;
}
export interface ProtocolOptions {token?: string}
type Selection = {name: string; alias: string; args: any; children: Selection[]; spread?: string; condition?: string; directives: any[]};
type Operation = {kind: string; name: string; children: Selection[]; defaults: any};
type Ref = {type: string; owner: string; repo: string; number?: number};
type Node = {type: string; raw: any; owner?: string; repo?: string; number?: number};
const enc = encodeURIComponent;
const node = (type: string, raw: any, extra: any = {}): Node => ({type, raw, ...extra});

export function sendProtocolJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body) + '\n');
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':bytes.length});
  res.end(bytes);
}
export function protocolAuthorized(req: IncomingMessage, token: string): boolean {
  return token.length > 0 && req.headers.authorization === 'Bearer ' + token;
}
export async function readProtocolBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 8_388_608) throw new Error('Request body exceeds 8 MiB');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** A small real GraphQL selection parser; no operation-name or fixture-name matching. */
class Parser {
  tokens: string[] = []; pos = 0;
  fragments = new Map<string, {condition: string; children: Selection[]}>();
  constructor(text: string) {
    const pattern = /\s+|#[^\r\n]*|,|\.\.\.|"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{}|]/gy;
    let at = 0;
    while (at < text.length) {
      pattern.lastIndex = at; const match = pattern.exec(text);
      if (!match) throw new Error('Invalid GraphQL syntax at character ' + at);
      at = pattern.lastIndex;
      if (!/^(?:\s|#|,)/.test(match[0])) this.tokens.push(match[0]);
      if (this.tokens.length > 20_000) throw new Error('GraphQL document is too large');
    }
  }
  peek() {return this.tokens[this.pos];}
  take(wanted?: string): string {
    const value = this.tokens[this.pos++];
    if (value === undefined || (wanted !== undefined && value !== wanted)) throw new Error('Expected ' + (wanted || 'token'));
    return value;
  }
  name(): string {const v = this.take(); if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(v)) throw new Error('Expected name'); return v;}
  value(depth = 0): any {
    if (depth > 64) throw new Error('GraphQL input is too deep');
    const t = this.peek();
    if (t === '$') {this.take(); return {$variable:this.name()};}
    if (t === '[') {this.take(); const a = []; while (this.peek() !== ']') a.push(this.value(depth+1)); this.take(']'); return a;}
    if (t === '{') {this.take(); const o = Object.create(null); while (this.peek() !== '}') {const k=this.name();this.take(':');o[k]=this.value(depth+1);}this.take('}');return o;}
    this.take();
    if (t.startsWith('"') || /^(?:-?\d|true$|false$|null$)/.test(t)) return JSON.parse(t);
    if (/^[_A-Za-z]/.test(t)) return t;
    throw new Error('Invalid GraphQL value');
  }
  args(): any {
    const args = Object.create(null);
    if (this.peek() === '(') {this.take();while(this.peek()!==')'){const k=this.name();this.take(':');args[k]=this.value();}this.take(')');}
    return args;
  }
  directives(): any[] {const d=[];while(this.peek()==='@'){this.take();d.push({name:this.name(),args:this.args()});}return d;}
  selection(depth = 0): Selection[] {
    if(depth>64) throw new Error('GraphQL selection is too deep');
    this.take('{');const fields: Selection[]=[];
    while(this.peek()!=='}') {
      if(this.peek()==='...') {
        this.take();const name=this.name();
        if(name==='on'){const condition=this.name(),directives=this.directives();fields.push({name:'',alias:'',args:{},condition,directives,children:this.selection(depth+1)});}
        else fields.push({name:'',alias:'',args:{},spread:name,directives:this.directives(),children:[]});
        continue;
      }
      const alias=this.name();let name=alias;if(this.peek()===':'){this.take();name=this.name();}
      const args=this.args(),directives=this.directives();
      fields.push({name,alias,args,directives,children:this.peek()==='{'?this.selection(depth+1):[]});
    }
    this.take('}');return fields;
  }
  document(): Operation[] {
    const operations: Operation[]=[];
    while(this.pos<this.tokens.length) {
      if(this.peek()==='fragment'){this.take();const name=this.name();this.take('on');const condition=this.name();this.directives();this.fragments.set(name,{condition,children:this.selection()});continue;}
      let kind='query',name='';const defaults=Object.create(null);
      if(this.peek()!=='{') {
        kind=this.take();if(!['query','mutation'].includes(kind))throw new Error('Unsupported operation');
        if(this.peek()!=='(' && this.peek()!=='{' && this.peek()!=='@')name=this.name();
        if(this.peek()==='('){this.take();while(this.peek()!==')'){
          this.take('$');const key=this.name();this.take(':');
          while(this.peek() && !['=','$',')'].includes(this.peek()))this.take();
          if(this.peek()==='='){this.take();defaults[key]=this.value();}
        }this.take(')');}
      }
      this.directives();operations.push({kind,name,defaults,children:this.selection()});
    }
    return operations;
  }
}
const schema: Record<string, Record<string,string|null>> = {
  Query:{viewer:'User',repository:'Repository',node:'Node',__type:'__Type'},
  Mutation:{createIssue:'IssuePayload',closeIssue:'IssuePayload',createPullRequest:'PullPayload',mergePullRequest:'PullPayload',addComment:'CommentPayload'},
  User:{login:null},Repository:{id:null,databaseId:null,name:null,nameWithOwner:null,owner:'User',defaultBranchRef:'Ref',viewerPermission:null,hasIssuesEnabled:null,issue:'Issue',issues:'IssueConnection',pullRequests:'PullConnection',pullRequest:'PullRequest'},
  Ref:{name:null},Issue:{id:null,number:null,title:null,body:null,state:null},
  PullRequest:{id:null,number:null,title:null,body:null,state:null,merged:null,headRefName:null,baseRefName:null,mergeable:null,files:'FileConnection'},
  IssueConnection:{nodes:'Issue',pageInfo:'PageInfo'},PullConnection:{nodes:'PullRequest'},FileConnection:{nodes:'File'},File:{path:null},
  PageInfo:{hasNextPage:null,endCursor:null},IssuePayload:{issue:'Issue'},PullPayload:{pullRequest:'PullRequest'},
  CommentPayload:{commentEdge:'CommentEdge'},CommentEdge:{node:'Comment'},Comment:{id:null,body:null},
  Node:{id:null},__Type:{name:null,kind:null,fields:'__Field',enumValues:'__EnumValue'},__Field:{name:null},__EnumValue:{name:null},
};
const enums: Record<string,string[]> = {IssueState:['OPEN','CLOSED'],PullRequestState:['OPEN','CLOSED','MERGED'],MergeableState:['MERGEABLE','CONFLICTING','UNKNOWN'],PullRequestMergeMethod:['MERGE','SQUASH','REBASE'],RepositoryPermission:['ADMIN','MAINTAIN','WRITE','TRIAGE','READ'],SearchType:['ISSUE','REPOSITORY','USER'],IssueOrderField:['CREATED_AT','UPDATED_AT','COMMENTS'],OrderDirection:['ASC','DESC']};
function values(value:any,variables:any):any {
  if(Array.isArray(value))return value.map(v=>values(v,variables));
  if(value && typeof value==='object') {
    if(Object.hasOwn(value,'$variable'))return variables[value.$variable];
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,values(v,variables)]));
  }return value;
}

export function createGraphQLExecutor(api: ForgeApi) {
  const ids=new Map<string,Ref>();
  const path=(owner:string,repo:string)=>'/api/v3/repos/'+enc(owner)+'/'+enc(repo);
  async function rest(method:string,url:string,body?:unknown,nullable=false):Promise<any> {
    const reply=await api.request(method,url,body);
    if(nullable && reply.status===404)return null;
    if(reply.status<200 || reply.status>=300)throw new Error(reply.body?.message || 'REST operation refused: '+reply.status);
    return reply.body;
  }
  async function listAll(url:string):Promise<any[]> {
    const out:any[]=[],seen=new Set<string>();
    for(let page=1;page<=1000;page++) {
      const batch=await rest('GET',url+(url.includes('?')?'&':'?')+'per_page=100&page='+page);
      if(!Array.isArray(batch))throw new Error('REST list operation must return an array');
      let added=0;
      for(const item of batch){const key=String(item.node_id??item.id??item.number??JSON.stringify(item));if(!seen.has(key)){seen.add(key);out.push(item);added++;}}
      if(batch.length<100 || added===0)return out;
    }
    throw new Error('REST pagination exceeds the supported result budget');
  }
  function identify(n:Node):string {
    const ref={type:n.type,owner:n.owner||n.raw.owner?.login,repo:n.repo||n.raw.name,number:n.number??n.raw.number};
    const id=n.raw.node_id || Buffer.from(JSON.stringify([ref.type,ref.owner,ref.repo,ref.number??null,n.raw.id])).toString('base64');
    ids.set(id,ref);return id;
  }
  function wrap(type:string,raw:any,owner:string,repo:string):Node|null {if(raw==null)return null;const n=node(type,raw,{owner,repo,number:raw.number});identify(n);return n;}
  async function byId(id:string):Promise<Node|null> {
    let ref=ids.get(id);
    if(!ref)try{const [type,owner,repo,number]=JSON.parse(Buffer.from(id,'base64').toString('utf8'));if(['Repository','Issue','PullRequest'].includes(type))ref={type,owner,repo,number};}catch{}
    if(!ref)return null;
    const url=path(ref.owner,ref.repo)+(ref.type==='Repository'?'':(ref.type==='Issue'?'/issues/':'/pulls/')+ref.number);
    const found=wrap(ref.type,await rest('GET',url,undefined,true),ref.owner,ref.repo);
    return found && identify(found)===id?found:null;
  }
  function expand(fields:Selection[],type:string,fragments:Parser['fragments'],depth=0):Selection[] {
    if(depth>64)throw new Error('Fragment cycle or excessive depth');
    return fields.flatMap(f=>{
      if(f.spread){const def=fragments.get(f.spread);if(!def)throw new Error('Unknown fragment '+f.spread);return type===def.condition?expand(def.children,type,fragments,depth+1).map(child=>({...child,directives:[...f.directives,...child.directives]})):[];}
      if(f.condition)return type===f.condition?expand(f.children,type,fragments,depth+1).map(child=>({...child,directives:[...f.directives,...child.directives]})):[];
      return [f];
    });
  }
  function validate(fields:Selection[],type:string,fragments:Parser['fragments'],depth=0) {
    if(depth>64)throw new Error('Selection depth exceeded');
    for(const field of fields) {
      if(field.spread){const def=fragments.get(field.spread);if(!def)throw new Error('Unknown fragment '+field.spread);validate(def.children,def.condition,fragments,depth+1);continue;}
      if(field.condition){validate(field.children,field.condition,fragments,depth+1);continue;}
      if(field.name==='__typename')continue;
      if(!Object.hasOwn(schema[type]||{},field.name))throw new Error('Cannot query field "'+field.name+'" on type "'+type+'"');
      const child=schema[type][field.name];
      if(child && field.children.length)validate(field.children,child,fragments,depth+1);
      if(!child && field.children.length)throw new Error('Scalar field '+field.name+' has no selection');
    }
  }
  async function resolve(n:Node,name:string,a:any):Promise<any> {
    const r=n.raw,owner=n.owner||r.owner?.login,repo=n.repo||r.name;
    const base=()=>path(owner,repo);
    if(name==='__typename')return n.type;
    if(n.type==='Query') {
      if(name==='viewer')return node('User',await rest('GET','/api/v3/user'));
      if(name==='repository')return wrap('Repository',await rest('GET',path(a.owner,a.name),undefined,true),a.owner,a.name);
      if(name==='node')return byId(String(a.id));
      if(name==='__type')return schema[a.name]||enums[a.name]?node('__Type',{name:a.name}):null;
    }
    if(n.type==='Mutation') {
      const input=a.input||{};
      if(name==='createIssue'||name==='createPullRequest') {
        const repository=await byId(String(input.repositoryId));if(repository?.type!=='Repository')throw new Error('Unknown repositoryId');
        const root=path(repository.owner!,repository.repo!);
        if(name==='createIssue'){const raw=await rest('POST',root+'/issues',{title:input.title,body:input.body??''});return node('IssuePayload',{issue:wrap('Issue',raw,repository.owner!,repository.repo!)});}
        const raw=await rest('POST',root+'/pulls',{title:input.title,body:input.body??'',head:input.headRefName,base:input.baseRefName});
        return node('PullPayload',{pullRequest:wrap('PullRequest',raw,repository.owner!,repository.repo!)});
      }
      const target=await byId(String(input.issueId??input.pullRequestId??input.subjectId));if(!target)throw new Error('Unknown node id');
      const root=path(target.owner!,target.repo!);
      if(name==='closeIssue')return node('IssuePayload',{issue:wrap('Issue',await rest('PATCH',root+'/issues/'+target.number,{state:'closed'}),target.owner!,target.repo!)});
      if(name==='mergePullRequest'){
        await rest('PUT',root+'/pulls/'+target.number+'/merge',{merge_method:String(input.mergeMethod||'SQUASH').toLowerCase()});
        return node('PullPayload',{pullRequest:wrap('PullRequest',await rest('GET',root+'/pulls/'+target.number),target.owner!,target.repo!)});
      }
      if(name==='addComment'){
        const comment=await rest('POST',root+'/issues/'+target.number+'/comments',{body:input.body});
        return node('CommentPayload',{commentEdge:node('CommentEdge',{node:node('Comment',{...comment,id:comment.node_id||Buffer.from('Comment:'+comment.id).toString('base64')})})});
      }
    }
    if(n.type==='Repository') {
      if(name==='id')return identify(n);
      if(name==='databaseId')return r.id;
      if(name==='nameWithOwner')return r.full_name||owner+'/'+repo;
      if(name==='owner')return node('User',{login:owner});
      if(name==='defaultBranchRef')return node('Ref',{name:r.default_branch||'main'});
      if(name==='viewerPermission')return 'ADMIN';
      if(name==='hasIssuesEnabled')return r.has_issues!==false;
      if(name==='issue')return wrap('Issue',await rest('GET',base()+'/issues/'+a.number,undefined,true),owner,repo);
      if(name==='pullRequest')return wrap('PullRequest',await rest('GET',base()+'/pulls/'+a.number,undefined,true),owner,repo);
      if(name==='pullRequests') {
        const list=await listAll(base()+'/pulls?state=all');
        return node('PullConnection',{nodes:list.slice(0,Math.max(0,Math.min(a.first??100,100))).map((v:any)=>wrap('PullRequest',v,owner,repo))});
      }
      if(name==='issues') {
        let list=await listAll(base()+'/issues?state=all');
        list=list.filter((v:any)=>!v.pull_request && (!a.states||a.states.includes(String(v.state).toUpperCase())));
        const field=a.orderBy?.field==='UPDATED_AT'?'updated_at':a.orderBy?.field==='COMMENTS'?'comments':'created_at';
        const dir=a.orderBy?.direction==='ASC'?1:-1;
        list.sort((x:any,y:any)=>dir*((typeof x[field]==='number'?x[field]-y[field]:String(x[field]??'').localeCompare(String(y[field]??'')))||x.number-y.number));
        let offset=0;
        if(a.after!=null){const cursor=Buffer.from(String(a.after),'base64').toString('utf8');if(!/^issue-offset:\d+$/.test(cursor))throw new Error('Invalid issue cursor');offset=Number(cursor.slice(13));}
        const first=Math.max(0,Math.min(a.first??100,100)),end=Math.min(offset+first,list.length);
        return node('IssueConnection',{nodes:list.slice(offset,end).map((v:any)=>wrap('Issue',v,owner,repo)),pageInfo:node('PageInfo',{hasNextPage:end<list.length,endCursor:end>offset?Buffer.from('issue-offset:'+end).toString('base64'):null})});
      }
    }
    if(n.type==='Issue'||n.type==='PullRequest') {
      if(name==='id')return identify(n);
      if(name==='state')return n.type==='PullRequest'&&r.merged?'MERGED':String(r.state).toUpperCase();
      if(name==='headRefName')return r.head?.ref??r.headRefName;
      if(name==='baseRefName')return r.base?.ref??r.baseRefName;
      if(name==='merged')return r.merged===true;
      if(name==='mergeable')return r.mergeable===true?'MERGEABLE':r.mergeable===false?'CONFLICTING':'UNKNOWN';
      if(name==='files'){const files=await rest('GET',base()+'/pulls/'+n.number+'/files');return node('FileConnection',{nodes:files.slice(0,a.first??100).map((f:any)=>node('File',{path:f.filename??f.path}))});}
    }
    if(n.type==='__Type') {
      if(name==='kind')return enums[r.name]?'ENUM':'OBJECT';
      if(name==='fields')return Object.keys(schema[r.name]||{}).map(name=>node('__Field',{name}));
      if(name==='enumValues')return (enums[r.name]||[]).map(name=>node('__EnumValue',{name}));
    }
    return r[name]??null;
  }
  async function project(n:any,fields:Selection[],variables:any,fragments:Parser['fragments']):Promise<any> {
    if(n==null)return null;
    if(Array.isArray(n)){const out=[];for(const v of n)out.push(await project(v,fields,variables,fragments));return out;}
    const result=Object.create(null);
    for(const f of expand(fields,n.type,fragments)) {
      if(f.directives.some(d=>{const v=values(d.args,variables).if;return d.name==='skip'?v===true:d.name==='include'?v===false:false;}))continue;
      const value=await resolve(n,f.name,values(f.args,variables));
      result[f.alias]=f.children.length?await project(value,f.children,variables,fragments):value;
    }
    return result;
  }
  async function one(document:any) {
    try {
      if(!document || typeof document.query!=='string')throw new Error('query must be a string');
      const parser=new Parser(document.query),ops=parser.document();
      const op=document.operationName?ops.find(o=>o.name===document.operationName):ops.length===1?ops[0]:undefined;
      if(!op)throw new Error('Select a single operation with operationName');
      const type=op.kind==='mutation'?'Mutation':'Query';validate(op.children,type,parser.fragments);
      return {data:await project(node(type,{}),op.children,{...op.defaults,...(document.variables||{})},parser.fragments)};
    }catch(error){return {errors:[{message:error instanceof Error?error.message:'GraphQL operation failed'}]};}
  }
  return async (body:any):Promise<any>=>{if(!Array.isArray(body))return one(body);const out=[];for(const op of body)out.push(await one(op));return out;};
}

export function createGraphQLHandler(api: ForgeApi, options: ProtocolOptions = {}) {
  const execute=createGraphQLExecutor(api),token=options.token??process.env.MAKEFUN_SHOP_TOKEN??'';
  return async (req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    if(new URL(req.url||'/','http://forge').pathname!=='/api/graphql')return false;
    if(!protocolAuthorized(req,token)){sendProtocolJson(res,401,{message:'Requires authentication'});return true;}
    if(req.method!=='POST'){sendProtocolJson(res,405,{message:'Method Not Allowed'});return true;}
    let body;try{body=await readProtocolBody(req);}catch{sendProtocolJson(res,400,{errors:[{message:'Invalid JSON request body'}]});return true;}
    sendProtocolJson(res,200,await execute(body));return true;
  };
}
