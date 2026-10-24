// Isolated browser verification of the existing composer. No host calls or persisted drafts.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerFrame, type ComposerDraft } from "/src/components/agent-preview/ComposerFrame";
import { ShellExtrasProvider } from "/src/components/shell/ShellExtras";
import { LocaleProvider } from "/src/i18n/LocaleContext";
import { IconSetProvider, IconStyleProvider } from "/src/agentmatrix";
import { project } from "/src/exported-project";
import { themeTokens } from "/src/theme/themeTokens";
import { applyTheme } from "/src/theme/applyTheme";
import "/src/styles/app.css";
import "/src/styles/agentmatrix.css";
import "@fontsource-variable/ibm-plex-sans/wght.css";

const params = new URLSearchParams(location.search);
const theme = themeTokens[params.get("dark") ? "warm-graphite" : "soft-glass"];
applyTheme(theme);
function Check() {
  const [draft, setDraft] = useState<ComposerDraft>({ prompt: "补充一句：先检查文件。", attachments: [] });
  const [running, setRunning] = useState(true);
  const [items, setItems] = useState<{ id: string; prompt: string; attachmentCount: number }[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const record = (action: string) => setActions(current => [...current, action]);
  return <LocaleProvider initialLocale={params.get("locale") ?? "zh"}><IconSetProvider><IconStyleProvider value="bold">
    <div className="exported-shell">
      <div className="preview-frame" data-style-preset="native" data-theme-preset={theme.id} data-appearance={theme.appearance}
        style={{display:"flex",flexDirection:"column",justifyContent:"end",width:"100%",height:"70dvh",padding:16}}>
        <ShellExtrasProvider value={{
          composerDraft: {value:draft,onChange:setDraft},
          composerQueue: {items,canEnqueue:running,canEdit:true,paused:running?undefined:"stopped",inputScope:"ui-check",
            onSteer:async()=>{record("steer");},
            onEnqueue:()=>{record("queue");setItems(current=>[...current,{id:String(current.length),prompt:draft.prompt,attachmentCount:0}]);setDraft({prompt:"",attachments:[]});},
            onRemove:id=>setItems(current=>current.filter(item=>item.id!==id)),onEdit:()=>{},onResume:()=>{record("resume");setRunning(true);}},
        }}>
          <ComposerFrame project={project} modelOptions={[]} isRunning={running} onStop={()=>{record("stop");setRunning(false);}}
            onSubmit={async()=>{record("send");}} onProviderChange={()=>{}} onModelChange={()=>{}} />
        </ShellExtrasProvider>
      </div>
      <output aria-label="Test actions">{JSON.stringify(actions)}</output>
    </div>
  </IconStyleProvider></IconSetProvider></LocaleProvider>;
}
createRoot(document.getElementById("root")!).render(<Check/>);
