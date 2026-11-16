import type {IncomingMessage,ServerResponse} from 'node:http';
import {protocolAuthorized,readProtocolBody,sendProtocolJson,type ForgeApi,type ProtocolOptions} from './graphql.ts';

const string={type:'string'},nonempty={type:'string',minLength:1},integer={type:'integer',minimum:1};
const tool=(name:string,description:string,properties:any,required:string[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const ownerRepo={owner:nonempty,repo:nonempty};
/** Stable order and schema bytes across requests; state lives exclusively in ForgeApi. */
const tools=[
  tool('create_repo','Create a repository for the authenticated user.',{name:nonempty,description:string,private:{type:'boolean'}},['name']),
  tool('get_repo','Read a repository and its stable identifiers.',ownerRepo,['owner','repo']),
  tool('create_issue','Create an issue in a repository.',{...ownerRepo,title:nonempty,body:string},['owner','repo','title']),
  tool('list_issues','List repository issues, optionally filtered by state.',{...ownerRepo,state:{type:'string',enum:['open','closed','all']}},['owner','repo']),
  tool('create_pull_request','Open a pull request between repository branches.',{...ownerRepo,title:nonempty,body:string,head:nonempty,base:nonempty},['owner','repo','title','head','base']),
  tool('merge_pull_request','Merge a pull request using the requested merge method.',{...ownerRepo,pull_number:integer,merge_method:{type:'string',enum:['merge','squash','rebase']}},['owner','repo','pull_number']),
];
const info={name:'stdlib-forge',version:'1.0.0'};
const discovery={serverInfo:info,capabilities:{tools:{}},supportedVersions:['2026-07-28','2025-11-25']};
const enc=encodeURIComponent;
const rpcError=(id:any,code:number,message:string)=>({jsonrpc:'2.0',id:id??null,error:{code,message}});
export function createMcpExecutor(api: ForgeApi) {
  return async (request:any):Promise<{status:number;body:any}>=>{
    if(!request || request.jsonrpc!=='2.0' || typeof request.method!=='string' || (request.id!==undefined && request.id!==null && typeof request.id!=='string' && typeof request.id!=='number'))return {status:400,body:rpcError(request?.id,-32600,'Invalid Request')};
    const {method,id,params={}}=request;
    if(!Object.hasOwn(request,'id'))return {status:202,body:null};
    if(params===null || typeof params!=='object' || Array.isArray(params))return {status:200,body:rpcError(id,-32602,'Params must be an object')};
    const answer=(result:any)=>({status:200,body:{jsonrpc:'2.0',id,result}});
    if(method==='server/discover')return answer(discovery);
    if(method==='initialize')return answer({protocolVersion:'2025-11-25',serverInfo:info,capabilities:{tools:{}}});
    if(method==='ping')return answer({});
    if(method==='tools/list')return answer({tools});
    if(method!=='tools/call')return {status:200,body:rpcError(id,-32601,'Method not found')};
    const spec=tools.find(t=>t.name===params.name);
    if(!spec)return {status:200,body:rpcError(id,-32602,'Unknown tool')};
    const args=params.arguments;
    if(!args || typeof args!=='object' || Array.isArray(args))return {status:200,body:rpcError(id,-32602,'Tool arguments must be an object')};
    for(const key of spec.inputSchema.required)if(!Object.hasOwn(args,key))return {status:200,body:rpcError(id,-32602,'Missing required argument '+key)};
    for(const [key,value] of Object.entries(args)) {
      const field=spec.inputSchema.properties[key];
      if(!field || (field.type==='string' && (typeof value!=='string' || value.length<(field.minLength??0))) || (field.type==='boolean' && typeof value!=='boolean') || (field.type==='integer' && (!Number.isInteger(value)||Number(value)<1)) || (field.enum && !field.enum.includes(value)))return {status:200,body:rpcError(id,-32602,'Invalid argument '+key)};
    }
    let verb='GET',path='/api/v3/repos/'+enc(args.owner||'')+'/'+enc(args.repo||''),body:any;
    switch(spec.name) {
      case 'create_repo':verb='POST';path='/api/v3/user/repos';body={name:args.name,description:args.description??'',private:args.private??false};break;
      case 'create_issue':verb='POST';path+='/issues';body={title:args.title,body:args.body??''};break;
      case 'list_issues':path+='/issues?state='+enc(args.state||'open')+'&per_page=100';break;
      case 'create_pull_request':verb='POST';path+='/pulls';body={title:args.title,body:args.body??'',head:args.head,base:args.base};break;
      case 'merge_pull_request':verb='PUT';path+='/pulls/'+args.pull_number+'/merge';body={merge_method:args.merge_method||'squash'};break;
    }
    try {
      const reply=await api.request(verb,path,body);
      const failed=reply.status<200||reply.status>=300;
      return answer({content:[{type:'text',text:JSON.stringify(reply.body)}],...(reply.body && typeof reply.body==='object' && !Array.isArray(reply.body)?{structuredContent:reply.body}:{}),isError:failed});
    }catch{return answer({content:[{type:'text',text:'Store operation failed'}],isError:true});}
  };
}

export function createMcpHandler(api: ForgeApi, options: ProtocolOptions = {}) {
  const execute=createMcpExecutor(api),token=options.token??process.env.MAKEFUN_SHOP_TOKEN??'';
  return async(req:IncomingMessage,res:ServerResponse):Promise<boolean>=>{
    if(new URL(req.url||'/','http://forge').pathname!=='/mcp')return false;
    if(!protocolAuthorized(req,token)){sendProtocolJson(res,401,{message:'Requires authentication'});return true;}
    if(req.method!=='POST'){sendProtocolJson(res,405,{message:'Method Not Allowed'});return true;}
    let body;try{body=await readProtocolBody(req);}catch{sendProtocolJson(res,400,rpcError(null,-32700,'Parse error'));return true;}
    const result=await execute(body);
    if(result.status===202){res.writeHead(202);res.end();}else sendProtocolJson(res,result.status,result.body);
    return true;
  };
}
