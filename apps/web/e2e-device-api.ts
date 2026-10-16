import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
// Relative source import lets Vite bundle TypeScript for the Node 22.12 config runtime.
import { AccessActionSchema, DeviceRenameSchema, type AccessDevice, type AccessAction } from "../../packages/contracts/src/index.ts";

/** Dev-server-only synthetic HTTP state. Never installed on production API paths. */
export function deviceFixtureMiddleware() {
 const initial: AccessDevice[] = [
  {id:"00000000-0000-4000-8000-000000000010",name:"Dell Pro",platform:"desktop",mode:"all",version:1,createdAt:1,updatedAt:1},
  {id:"00000000-0000-4000-8000-000000000011",name:"MacBook Pro",platform:"desktop",mode:"own",version:1,createdAt:1,updatedAt:1},
  {id:"00000000-0000-4000-8000-000000000012",name:"Chrome on Android",platform:"android",mode:"own",version:1,createdAt:1,updatedAt:1},
 ];
 let devices=structuredClone(initial), failNext=false;
 const challenges=new Map<string,AccessAction>();
 return async (req:IncomingMessage,res:ServerResponse,next:()=>void) => {
  const path=req.url?.split("?")[0];
  if (!path?.startsWith("/__e2e/api/")) {next();return;}
  const send=(status:number,value:unknown)=>{res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(value));};
  const body=async()=>{let raw="";for await(const chunk of req){raw+=chunk;if(raw.length>16384)throw new Error("Too large");}return JSON.parse(raw||"{}");};
  try {
   if(req.method==="POST"&&path==="/__e2e/api/reset"){devices=structuredClone(initial);challenges.clear();failNext=false;send(200,{});return;}
   if(req.method==="POST"&&path==="/__e2e/api/fail-next"){failNext=true;send(200,{});return;}
   if(req.method==="GET"&&path==="/__e2e/api/device"){send(200,devices[0]);return;}
   if(req.method==="GET"&&path==="/__e2e/api/access/status"){send(200,{passkeyRegistered:true});return;}
   if(req.method==="GET"&&path==="/__e2e/api/access/devices"){send(200,devices);return;}
   if(req.method==="GET"&&path==="/__e2e/api/access/agent-keys"){send(200,[]);return;}
   if(req.method==="PATCH"&&path==="/__e2e/api/device"){
    const {name}=DeviceRenameSchema.parse(await body());
    if(failNext){failNext=false;send(503,{});return;}
    devices[0]={...devices[0]!,name,updatedAt:Date.now()};send(200,devices[0]);return;
   }
   if(req.method==="POST"&&path==="/__e2e/api/access/challenges"){
    const action=AccessActionSchema.parse(await body());const challengeId=randomUUID();challenges.set(challengeId,action);send(200,{challengeId,options:{challenge:"synthetic-passkey"}});return;
   }
   const match=path.match(/^\/__e2e\/api\/access\/challenges\/([^/]+)\/complete$/);
   if(req.method==="POST"&&match){
    await body();const action=challenges.get(match[1]!);challenges.delete(match[1]!);
    if(!action||!("targetId"in action)){send(400,{});return;}
    const index=devices.findIndex(device=>device.id===action.targetId);if(index<0){send(404,{});return;}
    const current=devices[index]!;
    if(action.action==="rename-device")devices[index]={...current,name:action.name,updatedAt:Date.now()};
    else if(action.action==="set-device-access"&&action.expectedVersion===current.version)devices[index]={...current,mode:action.mode,version:current.version+1,updatedAt:Date.now()};
    else {send(409,{});return;}
    send(200,{kind:"device",device:devices[index]});return;
   }
   send(404,{});
  }catch{send(400,{});}
 };
}
