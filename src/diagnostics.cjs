const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const util = require('node:util');
const LIMIT=1024*1024,KEEP=3;
function redact(value) {
  return String(value).replaceAll(os.homedir(),'<home>').replaceAll(os.homedir().replaceAll('\\','/'),'<home>')
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi,'<home>').replace(/\/(?:home|Users)\/[^/\s"']+/g,'<home>')
    .replace(/([?&]t=)[\da-f]{48}/gi,'$1<redacted>');
}
function rotate(file,size=LIMIT) {
  if(!fs.existsSync(file)||fs.statSync(file).size<size)return;
  fs.rmSync(file+'.'+KEEP,{force:true});for(let n=KEEP-1;n>=1;n--)if(fs.existsSync(file+'.'+n))fs.renameSync(file+'.'+n,file+'.'+(n+1));fs.renameSync(file,file+'.1');
}
function createLogger(dataDir) {
  const folder=path.join(dataDir,'logs');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,'sidecar.log');
  const write=(level,...args)=>{try{const line=`${new Date().toISOString()} ${level} ${redact(util.format(...args)).slice(0,32768)}\n`;rotate(file,LIMIT-Buffer.byteLength(line));fs.appendFileSync(file,line);}catch{}};
  return {folder,write};
}
function diagnostics(dataDir,settings,details={}) {
  const folder=path.join(dataDir,'logs'),logs=[];
  for(const name of ['shell.log','shell.log.1','sidecar.log','sidecar.log.1'])try{
    const file=path.join(folder,name),stat=fs.statSync(file),buffer=Buffer.alloc(Math.min(stat.size,128*1024)),fd=fs.openSync(file,'r');
    try{fs.readSync(fd,buffer,0,buffer.length,Math.max(0,stat.size-buffer.length));}finally{fs.closeSync(fd);}
    logs.push(...buffer.toString('utf8').split('\n').filter(Boolean).map(line=>`${name}: ${line}`));
  }catch{}
  const summary={autoAdvance:settings.autoAdvance,recursive:settings.recursive,rawRendering:settings.rawRendering,previewCacheGB:settings.previewCacheGB,defaultRecipe:settings.defaultRecipe,editorCount:settings.editors.length,editors:settings.editors.map(e=>({name:e.name,path:e.path,needsPath:e.needsPath})),handoffFolder:settings.handoffFolder,shortcutOverrides:Object.keys(settings.shortcuts||{}).length};
  return redact(JSON.stringify({app:'PhotoCull',version:require('../package.json').version,os:`${os.platform()} ${os.release()} ${os.arch()}`,node:process.version,details,settings:summary},null,2)+'\n\nRecent logs\n'+logs.sort().slice(-200).join('\n'));
}
module.exports={createLogger,diagnostics,redact,rotate,LIMIT};
