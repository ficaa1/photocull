const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeSettings, BUILTINS } = require('./preferences.cjs');
const { checkSettings, BUILTIN_RECIPES } = require('./develop.cjs');
const { atomicWrite } = require('./xmp.cjs');
const TYPE='photocull-settings', VERSION=1, MAX=4*1024*1024;
const uuid=id=>typeof id==='string'&&/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id);
function bundle(settings,recipes,{excludePaths=true}={}) {
  const preferences=structuredClone(settings.value),presets=structuredClone(settings.presets.filter(p=>!BUILTINS.some(b=>b.id===p.id)));
  if(excludePaths){preferences.handoffFolder='';preferences.manualCards=[];for(const editor of preferences.editors){editor.path='';editor.needsPath=true;}}
  return {type:TYPE,version:VERSION,createdAt:new Date().toISOString(),pathsExcluded:excludePaths,preferences,presets,recipes:structuredClone(recipes.user)};
}
async function validate(input,{pathMap={}}={}) {
  if(!input||input.type!==TYPE||input.version!==VERSION||Buffer.byteLength(JSON.stringify(input))>MAX)throw new Error('Unsupported or oversized settings bundle.');
  if(!input.preferences||!Array.isArray(input.recipes)||input.recipes.length>100||!Array.isArray(input.presets)||input.presets.length>100)throw new Error('Invalid settings bundle.');
  if(!pathMap||typeof pathMap!=='object'||Array.isArray(pathMap)||Object.entries(pathMap).some(([a,b])=>!a||typeof b!=='string'))throw new Error('Invalid path mappings.');
  const map=value=>{
    if(!value)return value;
    const match=Object.keys(pathMap).sort((a,b)=>b.length-a.length).find(p=>value===p||value.startsWith(p+'/')||value.startsWith(p+'\\'));
    return match?pathMap[match]+value.slice(match.length):value;
  };
  const source=structuredClone(input.preferences);
  source.handoffFolder=map(source.handoffFolder);
  source.manualCards=(source.manualCards||[]).map(map);
  source.editors=(source.editors||[]).map(editor=>({...editor,path:map(editor.path)}));
  const preferences=normalizeSettings(source),warnings=[];
  for(const editor of preferences.editors){editor.needsPath=!editor.path||!await fs.stat(editor.path).then(s=>s.isFile()||process.platform==='darwin'&&s.isDirectory(),()=>false);if(editor.needsPath)warnings.push(`${editor.name}: needs path`);}
  for(const folder of [preferences.handoffFolder,...preferences.manualCards].filter(Boolean))if(!await fs.stat(folder).then(s=>s.isDirectory(),()=>false))warnings.push(`Folder unavailable: ${folder}`);
  const ids=new Set(),names=new Set(BUILTIN_RECIPES.map(r=>r.name.toLowerCase()));
  const recipes=input.recipes.map(r=>{
    if(!uuid(r?.id)||ids.has(r.id)||typeof r.name!=='string'||!r.name.trim()||r.name.length>80||/[\x00-\x1f]/.test(r.name)||names.has(r.name.trim().toLowerCase()))throw new Error('Invalid or duplicate recipe.');
    ids.add(r.id);names.add(r.name.trim().toLowerCase());return {id:r.id,name:r.name.trim(),settings:checkSettings(r.settings)};
  });
  if(![...BUILTIN_RECIPES,...recipes].some(r=>r.id===preferences.defaultRecipe))throw new Error('Default recipe is missing from the bundle.');
  ids.clear();names.clear();BUILTINS.forEach(p=>names.add(p.name.toLowerCase()));
  const presets=input.presets.map(p=>{
    if(!uuid(p?.id)||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||/[\x00-\x1f]/.test(p.name)||names.has(p.name.trim().toLowerCase()))throw new Error('Invalid metadata preset.');
    ids.add(p.id);names.add(p.name.trim().toLowerCase());const v=normalizeSettings(p);
    return {id:p.id,name:p.name.trim(),metadata:v.metadata,colors:v.colors,naming:v.naming,folders:v.folders};
  });
  if(![...BUILTINS,...presets].some(p=>p.id===preferences.activePreset))throw new Error('Active metadata preset is missing from the bundle.');
  return {preferences,recipes,presets,warnings};
}
class SettingsBundles {
  constructor(settings,recipes){this.settings=settings;this.recipes=recipes;this.pending=new Map();}
  async export(file,options){const value=bundle(this.settings,this.recipes,options);await writeBundle(file,value);return file;}
  async preview(input,options) {
    const value=await validate(input,options),current=bundle(this.settings,this.recipes,{excludePaths:false}),token=randomUUID();
    const changes=Object.keys(value.preferences).filter(k=>JSON.stringify(value.preferences[k])!==JSON.stringify(current.preferences[k]));
    const summary={token,changes,recipes:{before:current.recipes.length,after:value.recipes.length},presets:{before:current.presets.length,after:value.presets.length},warnings:value.warnings};
    this.pending.clear();this.pending.set(token,{value,current});return summary;
  }
  async apply(token) {
    const pending=this.pending.get(token);if(!pending)throw new Error('Preview the settings bundle first.');
    const {value,current}=pending;this.pending.delete(token);
    return this.settings.serial(async()=>{
      // Recipes and presets are replaced only after the complete current bundle is durable.
      if(JSON.stringify(bundle(this.settings,this.recipes,{excludePaths:false}).preferences)!==JSON.stringify(current.preferences)||JSON.stringify(this.recipes.user)!==JSON.stringify(current.recipes)||JSON.stringify(this.settings.presets.filter(p=>!BUILTINS.some(b=>b.id===p.id)))!==JSON.stringify(current.presets))throw new Error('Settings changed since preview. Preview again.');
      const folder=path.join(this.settings.folder,'backups');await fs.mkdir(folder,{recursive:true});
      const backup=path.join(folder,Date.now()+'-'+randomUUID()+'.json');await atomicWrite(backup,JSON.stringify(current,null,2));
      const restore=async data=>{
        for(const p of data.presets)await atomicWrite(path.join(this.settings.presetsFolder,p.id+'.json'),JSON.stringify(p,null,2));
        for(const r of data.recipes)await atomicWrite(path.join(this.recipes.folder,r.id+'.json'),JSON.stringify(r,null,2));
        for(const name of await fs.readdir(this.settings.presetsFolder))if(uuid(name.slice(0,-5))&&name.endsWith('.json')&&!data.presets.some(p=>name===p.id+'.json'))await fs.rm(path.join(this.settings.presetsFolder,name));
        for(const name of await fs.readdir(this.recipes.folder))if(uuid(name.slice(0,-5))&&name.endsWith('.json')&&!data.recipes.some(r=>name===r.id+'.json'))await fs.rm(path.join(this.recipes.folder,name));
        await atomicWrite(this.settings.file,JSON.stringify(data.preferences,null,2));
        this.settings.value=structuredClone(data.preferences);this.settings.presets=[...structuredClone(BUILTINS),...structuredClone(data.presets)];this.recipes.user=structuredClone(data.recipes);
      };
      try{await restore(value);}catch(error){await restore(current).catch(()=>{});throw error;}
      return {settings:this.settings.snapshot(),backup};
    });
  }
}
async function writeBundle(file,value){
  if(typeof file!=='string'||!path.isAbsolute(file)||!file.endsWith('.json'))throw new Error('Choose a JSON settings file.');
  const stat=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(stat&&(!stat.isFile()||stat.isSymbolicLink()))throw new Error('Choose a regular settings file.');
  await atomicWrite(file,JSON.stringify(value,null,2));
}
module.exports={bundle,validate,SettingsBundles,writeBundle};
