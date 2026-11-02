import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,statSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {buildRelease} from '../../scripts/agentmatrix/release.mjs';
import {createRepoSnapshotAsync} from '../../src/pi/observer/version.ts';
const repo=process.cwd(), output=dirname(new URL(import.meta.url).pathname), temporary=mkdtempSync(join(tmpdir(),'rtb-observer-package-check-'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalIndex=execFileSync('git',['rev-parse','--git-path','index'],{encoding:'utf8'}).trim(),before=digest(readFileSync(originalIndex));
const report={kind:'local-package-content-verification',noDeploy:true,packages:[],errors:[]};
try{
 process.env.GIT_INDEX_FILE=join(temporary,'index');
 execFileSync('git',['read-tree','HEAD']);
 const extra=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(path=>path&&/^(src\/|scripts\/observer-manifest|docs\/product\/(13-observer|14-control-plane-inventory))/.test(path));
 execFileSync('git',['add','--',...extra]);
 // A throwaway index makes this uncommitted implementation eligible without staging the user's index.
 const agentmatrix=await buildRelease({repoRoot:repo,outDir:join(temporary,'agentmatrix'),skipBuild:true});
 const sphere=join(temporary,'agentsphere.tar.gz');
 execFileSync('python3',['-c','import sys; from pathlib import Path; sys.path.insert(0,"scripts/agentsphere"); import deploy; Path(sys.argv[1]).write_bytes(deploy.package())',sphere],{cwd:repo});
 for(const [name,file] of [['agentmatrix',agentmatrix.file],['agentsphere',sphere]]){
  const dir=join(temporary,`${name}-unpacked`);mkdirSync(dir);execFileSync('tar',['-xzf',file,'-C',dir]);
  assert.equal(existsSync(join(dir,'.git')),false);
  const snapshot=await createRepoSnapshotAsync({root:dir});
  const paths=new Set(snapshot.buildStamp.files.map(item=>item.path));
  for(const required of ['src/pi/observer/service.ts','src/pi/observer/queries.ts','src/pi/controlPlaneAuth.ts','docs/product/13-observer.md','docs/product/14-control-plane-inventory.md','AGENTS.md','tsconfig.control.json','dist/index.html'])assert.ok(paths.has(required),`${name} missing ${required}`);
  assert.ok(!paths.has('OBSERVER-BUILD.json'));
  assert.ok([...paths].every(path=>!path.startsWith('output/')&&!path.startsWith('.git/')&&!path.includes('node_modules/')));
  const stat={name,archiveBytes:statSync(file).size,fileCount:paths.size,readableFileCount:snapshot.files.length,manifestHash:snapshot.buildStamp.manifestHash,archiveHash:digest(readFileSync(file)),gitRevision:snapshot.buildStamp.gitRevision,dirty:snapshot.buildStamp.dirty};
  report.packages.push(stat);
  const manifest=JSON.parse(readFileSync(join(dir,'OBSERVER-BUILD.json'),'utf8'));writeFileSync(join(output,`${name}-manifest.json`),JSON.stringify(manifest,null,2));
  writeFileSync(join(dir,'src/pi/observer/service.ts'),'changed package bytes');
  await assert.rejects(createRepoSnapshotAsync({root:dir}),/observer_manifest_invalid/);
 }
 assert.ok(report.packages.find(p=>p.name==='agentmatrix').archiveBytes<=20*1024*1024);
}catch(error){report.errors.push(error.stack??String(error));}
finally{delete process.env.GIT_INDEX_FILE;report.realIndexUnchanged=digest(readFileSync(originalIndex))===before;rmSync(temporary,{recursive:true,force:true});writeFileSync(join(output,'package-results.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));if(report.errors.length||!report.realIndexUnchanged)process.exitCode=1;
