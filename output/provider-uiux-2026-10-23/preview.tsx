// Isolated production SettingsDialog verification. Synthetic requests; no secrets or product storage writes. Optional persistence uses an isolated test sessionStorage key.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "/src/components/settings/SettingsDialog";
import { LocaleProvider } from "/src/i18n/LocaleContext";
import { project } from "/src/exported-project";
import { restoreProviderSettings, serializeProviderSettings } from "/src/runtime/providerSettings";
import { createProviderConnection } from "/src/schema/agentuxConfig";
import { applyTheme } from "/src/theme/applyTheme";
import { themeTokens } from "/src/theme/themeTokens";
import "/src/styles/app.css";
import "/src/styles/agentmatrix.css";
const params = new URLSearchParams(location.search);
applyTheme(themeTokens[params.has("dark") ? "warm-graphite" : "soft-glass"]);
const gemini = createProviderConnection("gemini", true);
let requests = 0;
window.fetch = async () => {
  const ordinal = ++requests;
  if (params.has("slow")) await new Promise(resolve => setTimeout(resolve, 8000));
  return new Response(JSON.stringify({ ok: true, latencyMs: 1171, models: Array.from({length:60}, (_,i) => `probe-${ordinal}-model-${i+1}`) }), {headers:{"content-type":"application/json"}});
};
const baseProviders={...project.providers, defaultProviderId:"deepseek", connections:[gemini,createProviderConnection("deepseek",true),createProviderConnection("openai",false)]};
function Check() {
  const [config, setConfig] = useState({...project,providers:params.has("persist")?restoreProviderSettings(baseProviders,sessionStorage.getItem("raytonebot.provider-uiux-verification")):baseProviders});
  const [keys,setKeys]=useState({}); const [open,setOpen]=useState(true); const [saves,setSaves]=useState(0); const [failing,setFailing]=useState(params.has("fail"));
  return <LocaleProvider initialLocale="zh">
    <button onClick={()=>setOpen(true)}>打开设置</button><button onClick={()=>setFailing(v=>!v)}>保存失败模拟：{failing?"开启":"关闭"}</button><output>成功保存 {saves} 次</output>
    <output aria-label="Saved test configuration">{config.providers.connections.map(p=>`${p.label}: ${p.enabled?"开启":"停用"} ${p.defaultModel}`).join(" | ")}；默认：{config.providers.defaultProviderId}</output>
    <SettingsDialog open={open} onOpenChange={setOpen} project={config} sessionKeys={keys} isRunning={params.has("running")}
      onSaveProviders={async (providers, nextKeys)=>{await new Promise(resolve=>setTimeout(resolve,500)); if(failing) {setFailing(false); throw new Error("Simulated storage failure");} if(params.has("persist")) sessionStorage.setItem("raytonebot.provider-uiux-verification",serializeProviderSettings(baseProviders,providers)); setConfig(current=>({...current,providers})); setKeys(nextKeys); setSaves(n=>n+1);}}
      themePreset="soft-glass" onThemeChange={id=>applyTheme(themeTokens[id])} onPermissionDefaultChange={()=>{}}
      onSessionKeyChange={(id,value)=>setKeys(current=>({...current,[id]:value}))}
      onUpdateProvider={(id,patch)=>setConfig(current=>({...current,providers:{...current.providers,connections:current.providers.connections.map(p=>p.id!==id?p:{...p,...patch,auth:patch.authEnvVar!==undefined?{...p.auth,envVar:patch.authEnvVar}:p.auth})}}))}
      onSetDefaultProvider={id=>setConfig(current=>({...current,providers:{...current.providers,defaultProviderId:id}}))}
    />
  </LocaleProvider>;
}
createRoot(document.getElementById("root")).render(<Check/>);
