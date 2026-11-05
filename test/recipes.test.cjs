const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const {RecipeStore, parseRecipeFile} = require('../src/develop.cjs');
test('recipe exchange validates version, schema, names, settings and size before writing', () => {
  const row = {type:'photocull-recipe',version:1,name:'My recipe',settings:{light:{exposure:0.2}}};
  assert.equal(parseRecipeFile(JSON.stringify(row))[0].name,'My recipe');
  for(const patch of [{version:2},{type:'other'},{name:''},{settings:[]},{settings:null},{settings:{light:{exposure:9}}},{settings:{light:'bad'}},{settings:{text:'a'.repeat(65536)}}])assert.throws(()=>parseRecipeFile(JSON.stringify({...row,...patch})));
  assert.throws(()=>parseRecipeFile('{"type":"photocull-recipe","version":1,"name":"bad","settings":{"__proto__":{"x":1}}}'));
  assert.throws(()=>parseRecipeFile(' '.repeat(1024*1024+1)));
  assert.throws(()=>parseRecipeFile(JSON.stringify({type:'photocull-recipe-bundle',version:1,recipes:[row,{...row,name:''}]})));
});
test('single and bundle export/import persist settings and allocate collision names; builtins duplicate safely', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-recipes-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new RecipeStore(dir);await store.init();
  const r=await store.save({name:'Holiday',settings:{light:{exposure:1}}});
  const single=path.join(dir,'one.photocull-recipe.json');await store.exportFile(single,r.id);
  assert.equal(JSON.parse(await fs.readFile(single)).type,'photocull-recipe');
  const imported=await store.importFile(single);assert.equal(imported[0].name,'Holiday (2)');assert.deepEqual(imported[0].settings,r.settings);
  assert.equal((await store.duplicate('neutral')).name,'Neutral (2)');
  const bundle=path.join(dir,'all.photocull-recipe.json');await store.exportFile(bundle);
  const rows=await store.importFile(bundle);assert.equal(rows.length,3);assert.equal(rows[0].name,'Holiday (3)');
  const reopened=new RecipeStore(dir);await reopened.init();assert.equal(reopened.user.length,6);
  await assert.rejects(store.importFile(path.join(dir,'other.json')),/photocull-recipe/);
});
