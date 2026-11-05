const fs = require('node:fs/promises');
const path = require('node:path');
const { hash } = require('./library.cjs');
const { atomicWrite } = require('./xmp.cjs');
const { groupBursts, sharpest } = require('./renderer/culling.js');

// Analysis only reads original display previews. Scores and metadata live in the app cache.
class CullingService {
  constructor(library,previews,settings) { this.library=library;this.previews=previews;this.settings=settings; }
  async record(session,id) {
    const item=this.library.item(session,id),original={...item,develop:null};
    const stat=await fs.stat(item.path);
    if(stat.size!==item.size || stat.mtimeMs!==item.mtimeMs || `${stat.dev}:${stat.ino}`!==item.fileId)throw new Error('Photo changed on disk. Reopen the folder before focus analysis.');
    const metadata=await this.previews.metadata(original);
    const key=hash(`sharpness-v1:${item.fileId}:${this.previews.key(original,'preview')}:${JSON.stringify(metadata.focus)}`);
    const cache=path.join(this.previews.cacheDir,key+'.sharpness.json');
    let score=null;
    try { const value=JSON.parse(await fs.readFile(cache,'utf8'));if(value.key===key && Number.isFinite(value.score) && value.score>=0)score=value.score; } catch {}
    return {item:original,metadata,key,cache,score};
  }
  async source(session,id) {
    const record=await this.record(session,id);
    if (record.score!==null) return {key:record.key,score:record.score};
    const data=await this.previews.get(record.item,'preview',-20);
    const file=path.join(this.previews.cacheDir,this.previews.key(record.item,'preview')+'.jpg');
    // A memory hit can outlive a disk-cache eviction.
    await atomicWrite(file,data);
    return {key:record.key,file,focus:record.metadata.focus,score:null};
  }
  async store(session,id,key,score) {
    if (!Number.isFinite(score) || score<0) throw new Error('Invalid sharpness score.');
    const record=await this.record(session,id);
    if(record.key!==key)throw new Error('Photo changed during analysis.');
    await atomicWrite(record.cache,JSON.stringify({key,score}));return score;
  }
  async keep(session,ids) {
    const s=this.library.get(session);
    if(!Array.isArray(ids) || ids.length<2 || ids.length>10000 || new Set(ids).size!==ids.length)throw new Error('Choose one burst.');
    const records=[];
    for(const id of ids) { const r=await this.record(session,id);if(r.item.trashed)throw new Error('This burst changed.');records.push(r); }
    const burst=groupBursts(records.map(r=>({id:r.item.id,...r.metadata})),this.settings().burstGap);
    if(burst.length!==1 || burst[0].ids.length!==ids.length)throw new Error('This burst changed.');
    const best=sharpest(ids,new Map(records.map(r=>[r.item.id,r.score])));
    if(!best)throw new Error('Wait for every frame in this burst to finish analysis.');
    const batch=ids.map(id=>{const item=this.library.item(session,id),before={flag:item.flag,rating:item.rating,color:item.color,trashed:item.trashed===true};return {id,before,after:{...before,flag:id===best?'pick':'reject'}};});
    s.undo.push({batch});if(s.undo.length>500)s.undo.shift();s.redo=[];
    const items=batch.map(({id,after})=>{Object.assign(this.library.item(session,id),after,{edited:true});return {id,...after,edited:true};});
    await this.library.save(s);return {items,best};
  }
}
module.exports={CullingService};
