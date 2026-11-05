const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('../src/renderer/commands.js');
function fixture(mode='review',custom={}){let result;const registry=C.create({actions:Object.fromEntries(C.table.map(c=>[c.id,()=>{result=c.id;}])),context:()=>mode,custom:()=>custom});return {press(key,mods={},options={}){result=null;registry.dispatch({key,preventDefault(){},...mods},options);return result;},registry};}
test('registry preserves existing application, decision, view, navigation and develop bindings',()=>{
  for(const mode of ['review','grid','develop']){
    const f=fixture(mode);
    for(const [key,id] of [['p','flag-pick'],['x','flag-reject'],['u','flag-none'],['g','view-grid'],['e','view-review'],['d','view-develop'],['b','sources'],['i','details'],['f','fullscreen'],['?','help'],['Delete','delete'],['Backspace','delete'],['Escape','escape'],['F11','fullscreen-key'],['ArrowLeft','navigate-left'],['ArrowRight','navigate-right'],['ArrowUp','navigate-up'],['ArrowDown','navigate-down']]){
      assert.equal(f.press(key),id,mode+': '+key);
      if(/^[a-z]$/.test(key))assert.equal(f.press(key.toUpperCase(),{shiftKey:true}),id);
    }
    for(let n=0;n<=5;n++)assert.equal(f.press(String(n)),'rating-'+n);
    for(let n=6;n<=9;n++)assert.equal(f.press(String(n)),'color-'+n);
    for(let n=0;n<=8;n++)assert.equal(f.press(String(n),{altKey:true}),'color-alt-'+n);
    assert.equal(f.press('Delete',{shiftKey:true}),'delete-permanent');
    assert.equal(f.press('Backspace',{shiftKey:true}),'delete-permanent');
    assert.equal(f.press('ArrowRight',{shiftKey:true}),'extend-right');
    for(const modifier of ['ctrlKey','metaKey'])for(const [key,id,shiftKey] of [['o','open',false],[',','settings',false],['z','undo',false],['z','redo',true],['a','select-all',false],['e','edit',false],['e','export',true]])assert.equal(f.press(key,{[modifier]:true,shiftKey}),id);
    assert.equal(f.press('Tab',{ctrlKey:true}),'switch-view');
    assert.equal(f.press('Tab',{metaKey:true}),null);
    assert.equal(f.press('\\'),mode==='develop'?'before':'original');
    assert.equal(f.press('j'),mode==='develop'?'clipping':null);
    assert.equal(f.press('c',{ctrlKey:true,shiftKey:true}),mode==='develop'?'develop-copy':null);
    assert.equal(f.press('v',{metaKey:true,shiftKey:true}),mode==='develop'?'develop-paste':null);
    assert.equal(f.press(' '),mode==='review'?'pan':mode==='grid'?'review-space':null);
    assert.equal(f.press('z'),mode==='review'?'zoom-toggle':mode==='grid'?'review-zoom':null);
  }
});
test('review zoom shortcuts accept Ctrl and Command and do not capture unrelated modified keys',()=>{
  const f=fixture();for(const modifier of ['ctrlKey','metaKey'])for(const [key,id] of [['=','zoom-in'],['+','zoom-in'],['-','zoom-out'],['_','zoom-out'],['0','fit']])assert.equal(f.press(key,{[modifier]:true}),id);
  for(const key of ['p','x','u','5','b','g','j'])assert.equal(f.press(key,{ctrlKey:true}),null);
  assert.equal(f.press('p',{}, {typing:true}),null);assert.equal(f.press('o',{ctrlKey:true},{typing:true}),'open');assert.equal(f.press(' ',{},{button:true}),null);
});
test('custom bindings replace defaults, isolate contexts, and detect modifier and Shift conflicts',()=>{
  const f=fixture('review',{'flag-pick':['Ctrl+L']});assert.equal(f.press('p'),null);assert.equal(f.press('l',{ctrlKey:true}),'flag-pick');
  assert.equal(C.conflicts(C.table,{},'flag-pick',['X'])[0].id,'flag-reject');
  assert.equal(C.conflicts(C.table,{},'flag-pick',['Shift+X'])[0].id,'flag-reject');
  assert.equal(C.conflicts(C.table,{},'flag-pick',['Ctrl+O'])[0].id,'open');
  assert.equal(C.conflicts(C.table,{},'flag-pick',['Ctrl+Alt+O'])[0].id,'open');
  assert.equal(C.conflicts(C.table,{},'original',['\\']).length,0);
  assert.equal(C.conflicts(C.table,{},'before',['J'])[0].id,'clipping');
  assert.throws(()=>C.validateCustom({a:['bad+bad+P']}));
  assert.deepEqual(C.validateCustom({'future-command':['Control+l']}),{'future-command':['Ctrl+L']});
});
test('palette supports fuzzy search, recent ranking, and stable command identities',()=>{
  const {registry}=fixture();assert.equal(new Set(C.table.map(c=>c.id)).size,C.table.length);
  assert.equal(registry.search('edit in')[0].id,'edit');assert.equal(registry.search('', ['rating-5'])[0].id,'rating-5');
  assert.equal(C.fuzzy('zzzz','Open folder'),0);
  for(const c of registry.commands){assert.equal(typeof c.run,'function');assert.equal(typeof c.enabled,'function');assert.ok(c.category&&c.title&&c.context.length);}
});

test('legacy global shortcut precedence survives extra modifiers and platform selection',()=>{
 const f=fixture();
 for(const mods of [{ctrlKey:true,altKey:true},{ctrlKey:true,metaKey:true},{metaKey:true,altKey:true,shiftKey:true}])assert.equal(f.press('o',mods),'open');
 assert.equal(f.press('F11',{ctrlKey:true,altKey:true,shiftKey:true}),'fullscreen-key');
 assert.equal(f.press('Escape',{ctrlKey:true,metaKey:true,altKey:true,shiftKey:true}),'escape');
 assert.equal(f.press('3',{ctrlKey:true,altKey:true}),'color-alt-3');
 assert.equal(f.press('z',{ctrlKey:true,altKey:true}),'undo');
 for(const [platform,modifier,ignored] of [['darwin','metaKey','ctrlKey'],['win32','ctrlKey','metaKey']]){
   let ran=false;const registry=C.create({actions:{'select-all':()=>{ran=true;}},context:()=> 'review',platform});
   registry.dispatch({key:'a',[ignored]:true,preventDefault(){}});assert.equal(ran,false);
   registry.dispatch({key:'a',[modifier]:true,preventDefault(){}});assert.equal(ran,true);
 }
 assert.equal(f.press('ß',{ctrlKey:true,code:'Minus'}),'zoom-out');
 const custom=fixture('review',{'zoom-out':['Ctrl+L']});assert.equal(custom.press('ß',{ctrlKey:true,code:'Minus'}),null);
});
