// One table owns shortcuts, search, help and keyboard preferences. Mod means
// Command on macOS and Control elsewhere; both are accepted for legacy keys.
(function(root) {
  const ALL = ['review', 'grid', 'develop'];
  const table = [];
  const add = (id, title, category, keys, context = ALL, extra = {}) => table.push({ id, title, category, shortcuts: { default: keys, darwin: keys.map(k => k.replaceAll('Mod', 'Meta')), win32: keys.map(k => k.replaceAll('Mod', 'Ctrl')) }, context, ...extra });
  add('settings', 'Settings', 'Application', ['Mod+,'], ALL, { typing: true, ignoreShift: true, allowModifiers: ['Alt'] });
  add('open', 'Open folder…', 'Application', ['Mod+O'], ALL, { typing: true, ignoreShift: true, allowModifiers: ['Alt'] });
  add('export', 'Export photos…', 'Files', ['Mod+Shift+E'], ALL, { typing: true, allowModifiers: ['Alt'] });
  add('fullscreen-key', 'Fullscreen (F11)', 'View', ['F11'], ALL, { typing: true, ignoreShift: true, allowModifiers: ['Ctrl','Meta','Alt'] });
  add('switch-view', 'Switch review / contact sheet', 'View', ['Ctrl+Tab'], ALL, { typing: true, ignoreShift: true, allowModifiers: ['Meta','Alt'] });
  add('edit', 'Edit in external editor…', 'Files', ['Mod+E'], ALL, { allowModifiers: ['Alt'] });
  add('original', 'Show original / external edit', 'View', ['\\'], ['review','grid'], { ignoreShift: true });
  add('escape', 'Clear selection / exit fullscreen / fit', 'View', ['Escape'], ALL, { ignoreShift: true, allowModifiers: ['Ctrl','Meta','Alt'] });
  add('fullscreen', 'Toggle fullscreen', 'View', ['F','Ctrl+Meta+F'], ALL, { ignoreShift: true });
  add('undo', 'Undo', 'Edit', ['Mod+Z'], ALL, { allowModifiers: ['Alt'] });
  add('redo', 'Redo', 'Edit', ['Mod+Shift+Z'], ALL, { allowModifiers: ['Alt'] });
  add('select-all', 'Select all visible photos', 'Selection', ['Mod+A'], ALL, { ignoreShift: true, primaryModifier: true, allowModifiers: ['Alt'] });
  for (let n=0;n<=8;n++) add('color-alt-'+n, n ? 'Set color '+n : 'Clear color', 'Labels', ['Alt+'+n], ALL, { ignoreShift: true, allowModifiers: ['Ctrl','Meta'] });
  add('zoom-in', 'Zoom in', 'Zoom', ['Mod+=','Mod++','Mod+Shift+='], ['review'], { codes: ['Equal','NumpadAdd'], loupe: 'zoom-in' });
  add('zoom-out', 'Zoom out', 'Zoom', ['Mod+-','Mod+_'], ['review'], { codes: ['Minus','NumpadSubtract'], loupe: 'zoom-out' });
  add('fit', 'Fit photo', 'Zoom', ['Mod+0','Mod+Shift+0'], ['review'], { codes: ['Digit0','Numpad0'], loupe: 'fit' });
  add('zoom-toggle', 'Toggle zoom', 'Zoom', ['Z'], ['review'], { ignoreShift: true, loupe: 'toggle' });
  add('pan', 'Zoom / hold to pan', 'Zoom', ['Space'], ['review'], { ignoreShift: true, loupe: 'space' });
  add('delete', 'Move to PhotoCull Trash / delete in Trash', 'Edit', ['Delete','Backspace']);
  add('delete-permanent', 'Delete permanently…', 'Edit', ['Shift+Delete','Shift+Backspace']);
  add('restore', 'Restore from PhotoCull Trash', 'Edit', ['R'], ALL, { ignoreShift: true, when: 'trash' });
  add('sources', 'Toggle sources sidebar', 'View', ['B'], ALL, { ignoreShift: true });
  add('details', 'Toggle details sidebar', 'View', ['I'], ALL, { ignoreShift: true });
  for (const [key, direction] of [['ArrowLeft','left'],['ArrowRight','right'],['ArrowUp','up'],['ArrowDown','down']]) {
    add('navigate-'+direction, 'Next photo: '+direction, 'Navigation', [key]);
    add('extend-'+direction, 'Extend selection: '+direction, 'Selection', ['Shift+'+key]);
  }
  for (const [key, flag] of [['P','pick'],['X','reject'],['U','none']]) add('flag-'+flag, {pick:'Pick',reject:'Reject',none:'Clear flag'}[flag], 'Labels', [key], ALL, { ignoreShift: true });
  for (let n=0;n<=5;n++) add('rating-'+n, 'Rating '+n, 'Labels', [String(n)], ALL, { ignoreShift: true });
  for (let n=6;n<=9;n++) add('color-'+n, 'Set color '+(n-5), 'Labels', [String(n)], ALL, { ignoreShift: true });
  add('review-space', 'Open photo in review', 'View', ['Space'], ['grid'], { ignoreShift: true });
  add('review-zoom', 'Open photo zoomed', 'Zoom', ['Z'], ['grid'], { ignoreShift: true });
  for (const [key, mode, title] of [['G','grid','Contact sheet'],['E','review','Review'],['D','develop','Develop']]) add('view-'+mode,title,'View',[key],ALL,{ignoreShift:true});
  add('help','Keyboard shortcuts / Help','Help',['?'],ALL,{ignoreShift:true});
  add('develop-copy','Copy develop settings','Develop',['Mod+Shift+C'],['develop']);
  add('develop-paste','Paste develop settings','Develop',['Mod+Shift+V'],['develop']);
  add('clipping','Toggle clipping warnings','Develop',['J'],['develop'],{ignoreShift:true});
  add('before','Before / after adjustments','Develop',['\\'],['develop'],{ignoreShift:true});
  add('palette','Command palette','Application',['Mod+K','Mod+Shift+P'],ALL,{typing:true});
  add('go-photo','Go to photo by name','Navigation',[]);
  add('backup','Back up card or folder…','Files',[]);
  add('treat-card','Treat this folder as a camera card','Files',[]);
  add('welcome','Welcome / essential keys','Help',[]);
  add('diagnostics','Copy diagnostics','Help',[]);
  add('logs','Open log folder','Help',[]);
  function normalize(binding) {
    if (typeof binding !== 'string' || !binding || binding.length>80) throw new Error('Invalid shortcut.');
    const parts=binding.split('+'), key=parts.pop() || '+', mods=new Set(parts.filter(Boolean).map(p=>({Control:'Ctrl',Command:'Meta',Cmd:'Meta',Option:'Alt'}[p]||p)));
    if ([...mods].some(p=>!['Ctrl','Meta','Mod','Alt','Shift'].includes(p))) throw new Error('Invalid shortcut modifier.');
    return [...['Mod','Ctrl','Meta','Alt','Shift'].filter(p=>mods.has(p)),key===' '?'Space':key.length===1?key.toUpperCase():key].join('+');
  }
  function eventKey(e) {
    let key=e.key===' '?'Space':e.key;
    if(['Control','Meta','Alt','Shift','CapsLock','Dead','Unidentified'].includes(key))return null;
    // The produced symbol already identifies Shift on punctuation.
    const shift=e.shiftKey && !(key.length===1 && !/[a-z0-9]/i.test(key));
    return normalize([e.ctrlKey?'Ctrl':null,e.metaKey?'Meta':null,e.altKey?'Alt':null,shift?'Shift':null,key].filter(Boolean).join('+'));
  }
  function shortcuts(command, custom={}) { return Object.hasOwn(custom,command.id)?custom[command.id]:command.shortcuts.default; }
  function variants(binding, ignoreShift=false) {
    const values=binding.includes('Mod+')?['Ctrl','Meta','Ctrl+Meta'].map(mod=>binding.replace('Mod',mod)):[binding];
    return values.flatMap(k=>ignoreShift&&!k.includes('Shift+')?[k,k.replace(/([^+]+)$/, 'Shift+$1')]:[k]);
  }
  function bindingVariants(command,bindings,defaults) {
    let values=bindings.flatMap(k=>variants(normalize(k),defaults&&command.ignoreShift));
    if(defaults)for(const mod of command.allowModifiers||[])values=values.flatMap(k=>[k,normalize(mod+'+'+k)]);
    return [...new Set(values)];
  }
  function overlaps(a,b){return a.context.some(c=>b.context.includes(c));}
  function conflicts(commands,custom,id,bindings,{defaults=false}={}) {
    const command=commands.find(c=>c.id===id); if(!command)throw new Error('Unknown command.');
    const proposed=bindingVariants(command,bindings,defaults);
    return commands.filter(c=>c.id!==id&&overlaps(command,c)&&bindingVariants(c,shortcuts(c,custom),!Object.hasOwn(custom,c.id)).some(v=>proposed.includes(v)));
  }
  function matches(command,event,custom={},platform='web') {
    const changed=Object.hasOwn(custom,command.id);
    if(!changed&&command.primaryModifier&&(platform==='darwin'?!event.metaKey:platform!=='web'&&!event.ctrlKey))return false;
    let key=eventKey(event);
    if(!changed)for(const mod of command.allowModifiers||[])key=key?.replace(mod+'+','');
    return shortcuts(command,custom).some(k=>variants(normalize(k),!changed&&command.ignoreShift).includes(key)) || !changed && command.codes?.includes(event.code) && (event.ctrlKey||event.metaKey) && !event.altKey;
  }
  function loupeAction(event) {return table.find(command=>command.loupe&&matches(command,event))?.loupe || null;}
  function validateCustom(value) {
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>500)throw new Error('Invalid shortcuts.');
    const out={};for(const [id,keys] of Object.entries(value)){
      if(!/^[a-z0-9-]{1,100}$/.test(id)||!Array.isArray(keys)||keys.length>8)throw new Error('Invalid shortcuts.');
      out[id]=[...new Set(keys.map(normalize))];
    }
    for(const id of Object.keys(out))if(table.some(c=>c.id===id)&&conflicts(table,out,id,out[id]).length)throw new Error('Shortcut conflict for '+id+'.');
    return out;
  }
  function fuzzy(query,text) {
    query=query.toLowerCase().trim();text=text.toLowerCase();if(!query)return 1;
    let index=0,score=0,last=-2;for(const char of query){const at=text.indexOf(char,index);if(at<0)return 0;score+=at===last+1?4:1;last=at;index=at+1;}return score+(text.includes(query)?20:0);
  }
  function create({actions,context,custom=()=>({}),enabled=()=>true,onRun=()=>{},platform='web'}) {
    const commands=table.map(row=>({...row,enabled:()=>enabled(row),run:event=>actions[row.id]?.(event)}));
    return {commands,execute(id,event={}){const c=commands.find(c=>c.id===id);if(!c||!c.context.includes(context())||!c.enabled())return false;const input=typeof event.preventDefault==='function'?event:{...event,preventDefault(){}};const result=c.run(input);onRun(c);return result??true;},
      dispatch(event,{typing=false,button=false}={}){if(event.defaultPrevented)return false;const key=eventKey(event);if(!key)return false;
        const command=commands.find(c=>c.context.includes(context())&&(!typing||c.typing)&&(!button||!['Space','Enter'].includes(event.key===' '?'Space':event.key))&&c.enabled()&&matches(c,event,custom(),platform));
        if(!command)return false;event.preventDefault();this.execute(command.id,event);return true;},
      search(query,recent=[]){return commands.map(c=>({command:c,score:fuzzy(query,c.title+' '+c.category)+(query?0:Math.max(0,10-recent.indexOf(c.id))*(recent.includes(c.id)?1:0))})).filter(r=>r.score>0).sort((a,b)=>b.score-a.score).map(r=>r.command);}};
  }
  const api={table,create,normalize,eventKey,shortcuts,conflicts,validateCustom,fuzzy,variants,matches,loupeAction};
  if(typeof module==='object')module.exports=api;else root.PhotoCullCommands=api;
})(typeof globalThis==='object'?globalThis:this);
