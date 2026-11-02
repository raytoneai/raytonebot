from pathlib import Path
import json,re,subprocess,unicodedata
root=Path.cwd()
changed=subprocess.check_output(['git','diff','--name-only'],text=True).splitlines()
added={}
for name in changed:
 if name.endswith('.md'):
  lines=subprocess.check_output(['git','diff','--unified=0','--',name],text=True).splitlines()
  added[name]='\n'.join(line[1:] for line in lines if line.startswith('+') and not line.startswith('+++'))
for name in subprocess.check_output(['git','ls-files','--others','--exclude-standard'],text=True).splitlines():
 if name.endswith('.md'): added[name]=(root/name).read_text()
errors=[];checked=[]
def anchors(path):
 text=path.read_text();found=set(re.findall(r'id=["\']([^"\']+)',text));seen={}
 for header in re.findall(r'^#{1,6}\s+(.+)',text,re.M):
  slug=''.join(c for c in header.lower().strip() if c in ' -_' or unicodedata.category(c)[0] in 'LN').replace(' ','-')
  n=seen.get(slug,0);seen[slug]=n+1;found.add(slug+('-'+str(n) if n else ''))
 return found
for name,text in added.items():
 for url in re.findall(r'\]\(([^)]+)\)',text):
  if re.match(r'^[a-z]+://',url):continue
  target,_,anchor=url.partition('#');path=(root/name).parent/target if target else root/name
  if not path.exists():errors.append({'source':name,'target':url,'error':'missing file'})
  elif anchor and path.suffix=='.md' and anchor not in anchors(path):errors.append({'source':name,'target':url,'error':'missing anchor'})
  checked.append({'source':name,'target':url})
report={'checked':len(checked),'errors':errors};(root/'output/observer-followup-2026-11-02/link-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False));raise SystemExit(bool(errors))
