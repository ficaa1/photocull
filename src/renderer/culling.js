// Pure metadata, burst and survey state shared by the backend and renderer.
(function(root) {
  const numbers = value => Array.isArray(value) ? value.map(Number) : typeof value === 'number' ? [value] : typeof value === 'string' ? (value.match(/-?\d+(?:\.\d+)?/g) || []).map(Number) : [];
  const clamp = v => Math.min(1, Math.max(0, v));
  function orientPoint(x,y,orientation) {
    return ({2:[1-x,y],3:[1-x,1-y],4:[x,1-y],5:[y,x],6:[1-y,x],7:[1-y,1-x],8:[y,1-x]})[orientation] || [x,y];
  }
  function normalizeFocus(tags) {
    const t=tags, width=Number(t.ExifImageWidth || t.ImageWidth), height=Number(t.ExifImageHeight || t.ImageHeight);
    const orientation=Number(t.Orientation) || 1, points=[];
    function add(x,y,w=.025,h=.025,source='AF point',rw=1,rh=1) {
      if (![x,y,w,h,rw,rh].every(Number.isFinite) || rw<=0 || rh<=0 || w<=0 || h<=0) return;
      x/=rw; y/=rh; w/=rw; h/=rh;
      // Only apply a sensor crop when the AF coordinate system describes that sensor.
      // Sony FocusLocation already declares the cropped JPEG dimensions.
      const crop=numbers(t.DefaultCropSize), origin=numbers(t.DefaultCropOrigin);
      if (rw===Number(t.ImageWidth) && rh===Number(t.ImageHeight) && crop.length===2 && origin.length===2 && crop[0]>0 && crop[1]>0 && origin[0]>=0 && origin[1]>=0 && origin[0]+crop[0]<=rw && origin[1]+crop[1]<=rh) {
        x=(x*rw-origin[0])/crop[0];y=(y*rh-origin[1])/crop[1];w=w*rw/crop[0];h=h*rh/crop[1];
      }
      if (x<0 || x>1 || y<0 || y>1) return;
      [x,y]=orientPoint(x,y,orientation); if (orientation>=5 && orientation<=8) [w,h]=[h,w];
      points.push({x,y,width:Math.min(w,1),height:Math.min(h,1),source});
    }
    const sony=numbers(t.FocusLocation || t.FocusLocation2), frame=numbers(t.FocusFrameSize);
    if (sony.length===4 && sony[0]>0 && sony[1]>0 && (sony[2]!==0 || sony[3]!==0)) add(sony[2],sony[3],frame[0] || sony[0]*.025,frame[1] || sony[1]*.025,'Sony FocusLocation',sony[0],sony[1]);
    if (!points.length && /sony/i.test(t.Make || '')) {
      const area=numbers(t.FocalPlaneAFPointArea);
      if (area.length===2) for (const key of Object.keys(t).filter(k=>/^FocalPlaneAFPointLocation\d+$/.test(k)).sort()) { const p=numbers(t[key]); if(p.length===2)add(p[0],p[1],area[0]*.025,area[1]*.025,key,area[0],area[1]); }
    }
    if (!points.length && /nikon/i.test(t.Make || '') && t.AFAreaXPosition!==undefined && t.AFAreaYPosition!==undefined && !(Number(t.AFCoordinatesAvailable)===0)) {
      const rw=Number(t.AFImageWidth) || width,rh=Number(t.AFImageHeight) || height;
      if (Number(t.AFAreaXPosition)!==0 || Number(t.AFAreaYPosition)!==0) add(Number(t.AFAreaXPosition),Number(t.AFAreaYPosition),Number(t.AFAreaWidth) || rw*.025,Number(t.AFAreaHeight) || rh*.025,'Nikon AF area',rw,rh);
    }
    if (!points.length && /canon/i.test(t.Make || '')) {
      const xs=numbers(t.AFAreaXPositions),ys=numbers(t.AFAreaYPositions),ws=numbers(t.AFAreaWidths || t.AFAreaWidth),hs=numbers(t.AFAreaHeights || t.AFAreaHeight);
      const rw=Number(t.AFImageWidth),rh=Number(t.AFImageHeight),sign=/PowerShot/i.test(t.Model || '') ? 1 : -1;
      for (const i of numbers(t.AFPointsInFocus)) if (Number.isInteger(i) && i>=0 && i<xs.length && i<ys.length) add(rw/2+xs[i],rh/2+sign*ys[i],ws[i] || ws[0] || rw*.025,hs[i] || hs[0] || rh*.025,'Canon in-focus AF area',rw,rh);
    }
    if (!points.length && /fuji/i.test(t.Make || '')) { const p=numbers(t.FocusPixel); if(p.length===2)add(p[0],p[1],width*.025,height*.025,'Fujifilm FocusPixel',width,height); }
    if (!points.length && /olympus|om digital/i.test(t.Make || '')) {
      const p=numbers(t.AFPointSelected);
      if (p.length===4) { const scale=String(t.AFPointSelected).includes('%') ? 100 : 1; add((p[0]+p[2])/2,(p[1]+p[3])/2,Math.abs(p[2]-p[0]) || scale*.025,Math.abs(p[3]-p[1]) || scale*.025,'Olympus AF selection',scale,scale); }
    }
    if (!points.length && /panasonic/i.test(t.Make || '')) { const p=numbers(t.AFPointPosition);if(p.length===2)add(p[0],p[1],.025,.025,'Panasonic AF position'); }
    return points.length ? {points:points.slice(0,64),...points[0],orientation} : null;
  }
  function captureTime(captured,subsec='') {
    const m=/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(captured || '');
    if (!m) return null;
    const fraction=String(subsec || m[7] || '').replace(/^0\./,'');
    const ms=Date.UTC(...[Number(m[1]),Number(m[2])-1,...m.slice(3,7).map(Number)]);
    return Number.isFinite(ms) ? ms+Number('0.'+(fraction.match(/^\d+/)?.[0] || '0'))*1000 : null;
  }
  function groupBursts(items,gap=1) {
    const groups=[]; let group=[];
    for (const item of items) {
      const previous=group.at(-1),dt=previous && item.captureTime-previous.captureTime;
      if (!previous || !Number.isFinite(item.captureTime) || !Number.isFinite(previous.captureTime) || !item.cameraKey || item.cameraKey!==previous.cameraKey || dt<0 || dt>gap*1000) { if(group.length>1)groups.push(group);group=[]; }
      group.push(item);
    }
    if(group.length>1)groups.push(group);
    return groups.map(items=>({id:items[0].id,ids:items.map(i=>i.id)}));
  }
  function sharpest(ids,scores) {
    if (!ids.length || ids.some(id=>!Number.isFinite(scores.get(id)))) return null;
    return ids.reduce((a,b)=>scores.get(b)>scores.get(a)?b:a);
  }
  function compareState(selected,items) {
    const available=new Set(items.map(i=>i.id)), ids=[...new Set(selected)].filter(id=>available.has(id)).slice(0,4);
    if (ids.length===1) { const i=items.findIndex(item=>item.id===ids[0]),next=items[i+1] || items[i-1];if(next)ids.push(next.id); }
    return {ids,active:0,linked:true};
  }
  function swapCandidate(state,items,delta) {
    const ids=items.map(i=>i.id),current=ids.indexOf(state.ids[state.active]);
    for(let i=current+delta;i>=0 && i<ids.length;i+=delta) if(!state.ids.includes(ids[i])) { const next={...state,ids:[...state.ids]};next.ids[state.active]=ids[i];return next; }
    return state;
  }
  const api={numbers,clamp,orientPoint,normalizeFocus,captureTime,groupBursts,sharpest,compareState,swapCandidate};
  if(typeof module!=='undefined' && module.exports)module.exports=api;else root.PhotoCullCulling=api;
})(globalThis);
