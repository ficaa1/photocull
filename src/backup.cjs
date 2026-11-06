const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomicWrite } = require('./xmp.cjs');
const { inside } = require('./transfer.cjs');
const canceled = signal => { if(signal?.aborted) throw Object.assign(new Error('Backup canceled. Verified files are kept; run again to resume.'),{code:'ABORT_ERR'}); };
async function hashFile(file, signal) {
  canceled(signal);
  const named=await fs.lstat(file);if(!named.isFile()||named.isSymbolicLink())throw new Error('Not a regular file.');
  const handle=await fs.open(file,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before=await handle.stat();if(!before.isFile()||before.dev!==named.dev||before.ino!==named.ino)throw new Error('File changed before hashing.');
    const hash=createHash('sha256');
    for await(const chunk of handle.createReadStream({autoClose:false,signal,highWaterMark:1024*1024}))hash.update(chunk);
    const after=await handle.stat();
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('File changed while hashing.');
    return {hash:hash.digest('hex'),size:after.size,mtimeMs:after.mtimeMs};
  } finally {await handle.close();}
}
async function inventory(root, signal) {
  const files=[],issues=[];
  async function walk(folder) {
    canceled(signal);
    const entries=await fs.readdir(folder,{withFileTypes:true});
    for(const entry of entries) {
      canceled(signal);const file=path.join(folder,entry.name),relative=path.relative(root,file);
      const stat=await fs.lstat(file);
      if(stat.isSymbolicLink())issues.push({name:relative,reason:'Symbolic links are not backed up.'});
      else if(stat.isDirectory())await walk(file);
      else if(stat.isFile())files.push({relative,size:stat.size,mtimeMs:stat.mtimeMs});
      else issues.push({name:relative,reason:'Not a regular file.'});
    }
  }
  await walk(root);files.sort((a,b)=>a.relative.localeCompare(b.relative));return {files,issues};
}
function folderName(template='{date}-{card}',label='card',now=new Date()) {
  if(typeof template!=='string'||template.length>120||!template)throw new Error('Enter a backup folder template.');
  const card=String(label).replace(/[^\p{L}\p{N}_-]/gu,'_').slice(0,60)||'card';
  const date=now.toISOString().slice(0,10);
  const name=template.replaceAll('{date}',date).replaceAll('{card}',card).replaceAll('{year}',date.slice(0,4)).replaceAll('{month}',date.slice(5,7)).replaceAll('{day}',date.slice(8,10));
  if(/[{}<>:"/\\|?*\x00-\x1f]/.test(name)||/[. ]$/.test(name)||['.','..'].includes(name)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))throw new Error('Invalid backup folder template. Use {date}, {card}, {year}, {month}, {day}.');
  return name;
}
async function safeParent(root,relative) {
  if(!inside(root,path.resolve(root,relative)))throw new Error('Invalid backup path.');
  let current=root;
  for(const part of path.dirname(relative).split(path.sep).filter(p=>p!=='.')) {
    current=path.join(current,part);await fs.mkdir(current).catch(e=>{if(e.code!=='EEXIST')throw e;});
    const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Backup folders must be regular directories.');
  }
}
class BackupService {
  constructor(dataDir,{onProgress=()=>{}}={}) {this.folder=path.join(dataDir,'card-backups');this.onProgress=onProgress;this.active=null;}
  recordPath(identity){return path.join(this.folder,createHash('sha256').update(identity).digest('hex')+'.json');}
  async read(identity){try{return JSON.parse(await fs.readFile(this.recordPath(identity),'utf8'));}catch(e){if(e.code==='ENOENT')return {version:1,identity,files:{}};throw e;}}
  async save(record){await fs.mkdir(this.folder,{recursive:true});await atomicWrite(this.recordPath(record.identity),JSON.stringify(record));}
  cancel(){this.active?.controller.abort();}
  async close(){this.cancel();await this.active?.work.catch(()=>{});}
  async snapshot(source,identity) {
    source=await fs.realpath(source);const record=await this.read(identity);if(!Object.keys(record.files).length)return null;const {files,issues}=await inventory(source),missing=[...issues];
    for(const file of files){const saved=record.files[file.relative];let valid=!!saved&&saved.size===file.size&&saved.mtimeMs===file.mtimeMs;
      if(valid){const target=await fs.lstat(saved.destination).catch(()=>null);valid=target?.isFile()&&!target.isSymbolicLink()&&target.size===saved.size&&target.mtimeMs===saved.destinationMtimeMs;}
      if(!valid||record.invalid?.includes(file.relative))missing.push({name:file.relative,reason:'New, changed, missing or unverified backup.'});
    }
    if(record.invalid?.includes('Card inventory'))missing.push({name:'Card inventory',reason:'Files changed during the last full check. Check again.'});
    return {total:files.length,verified:Math.max(0,files.length-(missing.length-issues.length)),safe:files.length>0&&!missing.length,missing,checkedAt:record.checkedAt || null};
  }
  async status(source,identity,signal) {
    source=await fs.realpath(source);const record=await this.read(identity),{files,issues}=await inventory(source,signal),missing=[...issues];
    for(const file of files) {
      canceled(signal);const previous=record.files[file.relative];
      try {
        if(!previous||previous.size!==file.size||previous.mtimeMs!==file.mtimeMs)throw new Error('New or changed since backup.');
        const input=await hashFile(path.join(source,file.relative),signal),output=await hashFile(previous.destination,signal);
        if(input.hash!==previous.hash||output.hash!==previous.hash)throw new Error('Source or backup hash has changed.');
      }catch(error){canceled(signal);missing.push({name:file.relative,reason:error.message});}
    }
    const after=await inventory(source,signal);
    if(JSON.stringify(after)!==JSON.stringify({files,issues}))missing.push({name:'Card inventory',reason:'Files changed during verification. Check again.'});
    record.invalid=missing.map(f=>f.name);record.checkedAt=new Date().toISOString();await this.save(record);
    // Empty cards never receive a safe-to-format claim.
    return {total:files.length,verified:files.length-(missing.length-issues.length),safe:files.length>0&&!missing.length,missing,checkedAt:new Date().toISOString()};
  }
  async start(source,destination,{identity,label='card',template='{date}-{card}'}={}) {
    if(this.active)throw new Error('Another backup is running.');
    if(typeof identity!=='string'||!identity||identity.length>4096)throw new Error('Invalid card identity.');
    const operation={controller:new AbortController()};this.active=operation;
    operation.work=this.run(source,destination,{identity,label,template},operation.controller.signal);
    try{return await operation.work;}finally{if(this.active===operation)this.active=null;}
  }
  async run(source,destination,options,signal) {
    source=await fs.realpath(source);destination=await fs.realpath(destination);
    if(inside(source,destination))throw new Error('Choose a backup destination outside the source card or folder.');
    const relative=folderName(options.template,options.label);await safeParent(destination,path.join(relative,'placeholder'));
    const root=path.join(destination,relative);if(inside(source,await fs.realpath(root)))throw new Error('Backup destination resolves inside the source.');const record=await this.read(options.identity);
    const {files,issues}=await inventory(source,signal),progress={state:'copying',total:files.length,completed:0,verified:0,skipped:0,bytes:0,totalBytes:files.reduce((n,f)=>n+f.size,0),file:'',failures:[...issues],destination:root};
    const emit=()=>this.onProgress({...progress,failures:[...progress.failures]});emit();
    for(const file of files) {
      if(signal.aborted)break;progress.file=file.relative;progress.state='hashing';emit();let temporary=null;
      try {
        const input=path.join(source,file.relative),target=path.join(root,file.relative);
        // Resolve each parent again so a changed directory or link cannot redirect a write.
        if(!inside(source,await fs.realpath(input)))throw new Error('Source escaped the card.');
        const src=await hashFile(input,signal);
        if(src.size!==file.size||src.mtimeMs!==file.mtimeMs)throw new Error('Source changed. Run backup again.');
        await safeParent(root,file.relative);
        const exists=await fs.lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
        if(exists) {
          if(!exists.isFile()||exists.isSymbolicLink())throw new Error('Destination is not a regular file.');
          const output=await hashFile(target,signal);
          if(output.hash!==src.hash)throw new Error('Different file already exists; choose a new backup folder.');
          progress.skipped++;
        } else {
          temporary=target+'.photocull-'+randomUUID()+'.partial';
          progress.state='copying';emit();
          {
            const output=await fs.open(temporary,'wx');
            try {for await(const chunk of createReadStream(input,{flags:constants.O_RDONLY|(constants.O_NOFOLLOW||0),signal,highWaterMark:1024*1024})){canceled(signal);await output.writeFile(chunk);}await output.sync();}
            finally {await output.close();}
          }
          progress.state='verifying';emit();
          const output=await hashFile(temporary,signal);
          if(output.hash!==src.hash)throw new Error('Verification failed: copied bytes differ from the source.');
          const after=await hashFile(input,signal);
          if(after.hash!==src.hash||after.mtimeMs!==src.mtimeMs)throw new Error('Source changed during backup.');
          canceled(signal);
          // Publish without overwriting a file that appeared during the copy.
          try {await fs.link(temporary,target);}
          catch(error) {
            if(!['EPERM','ENOTSUP','EOPNOTSUPP','EXDEV','EINVAL','ENOSYS'].includes(error.code))throw error;
            // FAT/exFAT have no hard links. Exclusive creation still prevents replacement.
            const output=await fs.open(target,'wx');
            try {for await(const chunk of createReadStream(temporary,{signal})){canceled(signal);await output.writeFile(chunk);}await output.sync();}
            catch(copyError){await output.close();await fs.rm(target,{force:true});throw copyError;}
            await output.close();
            if((await hashFile(target,signal)).hash!==src.hash){await fs.rm(target,{force:true});throw new Error('Published copy failed verification.');}
          }
          await fs.rm(temporary);temporary=null;
        }
        canceled(signal);record.files[file.relative]={...src,destination:target,destinationMtimeMs:(await fs.stat(target)).mtimeMs,verifiedAt:new Date().toISOString()};
        await this.save(record);progress.verified++;progress.bytes+=file.size;
      } catch(error) {if(!signal.aborted)progress.failures.push({name:file.relative,reason:error.message});}
      finally {if(temporary)await fs.rm(temporary,{force:true}).catch(()=>{});}
      progress.state='copying';progress.completed++;emit();
    }
    progress.file='';progress.state=signal.aborted?'canceled':'checking';emit();
    if(!signal.aborted)progress.status=await this.status(source,options.identity,signal).catch(error=>({safe:false,total:files.length,missing:[{name:'Card',reason:error.message}]}));
    progress.state=signal.aborted?'canceled':'done';emit();return progress;
  }
}
module.exports={BackupService,hashFile,inventory,folderName,safeParent};
