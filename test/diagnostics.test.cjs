const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createLogger,diagnostics,redact,LIMIT}=require('../src/diagnostics.cjs');
const {DEFAULTS}=require('../src/preferences.cjs');
test('local logs rotate and diagnostics redact home folders, exclude private metadata and cap recent lines',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'photocull-logs-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const logger=createLogger(root),file=path.join(logger.folder,'sidecar.log');
 fs.writeFileSync(file,'x'.repeat(LIMIT));logger.write('info','Opened %s',path.join(os.homedir(),'test'));
 assert.ok(fs.existsSync(file+'.1'));assert.ok(fs.statSync(file).size<LIMIT);assert.ok(!fs.readFileSync(file,'utf8').includes(os.homedir()));
 fs.writeFileSync(file,Array.from({length:250},(_,n)=>`2026 line ${n}`).join('\n'));const text=diagnostics(root,{...DEFAULTS,metadata:{creator:'secret-person'},handoffFolder:path.join(os.homedir(),'photos')},{webview:'test'});
 assert.ok(!text.includes('secret-person'));assert.ok(!text.includes(os.homedir()));assert.ok(text.includes('line 249'));assert.ok(!text.includes('line 0\n'));
 assert.ok(!redact('C:\\Users\\alex\\Pictures /home/alex/photos /Users/alex/photos').includes('alex'));
});
