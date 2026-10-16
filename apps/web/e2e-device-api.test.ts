import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { deviceFixtureMiddleware } from "./e2e-device-api.js";
const close: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const stop of close.splice(0))await stop();});
it("persists fixture names over HTTP without changing access grants and isolates current-device renames",async()=>{
 const middleware=deviceFixtureMiddleware();const server=createServer((req,res)=>void middleware(req,res,()=>{res.writeHead(404).end();}));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));close.push(()=>new Promise(resolve=>server.close(()=>resolve())));
 const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}/__e2e/api`;
 const before=await (await fetch(`${url}/device`)).json();
 const response=await fetch(`${url}/device`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name:" Saved alias "})});expect(response.status).toBe(200);
 const saved=await response.json();expect(saved).toMatchObject({...before,name:"Saved alias",updatedAt:expect.any(Number)});
 expect(await (await fetch(`${url}/device`)).json()).toEqual(saved);
 const all=await (await fetch(`${url}/access/devices`)).json();expect(all[1].name).toBe("MacBook Pro");
 expect((await fetch(`${url}/device`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name:" "})})).status).toBe(400);
});
