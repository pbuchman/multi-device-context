import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, NativeFile } from '@mdc/contracts';
declare const MDC_APP_ORIGIN:string;
async function invoke<T>(method:string,...args:unknown[]):Promise<T> {
 const result=await ipcRenderer.invoke(`mdc:${method}`,...args) as {ok:true;value:T}|{ok:false;message:string};
 if(!result.ok) throw new Error(result.message);
 return result.value;
}
if(process.isMainFrame && location.origin===MDC_APP_ORIGIN) {
 const bridge:DesktopBridge={
  version:1,platform:process.platform as DesktopBridge['platform'],
  getDevice:()=>invoke('getDevice'),getAccessToken:(interactive=false)=>invoke('getAccessToken',interactive),signOut:()=>invoke('signOut'),
  readClipboard:()=>invoke('readClipboard'),copyText:(text:string)=>invoke('copyText',text),copyFile:(file:NativeFile)=>invoke('copyFile',file),saveFile:(file:NativeFile)=>invoke('saveFile',file),
  getLaunchAtLogin:()=>invoke('getLaunchAtLogin'),setLaunchAtLogin:(enabled:boolean)=>invoke('setLaunchAtLogin',enabled),
  getPendingClipboardShares:()=>invoke('getPendingClipboardShares'),acknowledgeClipboardShare:(id:string)=>invoke('acknowledgeClipboardShare',id),
  onShareClipboard:listener=>{const notify=()=>listener();ipcRenderer.on('mdc:shareClipboard',notify);return ()=>ipcRenderer.removeListener('mdc:shareClipboard',notify);},
 };
 contextBridge.exposeInMainWorld('contextDesktop',bridge);
} else if(process.isMainFrame && location.protocol==='file:') {
 contextBridge.exposeInMainWorld('contextRecovery',{retry:()=>invoke('retry')});
}
