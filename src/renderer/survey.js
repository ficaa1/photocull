// Survey panes reuse the loupe geometry so zoom, pan and AF marks share one coordinate system.
// A pinned reference turns Compare into Reference + incoming: the left pane stays put and the
// right pane swaps in each new capture without moving the shared view.
(() => {
  const C=PhotoCullCulling,V=PhotoCullView;
  const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;};
  class Survey {
    constructor(host) {
      this.host=host;this.root=document.getElementById('compare');this.state={ids:[],active:0,linked:true};this.panes=[];this.shape='';this.syncing=false;this.pin=null;
      const bar=el('div','compare-bar'),label=el('label'),check=this.link=el('input');check.type='checkbox';check.checked=true;
      check.onchange=()=>{this.state.linked=check.checked;if(check.checked)this.changed(this.state.active);};label.append(check,document.createTextNode(' Link zoom & pan'));
      const fit=el('button','button quiet','Fit all');fit.onclick=()=>{for(const p of this.panes)p.view.reset();};
      this.hint=el('span','compare-hint','Click a pane or Tab to focus · P / X / 0–5 · ← → swap candidate · Z zoom · C close');
      this.shortlist = []; this.page = 0;
      this.pageNav = el('div','compare-pages'); this.pageNav.hidden = true;
      this.pageLabel = el('span'); this.pageLabel.setAttribute('role','status');
      this.prevPage = el('button','button quiet'); this.nextPage = el('button','button quiet');
      this.prevPage.dataset.paletteAction = 'compare-previous-page';
      this.nextPage.dataset.paletteAction = 'compare-next-page';
      this.prevPage.dataset.paletteCategory = this.nextPage.dataset.paletteCategory = 'Compare';
      this.prevPage.onclick = () => this.turnPage(-1); this.nextPage.onclick = () => this.turnPage(1);
      this.pageNav.append(this.pageLabel,this.prevPage,this.nextPage);
      bar.append(label,fit,this.pageNav,this.hint);
      this.container=el('div','compare-panes');this.root.append(bar,this.container);
    }
    open(selected,items) {
      this.pin = null;
      this.shortlist = selected.length > 4 ? selected.slice() : [];
      this.page = 0;
      this.state = C.compareState(selected,items);
      this.link.checked = this.state.linked;
      this.shape = '';
      return this.state.ids.length >= 2;
    }
    pinReference(id) {
      const item=this.host.item(id);if(!item || item.trashed)return false;
      const candidate=this.pin?.candidate!==id?this.pin?.candidate ?? null:null;
      this.shortlist=[];this.pageNav.hidden=true;this.pin={reference:id,candidate};this.state={ids:[id],active:1,linked:this.state.linked};return true;
    }
    unpin() {this.pin=null;}
    remap(map) {this.shortlist=[...new Set(this.shortlist.map(id=>map.get(id)??id))];if(this.pin)for(const key of ['reference','candidate'])if(map.has(this.pin[key]))this.pin[key]=map.get(this.pin[key]);this.state.ids=this.state.ids.map(id=>map.get(id)??id);}
    pinned() {return this.pin ? {...this.pin} : null;}
    // The right pane only: the reference never becomes its own candidate. The selection follows only while the incoming pane is active,
    // so decisions keep going to the reference when the user is working on it.
    setCandidate(id) {
      if(!this.pin || id===this.pin.reference || id===this.pin.candidate)return false;
      this.pin.candidate=id;if(!this.root.hidden)this.sync(true);
      if(this.state.active===1)this.host.activate(id);
      return true;
    }
    sync(active) {
      this.root.hidden = !active;
      if (!active) return;
      if (this.pin) return this.syncPinned();
      this.pageNav.hidden = !this.shortlist.length;
      this.hint.hidden = !this.pageNav.hidden;
      if (this.shortlist.length) return this.syncPage();
      const items=this.host.items(), available=new Set(items.map(item=>item.id));
      if (!items.length) { this.root.hidden=true; return; }
      this.state.ids=this.state.ids.filter(id=>available.has(id));
      if(this.state.ids.length<2)this.state.ids=C.compareState(this.state.ids.length?this.state.ids:[items[0].id],items).ids;
      this.state.active=Math.min(this.state.active,Math.max(0,this.state.ids.length-1));
      this.layout(this.state.ids);
    }
    syncPage() {
      const available = new Set(this.host.library().map(item => item.id));
      const ids = this.shortlist.filter(id => available.has(id));
      if (!ids.length) { this.root.hidden = true; return; }
      this.page = Math.min(this.page, Math.floor((ids.length - 1) / 4));
      const start = this.page * 4;
      this.state.ids = ids.slice(start, start + 4);
      this.state.active = Math.min(this.state.active, this.state.ids.length - 1);
      this.pageLabel.textContent = `Photos ${start + 1}–${start + this.state.ids.length} of ${ids.length} selected`;
      this.prevPage.textContent = 'Previous 4';
      this.prevPage.disabled = start === 0;
      const remaining = ids.length - start - 4;
      this.nextPage.textContent = remaining > 0 ? `Next ${Math.min(4,remaining)}` : 'Next';
      this.nextPage.disabled = remaining <= 0;
      this.layout(this.state.ids);
      this.host.activate(this.state.ids[this.state.active]);
    }
    turnPage(delta) {
      if ((delta<0 ? this.prevPage : this.nextPage).disabled) return;
      this.page+=delta; this.sync(true);
      this.panes[this.state.active]?.pane.focus();
    }
    syncPinned() {
      this.hint.hidden=false;
      const live=id=>{const item=id && this.host.item(id);return item && !item.trashed ? item : null;};
      if(!live(this.pin.reference)) {this.pin=null;this.host.unpinned?.('Reference shot removed · pin cleared');return;}
      if(!live(this.pin.candidate))this.pin.candidate=null;
      this.state.ids=[this.pin.reference,...(this.pin.candidate?[this.pin.candidate]:[])];this.state.active=Math.min(this.state.active,1);
      this.layout([this.pin.reference,this.pin.candidate]);
    }
    // Panes are rebuilt only when their number or kind changes. Otherwise a pane reloads alone when its photo or
    // rendition changes, so focus, zoom and pan survive each new capture.
    layout(ids) {
      const shape=`${this.host.session()}:${this.pin?'pin':'compare'}:${ids.length}`;
      if(shape!==this.shape) {this.shape=shape;this.build(ids.length);}
      let changed=false;
      ids.forEach((id,index)=>{const pane=this.panes[index];if(pane.key!==this.key(id)){this.show(pane,id);changed=true;}});
      const shown=this.panes.map(p=>p.id).filter(Boolean);
      if(changed && shown.length)void this.host.api.focus(this.host.session(),shown).catch(()=>{});
      this.refresh();
    }
    key(id) {const item=id && this.host.item(id);return item ? `${id}:${item.contentRev||0}:${item.developRevision||0}:${item.externalEdit?1:0}:${this.host.revision()}` : '';}
    build(count) {
      const previous=this.panes[this.state.active]?.view;
      const zoom=previous && {...previous.zoom},center=previous && {...previous.center};
      for(const p of this.panes)p.view.destroy();this.panes=[];this.container.replaceChildren();
      this.container.style.gridTemplateRows=count>2?'repeat(2,minmax(0,1fr))':'minmax(0,1fr)';
      this.root.classList.toggle('pinned',!!this.pin);
      this.hint.textContent=this.pin ? 'Reference stays fixed · the right pane shows the latest capture · P / X / 0–5 apply to the active pane' : 'Click a pane or Tab to focus · P / X / 0–5 · ← → swap candidate · Z zoom · C close';
      Array.from({length:count},(_,index)=>{
        const pane=el('article','compare-pane');pane.tabIndex=0;
        const viewport=el('div','compare-photo'),image=el('img');image.draggable=false;viewport.append(image);
        const waiting=el('p','compare-waiting','Waiting for next capture…');waiting.hidden=true;viewport.append(waiting);
        const caption=el('div','compare-caption'),name=el('span');caption.append(name);
        const record={id:null,key:null,pane,viewport,image,view:null,name,rating:null,kind:'preview',request:0,waiting,reference:!!this.pin && index===0};
        if(record.reference) {
          const badge=el('span','reference-badge','Reference');pane.append(badge);
          const replace=el('button','button quiet','Replace reference');replace.title='Use the active photo as the reference';replace.onclick=()=>this.host.replaceReference?.();
          const unpin=el('button','button quiet','Unpin');unpin.onclick=()=>this.host.unpin?.();
          caption.append(replace,unpin);
        }
        for(const [text,flag] of [['P','pick'],['X','reject'],['U','none']]) {const b=el('button','button quiet',text);b.title=flag==='none'?'Clear flag':flag==='pick'?'Pick':'Reject';b.onclick=()=>{if(!record.id)return;this.activate(index);void this.host.decide(record.id,{flag});};caption.append(b);}
        const rating=record.rating=el('select');
        for(let i=0;i<=5;i++){const o=el('option','',i?`${i} ★`:'—');o.value=i;rating.append(o);}rating.onchange=()=>{if(!record.id)return;this.activate(index);void this.host.decide(record.id,{rating:Number(rating.value)});};caption.append(rating);
        pane.append(viewport,caption);this.container.append(pane);
        const view=record.view=new V.ImageView(viewport,image,{onClick:()=>view.set(view.zoomed?{mode:'fit',percent:100}:{mode:'ratio',percent:100}),onChange:()=>this.changed(index)});
        this.panes.push(record);
        viewport.addEventListener('pointerdown',()=>this.activate(index),true);pane.addEventListener('focusin',()=>this.activate(index));
        view.zoom=zoom || {mode:'fit',percent:100};view.center=center || {x:.5,y:.5};
      });
    }
    // Loads `id` into an existing pane; the view keeps its zoom and center, so linked panes stay aligned.
    show(record,id) {
      const item=id && this.host.item(id),request=++record.request;record.id=item ? id : null;record.key=this.key(id);record.kind='preview';
      record.waiting.hidden=!!item;record.pane.classList.toggle('waiting',!item);
      record.pane.setAttribute('aria-label',item ? `${record.reference?'Reference':this.pin?'Incoming':'Compare '+(this.panes.indexOf(record)+1)}: ${item.name}` : 'Incoming: waiting for next capture');
      record.rating.disabled=!item;record.rating.setAttribute('aria-label',item ? `Rating for ${item.name}` : 'Rating');
      if(!item) {record.image.removeAttribute('src');record.image.alt='';record.view.setVisible(false);record.name.textContent='Incoming';return;}
      record.image.alt=item.name;
      record.image.onload=()=>{if(request!==record.request)return;record.view.setSource({width:record.image.naturalWidth,height:record.image.naturalHeight});record.view.setVisible(true);};
      record.image.onerror=()=>{if(request===record.request)record.name.textContent=`${item.name} · preview unavailable`;};record.image.src=this.host.url(item,'preview');
      const session=this.host.session();
      void this.host.api.previewStatus(session,id,'preview').then(status=>{if(request===record.request && this.panes.includes(record) && status.size)record.view.setSource(status.size,true);}).catch(()=>{});
      void this.host.metadata(id).then(()=>{if(this.panes.includes(record))this.refresh();}).catch(()=>{});
    }
    activate(index) {const id=this.panes[index]?.id ?? this.state.ids[index];this.state.active=index;if(id)this.host.activate(id);this.refresh();}
    refresh() {
      for(const [i,p] of this.panes.entries()) {
        p.pane.classList.toggle('active',i===this.state.active);
        const item=p.id && this.host.item(p.id);if(!item)continue;
        p.name.textContent=`${item.name}${item.flag==='pick'?' · Pick':item.flag==='reject'?' · Reject':''}`;p.name.title=p.name.textContent;p.rating.value=item.rating;
        p.view.setFocus(this.host.focus(p.id),this.host.overlay());
      }
    }
    changed(index) {
      if(this.syncing)return;const pane=this.panes[index];if(!pane)return;
      if(this.state.linked) {this.syncing=true;try{for(const p of this.panes)if(p!==pane)p.view.set({...pane.view.zoom},{center:{...pane.view.center}});}finally{this.syncing=false;}}
      for(const p of this.panes) {
        if(!p.id || p.kind==='full' || Math.max(p.view.box().width,p.view.box().height)*p.view.dpr()<=2560)continue;
        p.kind='full';const request=p.request,probe=new Image(),url=this.host.url(this.host.item(p.id),'full');probe.onload=()=>{if(this.panes.includes(p) && request===p.request){p.image.src=url;p.view.setSource({width:probe.naturalWidth,height:probe.naturalHeight},true);}};probe.src=url;
      }
    }
    swap(delta) {
      if (this.shortlist.length) { this.turnPage(delta); return; }
      if(this.pin) {
        const items=this.host.items().filter(i=>i.id!==this.pin.reference),index=items.findIndex(i=>i.id===this.pin.candidate);
        const next=items[index<0 ? (delta<0?items.length-1:0) : Math.max(0,Math.min(items.length-1,index+delta))];
        if(next && this.setCandidate(next.id)) {this.host.candidateChosen?.(next.id);this.activate(1);}
        return;
      }
      this.state=C.swapCandidate(this.state,this.host.items(),delta);this.sync(true);this.activate(this.state.active);
    }
    zoomAction(action) {
      const p=this.panes[this.state.active];if(!p)return;
      if(action==='fit')p.view.reset();
      else if(action==='toggle' || action==='space')p.view.set(p.view.zoomed?{mode:'fit',percent:100}:{mode:'ratio',percent:100});
      else {const next=V.stepPercent(p.view.percent(),action==='zoom-out'?-1:1,p.view.fitPercent());p.view.set(next===null?{mode:'fit',percent:100}:{mode:'ratio',percent:next});}
    }
    zoomFocus(focus) {const p=this.panes[this.state.active];if(p && focus)p.view.set({mode:'ratio',percent:100},{centerOn:focus});}

  }
  window.PhotoCullSurvey={create:host=>new Survey(host)};
})();
