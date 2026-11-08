/* Develop UI. The host supplies small app hooks; this module owns its DOM and async work. */
(() => {
  const L = window.PhotoCullDevelopLogic;
  const clone = value => structuredClone(value);
  const get = (obj, path) => path.split('.').reduce((v, k) => v?.[k], obj);
  const put = (obj, path, value) => { const [a, b] = path.split('.'); (obj[a] ||= {})[b] = value; };
  const specs = [
    ['wb.temp','Temp',2000,50000,50,6500], ['wb.tint','Tint',-150,150,1,0],
    ['light.exposure','Exposure',-5,5,.01,0],
    ...['contrast','highlights','shadows','whites','blacks'].map(k => [`light.${k}`,k[0].toUpperCase()+k.slice(1),-100,100,1,0]),
    ...['highlights','lights','darks','shadows'].map(k => [`curve.${k}`,k[0].toUpperCase()+k.slice(1),-100,100,1,0]),
    ['optics.vignetting','Vignetting',-100,100,1,0], ['optics.vignetting_midpoint','Midpoint',0,100,1,50],
    ['detail.sharpen_amount','Sharpening',0,150,1,0], ['detail.nr_luminance','Luminance NR',0,100,1,0], ['detail.nr_color','Color NR',0,100,1,0],
  ].map(([id,label,min,max,step,def]) => ({ id,label,min,max,step,default:def }));
  const specOf = id => specs.find(s => s.id === id);
  const format = (spec, value) => Number(value).toFixed(spec.step < 1 ? 2 : 0);
  function node(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k,v] of Object.entries(props)) k === 'text' ? el.textContent = v : k === 'class' ? el.className = v : el.setAttribute(k,v);
    el.append(...children); return el;
  }
  function button(text, action, props = {}) {
    const b = node('button', { type:'button', class:'button quiet', text, ...props });
    b.onclick = () => { Promise.resolve().then(action).catch(e => window.PhotoCullDevelop.host.toast(e.message)); }; return b;
  }
  class Develop {
    constructor(host) {
      this.host = host; this.api = host.api; this.root = document.getElementById('develop');
      this.key = ''; this.token = 0; this.saves = Promise.resolve(); this.pendingSave = null; this.rows = new Map(); this.before = false; this.clipping = false;
      this.recipes = []; this.active = false; this.info = null; this.own = {}; this.recipeSettings = {}; this.base = {}; this.hist = null;
      this.build();
      this.queue = new L.RenderQueue((v, settled) => v.result ? (this.resultFrame ||= this.api.developResult(v.session,v.id).catch(e=>{this.resultFrame=null;throw e;})) : this.api.developRender(v.session, v.id, v.settings, settled), (frame, job) => this.frame(frame,job), e => this.message(e.message));
      this.api.onDevelopProgress(p => { if (this.batch?.phase === 'develop') { this.progress.max = p.total || 1; this.progress.value = p.done || 0; this.batchText.textContent = `Developing ${Math.min((p.done || 0) + 1, p.total)} of ${p.total}${p.name ? ` — ${p.name}` : ''}`; } });
      this.api.onLensDatabaseProgress(p => { this.lensDownload.textContent = `Downloading lens database: ${p.done} / ${p.total}`; });
      window.addEventListener('pagehide', () => { void this.flush(); this.queue.invalidate(); this.releaseFrame(); });
    }
    build() {
      this.stage = node('div',{class:'develop-stage'});
      this.image = node('img',{id:'develop-image',alt:'Developed RAW preview',draggable:'false'});
      this.overlay = node('canvas',{id:'develop-clipping','aria-hidden':'true',hidden:''});
      this.split=false;this.splitPosition=50;this.wipeEpoch=0;
      this.frameBox = node('div',{class:'develop-frame'},[this.image,this.overlay]);
      this.focusOverlay=new PhotoCullView.FocusOverlay(this.frameBox);
      this.wipeImage=node('img',{id:'develop-wipe-image',alt:'Before preview',hidden:'',draggable:'false'});
      this.wipe=node('div',{id:'develop-wipe',role:'slider',tabindex:0,'aria-label':'Before / after split','aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':50,hidden:''});
      this.wipeBefore=node('span',{class:'develop-wipe-label before',text:'Before',hidden:''});this.wipeAfter=node('span',{class:'develop-wipe-label after',text:'After',hidden:''});
      this.frameBox.append(this.wipeImage,this.wipe,this.wipeBefore,this.wipeAfter);
      const move=e=>{const r=this.image.getBoundingClientRect();this.setSplit((e.clientX-r.left)/r.width*100);};
      this.wipe.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();this.wipe.focus();this.wipe.setPointerCapture(e.pointerId);move(e);});
      this.wipe.addEventListener('pointermove',e=>{if(this.wipe.hasPointerCapture(e.pointerId))move(e);});
      this.wipe.addEventListener('pointerup',e=>{if(this.wipe.hasPointerCapture(e.pointerId))this.wipe.releasePointerCapture(e.pointerId);});
      this.wipe.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();this.setSplit(e.key==='Home'?0:e.key==='End'?100:this.splitPosition+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?10:1));}};
      new ResizeObserver(()=>this.drawFocus()).observe(this.image);
      this.notice = node('p',{id:'develop-message',class:'develop-message',role:'status'});
      this.timing = node('span',{id:'develop-timing',class:'develop-timing'});
      this.beforeButton = button('Before / after (\\)', () => this.toggleBefore(), {id:'develop-before','aria-pressed':'false'});
      this.splitButton=button('Split view (Shift+\\)',()=>this.toggleSplit(),{id:'develop-split','aria-pressed':'false'});
      this.photoTitle=node('span',{id:'develop-photo-name'});
      this.resultToggle=button('External edit',()=>this.toggleResult(),{id:'develop-result-toggle',hidden:'','aria-pressed':'true'});
      this.resultPanel=node('div',{id:'develop-result-panel',hidden:''});
      this.resultPath=node('p',{id:'develop-result-path',class:'subtle small'});
      this.editWarning=node('p',{id:'develop-edit-warning',class:'subtle small',text:'Re-developing replaces your external edit. RAW adjustments are saved separately until you choose to replace the hand-off file.'});
      this.editAgain=button('Edit again',()=>this.reedit(),{id:'develop-edit-again'});
      this.resultPanel.append(this.resultPath,node('div',{class:'develop-actions'},[button('Show in folder',()=>this.api.revealDevelop(this.context.session.id,this.context.photo.id),{id:'develop-result-reveal'}),this.editAgain]),this.editWarning);
      this.stage.append(node('div',{class:'develop-topline'},[this.photoTitle,this.resultToggle]),this.frameBox,this.notice,node('div',{class:'develop-image-bar'},[this.beforeButton,this.splitButton,this.timing]));
      this.panel = node('aside',{class:'develop-panel','aria-label':'Develop controls'});
      this.plot = node('canvas',{id:'develop-histogram',width:560,height:220,'aria-label':'Histogram: drag tonal zones to adjust',tabindex:0});
      this.low = button('▲', () => this.toggleClipping(), {id:'develop-shadow-clip','aria-label':'Shadow clipping overlay','aria-pressed':'false'});
      this.high = button('▲', () => this.toggleClipping(), {id:'develop-highlight-clip','aria-label':'Highlight clipping overlay','aria-pressed':'false'});
      this.readout = node('div',{id:'develop-readout',class:'develop-readout'});
      this.panel.append(node('div',{class:'develop-histogram'},[this.plot,this.low,this.high]),this.readout);
      this.panel.append(this.resultPanel);
      this.controls = node('fieldset',{class:'develop-controls',disabled:''}); this.panel.append(this.controls);
      const recipe = this.group('Recipe',true);
      this.recipeSelect = node('select',{id:'develop-recipe','aria-label':'Recipe'}); this.recipeSelect.onchange = () => this.chooseRecipe(this.recipeSelect.value);
      this.recipeName = node('input',{id:'develop-recipe-name',placeholder:'New recipe name',maxlength:80,'aria-label':'New recipe name'});
      this.updateRecipe = button('Update', () => this.saveRecipe(true), {id:'develop-recipe-update'});
      this.deleteRecipe = button('Delete', () => this.removeRecipe(), {id:'develop-recipe-delete'});
      recipe.append(this.recipeSelect,node('div',{class:'develop-recipe-save'},[this.recipeName,button('Save as',() => this.saveRecipe(false),{id:'develop-recipe-save'})]),
        node('div',{class:'develop-actions'},[button('Reset photo to recipe',() => this.reset(),{id:'develop-reset'}),node('div',{class:'split-button'},[
          node('button',{type:'button',id:'develop-recipe-menu-button',class:'button quiet','aria-haspopup':'menu','aria-expanded':'false','aria-controls':'develop-recipe-menu',text:'Recipe library…'}),
          node('div',{id:'develop-recipe-menu',class:'menu',role:'menu','aria-label':'Recipe library',hidden:''},[this.updateRecipe,button('Duplicate',async()=>{const r=await this.api.duplicateRecipe(this.recipe);await this.refreshRecipes();await this.chooseRecipe(r.id);},{id:'develop-recipe-duplicate'}),button('Set as default',() => this.defaultRecipe(),{id:'develop-recipe-default'}),this.deleteRecipe,node('div',{class:'menu-separator',role:'separator'}),
            button('Import…', async()=>{await this.api.importRecipes();await this.refreshRecipes();},{id:'develop-recipe-import'}),button('Export recipe…',()=>this.api.exportRecipes(this.recipe),{id:'develop-recipe-export'}),button('Export user recipes…',()=>this.api.exportRecipes(),{id:'develop-recipes-export'})].map(b=>{if(b.tagName==='BUTTON'){b.className='menu-item';b.setAttribute('role','menuitem');b.tabIndex=-1;}return b;}))])]));
      const profile = this.group('Profile',true);
      this.profile = node('select',{id:'develop-profile','aria-label':'Profile'}, ['neutral','color','portrait','landscape','vivid','mono'].map(k => node('option',{value:`lc.${k}`,text:k[0].toUpperCase()+k.slice(1)})));
      this.profile.onchange = () => this.change('profile.id',this.profile.value); profile.append(this.profile);
      const wb = this.group('White balance',true);
      this.wb = node('select',{id:'develop-wb','aria-label':'White balance'}, [['asShot','As shot'],['auto','Auto'],['custom','Custom']].map(([value,text])=>node('option',{value,text})));
      this.wb.onchange = () => this.change('wb.mode',this.wb.value);
      this.asShot = node('p',{class:'subtle small',id:'develop-as-shot'}); wb.append(this.wb,this.asShot);
      this.addSliders(wb,'wb.'); this.addSliders(this.group('Light',true),'light.');
      const curve = this.group('Tone curve',false); curve.append(node('p',{class:'subtle small',text:'Linear point curve · parametric adjustments'})); this.addSliders(curve,'curve.');
      const lens = this.group('Lens',false);
      this.lensToggle = node('input',{id:'develop-lens',type:'checkbox'}); this.lensToggle.onchange = () => this.change('optics.lens_profile',this.lensToggle.checked);
      this.lensStatus = node('p',{id:'develop-lens-status',class:'subtle small'});
      this.lensDownload = button('Download lens database',() => this.downloadLens(),{id:'develop-lens-download'});
      lens.append(node('label',{class:'toggle-row'},[this.lensToggle,document.createTextNode(' Profile corrections')]),this.lensStatus,this.lensDownload,
        node('p',{class:'subtle small',text:'Lensfun contributors · CC BY-SA 3.0. Downloaded on request, not bundled. Use manual Vignetting if the lens profile has no shading data.'})); this.addSliders(lens,'optics.');
      this.addSliders(this.group('Detail',false),'detail.');
      const many = this.group('Apply settings',true);
      this.pasteButton = button('Paste settings',() => this.paste(),{id:'develop-paste',disabled:''});
      many.append(node('div',{class:'develop-actions'},[button('Copy settings',() => this.copy(),{id:'develop-copy'}),this.pasteButton,
        button('Apply to selected',() => this.apply('selected'),{id:'develop-apply-selected'}),button('Apply to picks',() => this.apply('picks'),{id:'develop-apply-picks'})]));
      this.batchButton = button('Edit in…',() => this.openBatch(),{id:'develop-send',class:'button primary'}); this.controls.append(this.batchButton);
      this.root.append(this.stage,this.panel);
      this.bindHistogram(); this.buildBatch();
    }
    group(title,open) { const d = node('details',{'data-develop-group':title},[node('summary',{text:title})]); d.open = open; this.controls.append(d); return d; }
    addSliders(parent,prefix) {
      for (const spec of specs.filter(s=>s.id.startsWith(prefix))) {
        const id = `develop-${spec.id.replaceAll('.','-')}`;
        const label = node('label',{for:id,text:spec.label,title:'Double-click to reset'});
        const range = node('input',{id,type:'range',min:spec.min,max:spec.max,step:spec.step,value:spec.default,'aria-label':spec.label});
        const number = node('input',{type:'number',min:spec.min,max:spec.max,step:spec.step,value:spec.default,'aria-label':`${spec.label} value`});
        const set = value => this.change(spec.id,L.quantize(spec,Number(value)));
        range.oninput = () => set(range.value); number.onchange = () => set(number.value);
        const reset = e => { e.preventDefault(); this.change(spec.id,this.resetValue(spec)); };
        range.ondblclick = label.ondblclick = reset;
        // Native range supplies focus/arrow keys. Pointer movement is incremental so
        // Shift can change during the gesture and sub-step fine movement accumulates.
        range.addEventListener('pointerdown',e => {
          if (e.button !== 0 || !this.info) return;
          e.preventDefault(); range.focus(); range.setPointerCapture(e.pointerId);
          const rect = range.getBoundingClientRect();
          this.drag = {range,spec,x:e.clientX,value:this.value(spec.id),width:rect.width};
          if (!e.shiftKey) { this.drag.value = spec.min + Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width))*(spec.max-spec.min); set(this.drag.value); }
        });
        range.addEventListener('pointermove',e => {
          const d = this.drag; if (!d || d.range !== range) return;
          d.value = L.dragged(spec,d.value,e.clientX-d.x,d.width,e.shiftKey); d.x=e.clientX; set(d.value);
        });
        const end = () => { if (this.drag?.range === range) this.drag=null; };
        range.addEventListener('pointerup',end); range.addEventListener('lostpointercapture',end);
        parent.append(node('div',{class:'develop-slider'},[label,range,number])); this.rows.set(spec.id,{range,number,spec});
      }
    }
    value(path) { return get(L.merge(this.base,this.own),path) ?? specOf(path)?.default; }
    resetValue(spec) { return get(L.merge(this.base,this.recipeSettings),spec.id) ?? spec.default; }
    message(text) { this.notice.textContent=text || ''; this.notice.hidden=!text; }
    async refreshRecipes() {
      const result = await this.api.recipes(); this.recipes=result.recipes; this.recipeSelect.replaceChildren(...this.recipes.map(r=>node('option',{value:r.id,text:r.name})));
      this.recipeSelect.value=this.recipe || result.defaultRecipe; this.userRecipeButtons();
      return result;
    }
    userRecipeButtons() { const user=this.recipes.find(r=>r.id===this.recipe && !r.builtin); this.updateRecipe.disabled=this.deleteRecipe.disabled=!user; }
    sync(context) {
      this.context=context;
      const name=this.host.editorName(context.photo?.editedBy);this.editAgain.textContent=`Edit in ${name} again`;this.editWarning.textContent=context.photo?.handoffLinked ? 'Your linked edit is kept intact. Editing again or re-developing creates a separate hand-off file.' : `Re-developing replaces your ${name} edit. RAW adjustments are saved separately until you replace the hand-off file.`; this.active=context.mode==='develop'; this.root.hidden=!this.active || !context.photo;
      document.body.classList.toggle('develop-active',this.active);
      const key=this.active && context.photo ? `${context.session.id}:${context.photo.id}:${!!context.photo.externalEdit}` : '';
      if (key === this.key) return;
      void this.flush(); this.key=key; const token=++this.token; this.queue.invalidate(); this.info=null; this.resultFrame=null;this.clearWipe(); this.resultPanel.hidden=this.resultToggle.hidden=true; this.controls.disabled=true; this.before=false;
      this.beforeButton.setAttribute('aria-pressed','false'); this.beforeButton.disabled=true; this.releaseFrame(); this.hist=null; this.drawHistogram();
      if (!key) return;
      this.photoTitle.textContent=context.photo.name;
      if (!this.api.canDevelop) { this.message('Develop needs the PhotoCull desktop app. Open this folder there to adjust RAW files.'); return; }
      if (!context.photo.raw) { this.message('Develop is available for RAW photos. Select a camera RAW file.'); return; }
      this.message('Opening RAW…');
      void this.open(context,token);
    }
    async open(context,token) {
      try {
        await this.saves.catch(() => {}); if (token!==this.token) return;
        const [saved,info] = await Promise.all([this.api.developGet(context.session.id,context.photo.id),this.api.developInfo(context.session.id,context.photo.id)]);
        if (token!==this.token) return;
        this.editAgain.textContent=`Edit in ${this.host.editorName(saved.editedBy)} again`;
        this.saved=saved; this.showResult=!!saved.edited; this.resultPanel.hidden=this.resultToggle.hidden=!saved.edited; this.resultPath.textContent=saved.tiff || ''; this.info=info; this.base=info.base; this.recipe=saved.recipe; this.recipeSettings=clone(saved.recipeSettings || {}); this.own=clone(saved.settings || {});
        await this.refreshRecipes(); if (token!==this.token) return;
        this.controls.disabled=false; this.beforeButton.disabled=false; this.updateControls(); this.render();
        void this.lensState(token);
        void this.api.metadata(context.session.id,context.photo.id,'preview').then(meta=> {
          if (token!==this.token) return;
          this.setFocus(meta.focus,!!this.host.settings().focusOverlay);
          this.exif=[info.camera,meta.shutter ? `${meta.shutter} s` : '',meta.aperture,meta.iso ? `ISO ${meta.iso}` : ''].filter(Boolean).join(' · '); this.readout.textContent=this.exif;
        }).catch(()=>{});
      } catch(e) { if (token===this.token) this.message(e.message); }
    }
    updateControls() {
      for (const [path,{range,number,spec}] of this.rows) { let v=this.value(path); if (path.startsWith('wb.') && this.value('wb.mode')==='asShot') v=this.info.asShot[path.split('.')[1]]; range.value=v; number.value=format(spec,v); }
      this.profile.value=this.value('profile.id'); this.wb.value=this.value('wb.mode'); this.lensToggle.checked=this.value('optics.lens_profile'); this.recipeSelect.value=this.recipe;
      this.asShot.textContent=`As shot: ${Math.round(this.info.asShot.temp)} K · Tint ${Math.round(this.info.asShot.tint)}`;
      this.lensStatus.textContent=this.info.lensProfile || (this.info.lensDatabase ? 'No profile for this lens' : 'Lens database is not installed');
      this.userRecipeButtons();
    }
    toggleResult() {
      if (!this.saved?.edited) return;
      this.queue.invalidate(); this.showResult=!this.showResult; this.before=false; this.beforeButton.setAttribute('aria-pressed','false'); this.render();
    }
    async reedit() {
      const {session,photo}=this.context;if(this.batch || this.editing || !photo)return;
      const saved=await this.api.developGet(session.id,photo.id), editor=this.host.settings().editors.find(e=>e.id===saved.editedBy);
      if(!editor)throw new Error('The editor for this result was removed. Choose a configured editor from Edit in…');
      this.editing=true;this.editAgain.disabled=true;this.host.setBusy(true);
      try {
        await this.flush(); await this.api.editExternal(session.id,[photo.id],editor.id);
        await this.refreshItem(session.id,photo.id);
        if(this.context.session.id===session.id && this.context.photo.id===photo.id){this.key='';this.sync(this.context);}
      } finally {this.editing=false;this.editAgain.disabled=false;this.host.setBusy(false);}
    }
    async refreshItem(session,id) {
      const saved=await this.api.developGet(session,id);
      this.host.updateItems(session,[{id,developed:!!saved.tiff,externalEdit:!!saved.edited,editedBy:saved.editedBy,tiff:saved.tiff,developRevision:saved.revision}]);
      return saved;
    }
    rawAdjustment() {
      if (!this.saved?.edited) return;
      this.host.toast('RAW adjustments saved separately. Re-sending and choosing Re-develop replaces your external edit.');
      if(this.showResult || this.before) this.queue.invalidate(); this.showResult=false;
    }
    change(path,value) {
      if (!this.info) return;
      if (this.saved?.edited && this.showResult) this.rawAdjustment();
      if (path.startsWith('wb.') && path!=='wb.mode') {
        if (this.value('wb.mode')!=='custom') this.own.wb={...this.own.wb,...this.info.asShot,mode:'custom'};
      }
      if (this.before) this.queue.invalidate();
      put(this.own,path,value); this.before=false; this.beforeButton.setAttribute('aria-pressed','false'); this.updateControls(); this.scheduleSave(); this.render();
    }
    render() {
      if (!this.info || !this.active) return;
      const result=!!this.saved?.edited && (this.split || this.showResult) && !this.before;
      this.photoTitle.textContent=result ? `Edited in ${this.host.editorName(this.saved?.editedBy)} · ${(this.saved.tiff || '').split(/[\\/]/).pop()}` : this.context.photo.name;
      this.image.alt=result ? 'External edit' : 'Developed RAW preview';
      this.resultToggle.textContent=this.showResult ? 'RAW develop' : `Edited in ${this.host.editorName(this.saved?.editedBy)}`;
      this.resultToggle.setAttribute('aria-pressed',String(result));
      this.queue.request({result,session:this.context.session.id,id:this.context.photo.id,settings:clone(this.before ? this.recipeSettings : this.own),before:this.before});
    }
    async frame(frame,job) {
      const url=URL.createObjectURL(frame.blob), loaded=new Image(); loaded.src=url;
      try { await loaded.decode(); } catch(e) { URL.revokeObjectURL(url); throw e; }
      if (job.epoch!==this.queue.epoch || (job.settled && job.version!==this.queue.version)) { URL.revokeObjectURL(url); return; }
      const old=this.url; this.url=url; this.image.src=url; this.image.hidden=false;
      this.hist=frame.histogram; this.drawHistogram(); this.message('');
      this.timing.textContent=`${job.value.result ? `Edited in ${this.host.editorName(this.saved?.editedBy)}` : job.value.before ? 'Before · recipe' : 'After'} · ${job.settled ? 'settled' : 'draft'} ${Math.round(frame.renderMs)} ms · load ${Math.round(frame.loadMs)} ms`;
      this.root.dispatchEvent(new CustomEvent('develop-frame',{detail:{...frame,blob:undefined,settled:job.settled,before:job.value.before}}));
      this.maskImage=loaded; this.drawOverlay();this.drawFocus(); if (old) URL.revokeObjectURL(old);
      if(this.split && job.settled)void this.updateWipe();
    }
    releaseFrame() { this.clearWipe(); this.image.hidden=true; this.image.removeAttribute('src'); this.overlay.hidden=true; this.maskImage=null; if (this.url) URL.revokeObjectURL(this.url); this.url=null; }
    toggleBefore() { if (!this.info) return;if(this.split){this.split=false;this.splitButton.setAttribute('aria-pressed','false');this.clearWipe();} if(this.saved?.edited){this.toggleResult();return;} this.queue.invalidate(); this.before=!this.before; this.beforeButton.setAttribute('aria-pressed',String(this.before)); this.render(); }
    setFocus(focus,enabled) {this.focusOverlay.set(focus,enabled);this.drawFocus();}
    drawFocus() {
      const r=this.image.getBoundingClientRect(),b=this.frameBox.getBoundingClientRect();
      this.focusOverlay.draw({left:r.left-b.left,top:r.top-b.top,width:r.width,height:r.height},!this.image.hidden && this.active);
    }
    setSplit(value) {this.splitPosition=Math.min(100,Math.max(0,value));this.wipe.style.left=`${this.splitPosition}%`;this.wipe.setAttribute('aria-valuenow',String(Math.round(this.splitPosition)));this.wipeImage.style.clipPath=`inset(0 ${100-this.splitPosition}% 0 0)`;}
    toggleSplit() {
      if(!this.info)return;
      this.split=!this.split;this.before=false;this.beforeButton.setAttribute('aria-pressed','false');this.splitButton.setAttribute('aria-pressed',String(this.split));this.clearWipe();this.queue.invalidate();this.render();
    }
    clearWipe() {this.wipeEpoch++;this.wipeKey='';this.wipeImage.hidden=this.wipe.hidden=this.wipeBefore.hidden=this.wipeAfter.hidden=true;this.wipeImage.removeAttribute('src');if(this.wipeUrl)URL.revokeObjectURL(this.wipeUrl);this.wipeUrl=null;}
    async updateWipe() {
      if(!this.split || !this.active || !this.info)return;
      const settings=clone(this.saved?.edited ? this.own : this.recipeSettings),key=JSON.stringify([this.token,settings]);
      if(key===this.wipeKey)return;this.wipeKey=key;const token=this.token,epoch=++this.wipeEpoch;
      try {
        const frame=await this.api.developRender(this.context.session.id,this.context.photo.id,settings,true);
        if(epoch!==this.wipeEpoch || token!==this.token || !this.split || !this.active)return;
        const url=URL.createObjectURL(frame.blob),probe=new Image();probe.src=url;
        try{await probe.decode();}catch(error){URL.revokeObjectURL(url);throw error;}
        if(epoch!==this.wipeEpoch || token!==this.token || !this.split || !this.active){URL.revokeObjectURL(url);return;}
        const old=this.wipeUrl;this.wipeUrl=url;this.wipeImage.src=url;this.wipeImage.hidden=this.wipe.hidden=this.wipeBefore.hidden=this.wipeAfter.hidden=false;
        this.wipeBefore.textContent=this.saved?.edited?'RAW develop':'Before · recipe';this.wipeAfter.textContent=this.saved?.edited?'External edit':'After';this.setSplit(this.splitPosition);if(old)URL.revokeObjectURL(old);
      }catch(error){if(epoch===this.wipeEpoch){this.wipeKey='';this.host.toast(`Split preview unavailable: ${error.message}`);}}
    }
    toggleClipping() { this.clipping=!this.clipping; for (const b of [this.low,this.high]) b.setAttribute('aria-pressed',String(this.clipping)); this.drawOverlay(); }
    drawOverlay() {
      this.overlay.hidden=!this.clipping || !this.maskImage; if (this.overlay.hidden) return;
      const c=this.overlay; c.width=this.maskImage.naturalWidth; c.height=this.maskImage.naturalHeight;
      const ctx=c.getContext('2d',{willReadFrequently:true}); ctx.drawImage(this.maskImage,0,0);
      const pixels=ctx.getImageData(0,0,c.width,c.height); pixels.data.set(L.clippingMask(pixels.data)); ctx.putImageData(pixels,0,0);
    }
    drawHistogram() {
      const c=this.plot,ctx=c.getContext('2d'),w=c.width,h=c.height; ctx.clearRect(0,0,w,h);
      ctx.strokeStyle='#ffffff12'; ctx.lineWidth=1;
      for (let i=1;i<4;i++) { ctx.beginPath();ctx.moveTo(w*i/4,0);ctx.lineTo(w*i/4,h);ctx.stroke(); }
      if (this.zone) { ctx.fillStyle='#ffffff12';ctx.fillRect(this.zone.from*w,0,(this.zone.to-this.zone.from)*w,h); }
      if (!this.hist) { this.low.classList.remove('clipped');this.high.classList.remove('clipped');return; }
      const data=L.histogramData(this.hist);
      const path=values=> { ctx.beginPath(); values.forEach((v,i)=> { const x=i*w/255,y=h-v*(h-8); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }); };
      path(data.heights[0]);ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();ctx.fillStyle='#b9c0c345';ctx.fill();
      for (const [i,color] of (data.gray ? [[0,'#cbd0d4']] : [[1,'#e26b65'],[2,'#76c78a'],[3,'#6f9ee3']])) {path(data.heights[i]);ctx.strokeStyle=color;ctx.lineWidth=1.6;ctx.stroke();}
      this.low.classList.toggle('clipped',data.shadows);this.high.classList.toggle('clipped',data.highlights);
      this.low.title=`Shadow clipping ${data.shadows ? 'detected' : 'not detected'} · toggle overlay (J)`; this.high.title=`Highlight clipping ${data.highlights ? 'detected' : 'not detected'} · toggle overlay (J)`;
    }
    bindHistogram() {
      const at=e=> {const r=this.plot.getBoundingClientRect();return L.zoneAt((e.clientX-r.left)/r.width);};
      const read=zone=> { this.zone=zone;this.readout.textContent=zone?`${specOf(zone.control).label}: ${format(specOf(zone.control),this.value(zone.control))}${zone.control==='light.exposure'?' EV':''}`:this.exif || this.info?.camera || '';this.drawHistogram(); };
      this.plot.addEventListener('pointerdown',e=> { if (!this.info || e.button!==0) return; const zone=at(e);if (!zone)return;e.preventDefault();this.plot.setPointerCapture(e.pointerId);this.histDrag={zone,x:e.clientX,value:this.value(zone.control)};read(zone); });
      this.plot.addEventListener('pointermove',e=> { if (!this.info)return;const d=this.histDrag;if(d){ const spec=specOf(d.zone.control);d.value=L.dragged(spec,d.value,e.clientX-d.x,this.plot.getBoundingClientRect().width,e.shiftKey);d.x=e.clientX;this.change(spec.id,L.quantize(spec,d.value));read(d.zone); }else read(at(e)); });
      const end=()=> {this.histDrag=null;};this.plot.addEventListener('pointerup',end);this.plot.addEventListener('lostpointercapture',end);this.plot.addEventListener('pointerleave',()=>{if(!this.histDrag)read(null);});
      this.plot.ondblclick=e=>{const zone=at(e);if(zone&&this.info){this.change(zone.control,0);read(zone);}};
      this.plot.onkeydown=e=>{if(!this.info || !['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();e.stopPropagation();const zone=this.zone || L.zones[2],spec=specOf(zone.control);this.change(spec.id,L.quantize(spec,this.value(spec.id)+(e.key==='ArrowRight'?1:-1)*spec.step));read(zone);};
    }
    scheduleSave(value={recipe:this.recipe,settings:clone(this.own)}) {
      this.pendingSave={session:this.context.session.id,ids:[this.context.photo.id],value:clone(value)};clearTimeout(this.saveTimer);
      this.saveTimer=setTimeout(()=>void this.flush(),300); this.host.status('Saving develop settings…');
    }
    flush() {
      clearTimeout(this.saveTimer);const p=this.pendingSave;this.pendingSave=null;
      if (p) this.saves=this.saves.catch(()=>{}).then(async()=> {const result=await this.api.developSet(p.session,p.ids,p.value);this.host.updateItems(p.session,result.items);this.host.status('Saved');}).catch(e=>{this.host.status('Develop settings could not be saved',true);this.host.toast(e.message);throw e;});
      // Attach a handler immediately; callers that need durability still await the rejected promise.
      this.saves.catch(()=>{});return this.saves;
    }
    async chooseRecipe(id) {
      const recipe=this.recipes.find(r=>r.id===id);if(!recipe || !this.info)return;
      this.rawAdjustment();this.queue.invalidate();this.recipe=id;this.recipeSettings=clone(recipe.settings);this.own=clone(recipe.settings);this.before=false;this.beforeButton.setAttribute('aria-pressed','false');this.updateControls();this.scheduleSave({recipe:id,settings:null});this.render();
    }
    async reset() { await this.chooseRecipe(this.recipe); }
    async saveRecipe(update) {
      const token=this.token,current=this.recipes.find(r=>r.id===this.recipe);const saved=await this.api.saveRecipe({...(update?{id:current.id}:{}),name:update?current.name:this.recipeName.value,settings:this.own});
      if(token!==this.token)return;await this.refreshRecipes();if(token!==this.token)return;await this.chooseRecipe(saved.id);this.recipeName.value='';
    }
    async removeRecipe() { if(await this.ask('Delete this recipe? Photos without their own adjustments will use the default recipe.',[['delete','Delete recipe'],['cancel','Cancel']])!=='delete')return;await this.flush();await this.api.deleteRecipe(this.recipe);await this.refreshRecipes();await this.chooseRecipe('neutral'); }
    async defaultRecipe() { await this.host.saveSettings({defaultRecipe:this.recipe});this.host.toast('Default recipe saved'); }
    copy() { if(!this.info)return;this.clipboard={recipe:this.recipe,settings:clone(this.own)};this.pasteButton.disabled=false;this.host.toast('Develop settings copied'); }
    async paste() {
      if (!this.clipboard || !this.context.session) return;
      const session = this.context.session.id, items = this.host.selection().filter(i => i.raw), value = clone(this.clipboard);
      if (!items.length) return;
      await this.flush();
      const result = await this.api.developSet(session, items.map(i => i.id), value);
      this.host.updateItems(session, result.items);
      if (this.info && this.context.session.id === session && items.some(i => i.id === this.context.photo.id)) {
        const recipe = this.recipes.find(r => r.id === value.recipe);
        this.rawAdjustment(); this.queue.invalidate(); this.before = false; this.beforeButton.setAttribute('aria-pressed','false');
        this.recipe = recipe?.id || 'neutral'; this.recipeSettings = clone(recipe?.settings || {}); this.own = clone(value.settings);
        this.updateControls(); this.render();
      }
      this.host.toast(`Settings pasted to ${items.length} RAW photo(s)`);
    }
    async apply(scope) {
      if (!this.info) return;
      const session = this.context.session.id;
      const items = (scope === 'picks' ? this.context.session.items.filter(i => i.flag === 'pick' && !i.trashed) : this.host.selection()).filter(i => i.raw);
      const value = { recipe: this.recipe, settings: clone(this.own) };
      if (!items.length) throw new Error('Select RAW photos first.');
      await this.flush();
      const result = await this.api.developSet(session, items.map(i => i.id), value);
      this.host.updateItems(session, result.items); this.host.toast(`Settings applied to ${items.length} RAW photo(s)`);
    }
    async lensState(token) { try {const db=await this.api.lensDatabase();if(token!==this.token)return;this.lensDownload.hidden=db.installed;this.lensDownload.textContent=`Download lens database (${db.megabytes} MB)`;}catch(e){if(token===this.token)this.lensStatus.textContent=e.message;} }
    async downloadLens() {this.lensDownload.disabled=true;try{await this.api.downloadLensDatabase();this.key='';this.sync(this.context);}finally{this.lensDownload.disabled=false;} }
    buildBatch() {
      this.dialog=node('dialog',{id:'develop-batch-dialog','aria-labelledby':'develop-batch-title'});
      this.batchText=node('p',{id:'develop-batch-status',role:'status','aria-live':'polite'});this.batchFolder=node('p',{id:'develop-batch-folder',class:'subtle small'});
      this.scope=node('select',{id:'develop-batch-scope','aria-label':'Photos to send'},[node('option',{value:'selected',text:'Selected RAW photos'}),node('option',{value:'picks',text:'All RAW picks'})]);
      this.scope.onchange=()=>this.batchScope();
      this.chooseFolder=button('Change…',()=>this.pickDestination(),{id:'develop-batch-choose'});
      this.startBatch=button('Develop and open',()=>this.runBatch(),{id:'develop-batch-start',class:'button primary'});
      this.skipBatch=button('Skip',()=>{this.batch.skip=true;this.batchText.textContent='Skipping this editor hand-off…';void this.api.developCancel();},{id:'develop-batch-skip',hidden:'',title:'Stop waiting for this hand-off (exit mode closes the launched process)'});
      this.stopBatch=button('Cancel',()=>{if(this.batch){this.batch.stop=true;void this.api.developCancel();this.batchText.textContent='Stopping…';}else this.dialog.close();},{id:'develop-batch-stop',class:'button'});
      this.progress=node('progress',{id:'develop-batch-progress',max:1,value:0,hidden:''});this.results=node('pre',{id:'develop-batch-results'});this.resultLinks=node('div',{id:'develop-batch-links'});
      this.alwaysFolder=node('input',{id:'develop-batch-always',type:'checkbox'});this.alwaysFolder.onchange=async()=>{try{await this.host.saveSettings({handoffAlways:this.alwaysFolder.checked,...(this.destination?{handoffFolder:this.destination}:{})});}catch(e){this.host.toast(e.message);}};
      this.configureEditors=button('Configure editors…',()=>{this.dialog.close();return this.host.openEditors();},{id:'develop-configure-editors',class:'text-button'});
      this.dialog.append(node('div',{class:'dialog-header'},[node('h2',{id:'develop-batch-title',text:'Edit in…'}),this.configureEditors]),this.scope,node('div',{class:'batch-folder'},[this.batchFolder,this.chooseFolder]),node('label',{class:'toggle-row'},[this.alwaysFolder,document.createTextNode(' Always use this folder (all sessions)')]),this.batchText,this.progress,node('div',{class:'develop-actions dialog-actions'},[this.skipBatch,this.stopBatch,this.startBatch]),this.results,this.resultLinks);document.body.append(this.dialog);
      this.dialog.addEventListener('cancel',e=>{if(this.batch){e.preventDefault();this.batch.stop=true;void this.api.developCancel();}});
      this.askDialog=node('dialog',{id:'develop-choice-dialog'});document.body.append(this.askDialog);
    }
    ask(text,choices) { return new Promise(resolve=> {this.askDialog.replaceChildren(node('p',{text}));const done=value=>{this.askDialog.close();resolve(value);};this.askDialog.oncancel=()=>done('cancel');this.askDialog.append(node('div',{class:'develop-actions dialog-actions'},choices.map(([value,label])=>button(label,()=>done(value)))));this.askDialog.showModal();}); }
    batchItems() {return (this.scope.value==='picks'?this.batchContext.session.items.filter(i=>i.flag==='pick'&&!i.trashed):this.batchContext.selected).filter(i=>i.raw&&!i.trashed);}
    batchScope() {
      const n=this.batchItems().length,h=this.editor.handoff;
      this.batchText.textContent=`${n} RAW photo(s) · ${h.colorSpace}, ${h.bitDepth}-bit ${h.format.toUpperCase()}${h.format==='tiff'?' · '+h.compression:''} · ${this.editor.detect==='watch'?'Save in the editor; PhotoCull waits for writes to settle.':'Apply and close the editor to continue.'}${!this.editor.path||this.editor.needsPath?' Browse to the application in Settings → External editors.':''}`;
      this.startBatch.disabled=!n || !this.destination || !this.editor.path || this.editor.needsPath;
    }
    async pickDestination() {
      const folder=await this.api.pickFolder('Choose a local hand-off folder');
      if(!folder)return;
      await this.api.developFolderCheck(folder);
      if(this.batchContext.session.removable || this.alwaysFolder.checked) await this.host.saveSettings({handoffFolder:folder});
      this.destination=folder; this.batchFolder.textContent=folder; this.batchScope();
    }
    addResult(session,id,tiff) {
      if(this.resultLinks.querySelector(`[data-result-id="${id}"]`))return;
      const row=node('div',{'data-result-id':id,class:'develop-result-row'},[node('p',{text:tiff,class:'subtle small'}),node('div',{class:'develop-actions'},[
        button('Show in folder',()=>this.api.revealDevelop(session,id)),
        button('View result',()=>{this.dialog.close();this.host.viewResult(session,id);},{class:'button quiet develop-view-result',...(this.batch?{disabled:''}:{})}),
      ])]); this.resultLinks.append(row);
    }
    async openBatch(editorId) {
      if(this.batch || this.editing || !this.context.session)return;
      if(!this.api.canDevelop){this.host.toast('External editing needs the PhotoCull desktop app.');return;}
      const settings=await this.api.settings();this.editor=settings.editors.find(e=>e.id===(editorId || settings.defaultEditor));
      if(this.dialog.open)return;
      if(!this.editor)throw new Error('Choose a configured editor in Settings.');
      document.getElementById('develop-batch-title').textContent=`Edit in ${this.editor.name}`;
      this.alwaysFolder.checked=settings.handoffAlways;
      await this.flush();this.batchContext={session:this.context.session,selected:[...this.host.selection()]};
      const dest=await this.api.developFolder(this.context.session.id);this.destination=dest.folder;
      this.batchFolder.textContent=this.destination || 'Choose a folder on your computer for this camera card.';this.results.textContent='';this.resultLinks.replaceChildren();this.progress.hidden=true;this.scope.disabled=false;this.chooseFolder.disabled=false;this.scope.value=this.batchContext.selected.length?'selected':'picks';this.startBatch.hidden=false;this.skipBatch.hidden=true;this.stopBatch.textContent='Cancel';this.batchScope();this.dialog.showModal();
      if(!this.destination) await this.pickDestination();
    }
    async runBatch() {
      const session = this.batchContext.session.id, items = this.batchItems(), folder = this.destination;
      if (this.batch || !items.length || !folder) return;
      this.batch = { stop: false, skip: false, phase: 'planning' };
      this.host.setBusy(true);this.alwaysFolder.disabled=this.configureEditors.disabled=true;
      this.scope.disabled = this.chooseFolder.disabled = true; this.startBatch.hidden = true;
      this.progress.hidden = false; this.stopBatch.textContent = 'Stop';
      this.batchText.textContent = 'Checking hand-off destinations…';
      const lines = [];
      try {
        await this.flush();
        const extension={tiff:'tif',png:'png',jpeg:'jpg'}[this.editor.handoff.format];
        const plan = await this.api.developPlan(session, items.map(i => i.id), folder, extension);
        for (const row of plan.filter(r => r.error)) lines.push(`${row.name}: failed — ${row.error}`);
        this.results.textContent = lines.join('\n');
        const valid = plan.filter(r => !r.error);
        if (!valid.length) throw new Error('No hand-off files can be developed. See the file results below.');
        let replace = false;
        if (!this.batch.stop && valid.some(r => r.exists)) {
          const choice = await this.ask(valid.some(r=>r.edited) ? 'Re-developing replaces your external edit. Keep the existing hand-off files to edit them again, or re-develop with the current RAW settings?' : 'These photos already have hand-off files. Keep them to edit again, or re-develop with the current RAW settings?', [
            ['keep', 'Edit existing files'], ['replace', 'Re-develop and replace files'], ['cancel', 'Cancel'],
          ]);
          if (choice === 'cancel') this.batch.stop = true;
          replace = choice === 'replace';
        }
        if (this.batch.stop) { this.batchText.textContent = 'Cancelled.'; return; }
        await this.api.makeFolder(folder);
        const jobs = [];
        for (const item of valid) {
          if (this.batch.stop) break;
          const saved = await this.api.developGet(session, item.id);
          jobs.push({ id: item.id, settings: saved.settings });
        }
        if (this.batch.stop) { this.batchText.textContent = 'Cancelled.'; return; }
        this.batch.phase = 'develop';
        const result = await this.api.developTiffs(session, folder, jobs, { ...this.editor.handoff, replace });
        const ready = result.results.filter(r => ['developed', 'exists'].includes(r.status));
        for (const r of result.results) {
          const item = items.find(i => i.id === r.id);
          lines.push(`${item?.name || r.id}: ${r.status}${r.error ? ` — ${r.error}` : ''}`);
        }
        this.results.textContent = lines.join('\n');
        for (const r of ready) await this.refreshItem(session,r.id);
        this.batch.phase = 'edit'; this.skipBatch.hidden = false;
        const groups=this.editor.multiple ? (ready.length?[ready]:[]) : ready.map(r=>[r]);
        for (let i = 0; i < groups.length && !this.batch.stop; i++) {
          const group=groups[i], names=group.map(r=>items.find(p=>p.id===r.id)?.name).join(', ');this.batch.skip=false;
          this.batchText.textContent=`Editing in ${this.editor.name}: ${i+1} of ${groups.length} — ${names} — ${this.editor.detect==='watch'?'save the file(s) to continue':'close the editor to continue'}`;
          this.progress.max=groups.length;this.progress.value=i;
          try {
            const edit=await this.api.editExternal(session,group.map(r=>r.id),this.editor.id);
            for(const r of group){const saved=await this.refreshItem(session,r.id);if(saved.edited&&saved.tiff)this.addResult(session,r.id,saved.tiff);}
            lines.push(`${names}: ${this.batch.skip?'skipped':edit.edited?'edited in '+this.editor.name:'closed without changes'}`);
          } catch(e) {
            lines.push(`${names}: ${e.message}`);
            if(!this.batch.stop && await this.ask(`${names}: ${e.message}`,[['skip','Skip photo'],['stop','Stop']])!=='skip')this.batch.stop=true;
          }
          this.results.textContent=lines.join('\n');
        }
        this.progress.value = this.progress.max;
        this.batchText.textContent = this.batch.stop ? 'Stopped. Completed hand-off files and edits were kept.' : `Finished · ${ready.length} hand-off file(s) ready`;
      } catch (e) { this.batchText.textContent = e.message; }
      finally {
        if(this.context.session?.id===session){this.key='';this.sync(this.context);}
        this.batch = null;this.alwaysFolder.disabled=this.configureEditors.disabled=false;this.host.setBusy(false); for(const b of this.resultLinks.querySelectorAll('.develop-view-result'))b.disabled=false; this.skipBatch.hidden = true; this.stopBatch.textContent = 'Close';
        this.scope.disabled = this.chooseFolder.disabled = false; this.startBatch.hidden = false;
      }
    }
  }
  window.PhotoCullDevelop = { init(host) { const instance=new Develop(host);this.host=host;return instance; } };
})();
