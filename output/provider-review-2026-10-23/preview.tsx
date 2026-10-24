// Isolated production SettingsDialog verification. All requests are synthetic, no secrets or storage writes.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "/src/components/settings/SettingsDialog";
import { LocaleProvider } from "/src/i18n/LocaleContext";
import { project } from "/src/exported-project";
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
function Check() {
  const [config, setConfig] = useState({...project, providers:{...project.providers, defaultProviderId:"deepseek", connections:[gemini,createProviderConnection("deepseek",true),createProviderConnection("openai",false)]}});
  const [keys,setKeys]=useState({}); const [open,setOpen]=useState(true);
  return <LocaleProvider initialLocale="zh">
    <button onClick={()=>setOpen(true)}>打开设置</button>
    <output aria-label="Saved test configuration">{JSON.stringify(config.providers)}</output>
    <SettingsDialog open={open} onOpenChange={setOpen} project={config} sessionKeys={keys} isRunning={false}
      themePreset="soft-glass" onThemeChange={id=>applyTheme(themeTokens[id])} onPermissionDefaultChange={()=>{}}
      onSessionKeyChange={(id,value)=>setKeys(current=>({...current,[id]:value}))}
      onUpdateProvider={(id,patch)=>setConfig(current=>({...current,providers:{...current.providers,connections:current.providers.connections.map(p=>p.id!==id?p:{...p,...patch,auth:patch.authEnvVar!==undefined?{...p.auth,envVar:patch.authEnvVar}:p.auth})}}))}
      onSetDefaultProvider={id=>setConfig(current=>({...current,providers:{...current.providers,defaultProviderId:id}}))}
    />
  </LocaleProvider>;
}
createRoot(document.getElementById("root")).render(<Check/>);
