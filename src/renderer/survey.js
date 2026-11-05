// Survey panes reuse the loupe geometry so zoom, pan and AF marks share one coordinate system.
(() => {
  const C=PhotoCullCulling,V=PhotoCullView;
  const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;};
  class Survey {
    constructor(host) {
      this.host=host;this.root=document.getElementById('compare');this.state={ids:[],active:0,linked:true};this.panes=[];this.signature='';this.syncing=false;
      const bar=el('div','compare-bar'),label=el('label'),check=this.link=el('input');check.type='checkbox';check.checked=true;
      check.onchange=()=>{this.state.linked=check.checked;if(check.checked)this.changed(this.state.active);};label.append(check,document.createTextNode(' Link zoom & pan'));
      const fit=el('button','button quiet','Fit all');fit.onclick=()=>{for(const p of this.panes)p.view.reset();};
      bar.append(label,fit,el('span','compare-hint','Click a pane or Tab to focus · P / X / 0–5 · ← → swap candidate · Z zoom · C close'));
      this.container=el('div','compare-panes');this.root.append(bar,this.container);
    }
    open(selected,items) {this.state=C.compareState(selected,items);this.signature='';return this.state.ids.length>=2;}
    sync(active) {
      this.root.hidden=!active;if(!active)return;
      const items=this.host.items(),available=new Set(items.map(i=>i.id));
      this.state.ids=this.state.ids.filter(id=>available.has(id));this.state.active=Math.min(this.state.active,Math.max(0,this.state.ids.length-1));
      const signature=`${this.host.session()}:${this.state.ids.join(':')}:${this.host.revision()}`;
      if(signature!==this.signature) {this.signature=signature;this.build();}
      this.refresh();
    }
    build() {
      const previous=this.panes[this.state.active]?.view;
      const zoom=previous && {...previous.zoom},center=previous && {...previous.center};
      for(const p of this.panes)p.view.destroy();this.panes=[];this.container.replaceChildren();
      this.container.style.gridTemplateRows=this.state.ids.length>2?'repeat(2,minmax(0,1fr))':'minmax(0,1fr)';
      this.state.ids.forEach((id,index)=>{
        const item=this.host.item(id),pane=el('article','compare-pane');pane.tabIndex=0;pane.setAttribute('aria-label',`Compare ${index+1}: ${item.name}`);
        const viewport=el('div','compare-photo'),image=el('img');image.alt=item.name;image.draggable=false;viewport.append(image);
        const caption=el('div','compare-caption'),name=el('span');caption.append(name);
        for(const [text,flag] of [['P','pick'],['X','reject'],['U','none']]) {const b=el('button','button quiet',text);b.title=flag==='none'?'Clear flag':flag==='pick'?'Pick':'Reject';b.onclick=()=>{this.activate(index);void this.host.decide(id,{flag});};caption.append(b);}
        const rating=el('select');rating.setAttribute('aria-label',`Rating for ${item.name}`);
        for(let i=0;i<=5;i++){const o=el('option','',i?`${i} ★`:'—');o.value=i;rating.append(o);}rating.onchange=()=>{this.activate(index);void this.host.decide(id,{rating:Number(rating.value)});};caption.append(rating);
        pane.append(viewport,caption);this.container.append(pane);
        const view=new V.ImageView(viewport,image,{onClick:()=>view.set(view.zoomed?{mode:'fit',percent:100}:{mode:'ratio',percent:100}),onChange:()=>this.changed(index)});
        const record={id,pane,viewport,image,view,name,rating,kind:'preview',request:0};this.panes.push(record);
        viewport.addEventListener('pointerdown',()=>this.activate(index),true);pane.addEventListener('focusin',()=>this.activate(index));
        view.zoom=zoom || {mode:'fit',percent:100};view.center=center || {x:.5,y:.5};
        image.onload=()=>{if(!view.source)view.setSource({width:image.naturalWidth,height:image.naturalHeight});view.setVisible(true);};
        image.onerror=()=>{name.textContent=`${item.name} · preview unavailable`;};image.src=this.host.url(item,'preview');
        const session=this.host.session();
        void this.host.api.previewStatus(session,id,'preview').then(status=>{if(this.panes.includes(record) && status.size)view.setSource(status.size,true);}).catch(()=>{});
        void this.host.metadata(id).then(()=>{if(this.panes.includes(record))this.refresh();}).catch(()=>{});
      });
      void this.host.api.focus(this.host.session(),this.state.ids).catch(()=>{});
    }
    activate(index) {this.state.active=index;this.host.activate(this.state.ids[index]);this.refresh();}
    refresh() {
      for(const [i,p] of this.panes.entries()) {
        const item=this.host.item(p.id);if(!item)continue;
        p.pane.classList.toggle('active',i===this.state.active);p.name.textContent=`${item.name}${item.flag==='pick'?' · Pick':item.flag==='reject'?' · Reject':''}`;p.name.title=p.name.textContent;p.rating.value=item.rating;
        p.view.setFocus(this.host.focus(p.id),this.host.overlay());
      }
    }
    changed(index) {
      if(this.syncing)return;const pane=this.panes[index];if(!pane)return;
      if(this.state.linked) {this.syncing=true;try{for(const p of this.panes)if(p!==pane)p.view.set({...pane.view.zoom},{center:{...pane.view.center}});}finally{this.syncing=false;}}
      for(const p of this.panes) {
        if(p.kind==='full' || Math.max(p.view.box().width,p.view.box().height)*p.view.dpr()<=2560)continue;
        p.kind='full';const probe=new Image(),url=this.host.url(this.host.item(p.id),'full');probe.onload=()=>{if(this.panes.includes(p)){p.image.src=url;p.view.setSource({width:probe.naturalWidth,height:probe.naturalHeight},true);}};probe.src=url;
      }
    }
    zoomFocus(focus) {const p=this.panes[this.state.active];if(p && focus)p.view.set({mode:'ratio',percent:100},{centerOn:focus});}
    key(event) {
      if(this.root.hidden || event.altKey)return false;
      const p=this.panes[this.state.active];if(!p)return false;
      const key=event.key.toLowerCase();let handled=true;
      if(!event.ctrlKey && !event.metaKey && ['ArrowLeft','ArrowRight'].includes(event.key)) {this.state=C.swapCandidate(this.state,this.host.items(),event.key==='ArrowRight'?1:-1);this.sync(true);this.activate(this.state.active);}
      else if(!event.ctrlKey && !event.metaKey && ['p','x','u'].includes(key))void this.host.decide(p.id,{flag:{p:'pick',x:'reject',u:'none'}[key]});
      else if(!event.ctrlKey && !event.metaKey && /^[0-5]$/.test(key))void this.host.decide(p.id,{rating:Number(key)});
      else if(!event.ctrlKey && !event.metaKey && key==='z')p.view.set(p.view.zoomed?{mode:'fit',percent:100}:{mode:'ratio',percent:100});
      else if((event.ctrlKey || event.metaKey) && ['+','=','-','0'].includes(key)) {if(key==='0')p.view.reset();else {const next=V.stepPercent(p.view.percent(),key==='-'?-1:1,p.view.fitPercent());p.view.set(next===null?{mode:'fit',percent:100}:{mode:'ratio',percent:next});}}
      else handled=false;
      if(handled)event.preventDefault();return handled;
    }
  }
  window.PhotoCullSurvey={create:host=>new Survey(host)};
})();
