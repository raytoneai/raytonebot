// Isolated verification of production output owners; no host calls or persisted user state.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OutputContent } from "/src/components/agent-preview/outputframe/OutputContent";
import { OutputPanelModal } from "/src/components/agent-preview/outputframe/OutputPanelModal";
import { ToolCallCard } from "/src/components/agent-preview/ToolCallCard";
import { LocaleProvider } from "/src/i18n/LocaleContext";
import { IconSetProvider } from "/src/agentmatrix";
import { project } from "/src/exported-project";
import { uiCopy } from "/src/i18n/uiCopy";
import { applyTheme } from "/src/theme/applyTheme";
import { themeTokens } from "/src/theme/themeTokens";
import "/src/styles/app.css";
import "/src/styles/agentmatrix.css";
const params = new URLSearchParams(location.search);
const theme = themeTokens[params.has("dark") ? "warm-graphite" : "soft-glass"];
applyTheme(theme);
const patch = 'diff --git a/config.ts b/config.ts\n--- a/config.ts\n+++ b/config.ts\n@@ -1,3 +1,3 @@\n export const settings = {\n-  retries: 1,\n+  retries: 3,\n };\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,2 @@\n+New retry policy\n+<script>This stays plain text</script>\n';
const initial = [{id:'patch',kind:'file',title:'retry-policy.patch',body:patch}, {id:'diff',kind:'file',title:'changes.diff',body:patch}];
function Check() {
 const [items,setItems]=useState(initial.slice(0,1)); const [active,setActive]=useState('patch'); const [modal,setModal]=useState(false); const [closed,setClosed]=useState([]);
 const close=id=>{setItems(current=>current.filter(item=>item.id!==id));setClosed(current=>[...current,id]);};
 return <LocaleProvider initialLocale="zh"><IconSetProvider><div className="exported-shell"><div className="preview-frame" data-style-preset="native" data-appearance={theme.appearance} style={{display:'block',padding:16,width:'100%',minHeight:'100vh'}}>
 <nav style={{display:'flex',flexWrap:'wrap',gap:10,marginBottom:16}}><button onClick={()=>{setItems(initial.slice(0,1));setClosed([]);}}>一个文件</button><button onClick={()=>{setItems(initial);setClosed([]);}}>两个文件</button><button onClick={()=>setModal(true)}>展开预览</button></nav>
 <section className="utility-card artifact-frame" style={{minHeight:360}}><OutputContent project={project} source="artifact" renderer="diff" copy={uiCopy.zh.workspace.outputFrame} openItems={items} activeOpenItemId={active} onSelectOpenItem={setActive} onCloseOpenItem={close} tools={[]} artifacts={[]} onOpenArtifact={()=>{}} /></section>
 <output aria-label="Closed files">{JSON.stringify(closed)}</output>
 <ToolCallCard project={{...project,toolCalls:{...project.toolCalls,detail:'full'}}} forceOpen tool={{kind:'tool',id:'failed-edit',name:'edit',status:'error',args:{path:'config.ts',oldText:'const retries = 1;\n',newText:'const retries = 3;\n'},result:'permission denied'}} />
 {modal && items.length>0 && <OutputPanelModal items={items} activeId={active} onSelectItem={setActive} onCloseItem={close} onClose={()=>setModal(false)} />}
 </div></div></IconSetProvider></LocaleProvider>;
}
createRoot(document.getElementById('root')).render(<Check/>);
