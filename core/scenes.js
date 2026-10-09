(function(root) {
  'use strict';
  const entries = new Map();
  const finiteVector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const dot = (a,b) => a.reduce((sum,n,i)=>sum+n*b[i],0);
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const unit = v => { const length=Math.hypot(...v); if(!length)throw Error('A direction cannot be zero'); return v.map(n=>n/length); };
  function freeze(value) {
    if(value && typeof value==='object' && !Object.isFrozen(value)){ Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  function validate(definition) {
    const fail = message => {throw Error(`Scene ${definition.id || '(unnamed)'}: ${message}`);};
    if(!/^[a-z][a-z0-9-]*$/.test(definition.id || ''))fail('id must be a stable lowercase slug');
    for(const field of ['title','subtitle','eyebrow','study','canonicalLabel'])if(typeof definition[field]!=='string' || !definition[field].trim())fail(`missing ${field}`);
    const g=definition.geometry;
    if(!g || !Array.isArray(g.vertices) || !g.vertices.length || !g.vertices.every(finiteVector))fail('vertices must be nonempty finite [x,y,z] coordinates');
    const validIndex = n => Number.isInteger(n) && n>=0 && n<g.vertices.length;
    const edges = g.edges || [], paths = g.paths || [];
    if(!Array.isArray(edges)||!edges.every(e=>Array.isArray(e)&&e.length===2&&e.every(validIndex)&&e[0]!==e[1]))fail('invalid edge index or self-edge');
    const keys=edges.map(([a,b])=>a<b?`${a},${b}`:`${b},${a}`);
    if(new Set(keys).size!==keys.length)fail('duplicate undirected edges');
    if(!Array.isArray(paths)||!paths.every(p=>p&&Array.isArray(p.indices)&&p.indices.length>=2&&p.indices.every(validIndex)&&typeof p.closed==='boolean'))fail('paths need vertex indices and a closed boolean');
    if(!edges.length&&!paths.length)fail('at least one edge or path is required');
    const nodes=g.nodes===undefined?(paths.length?[...new Set(edges.flat())]:g.vertices.map((_,i)=>i)):g.nodes;
    if(!Array.isArray(nodes)||!nodes.every(validIndex)||new Set(nodes).size!==nodes.length)fail('invalid or repeated node index');
    const view=definition.view || {right:[1,0,0],up:[0,1,0],forward:[0,0,1]};
    const basis=[view.right,view.up,view.forward];
    if(!basis.every(finiteVector))fail('view needs right, up, and forward vectors');
    for(let i=0;i<3;i++)for(let j=i;j<3;j++)if(Math.abs(dot(basis[i],basis[j])-(i===j?1:0))>1e-8)fail('view basis must be orthonormal');
    const sourceRadius=g.vertices.reduce((max,v)=>Math.max(max,Math.hypot(...v)),0);
    const radius=definition.boundsRadius===undefined?sourceRadius:definition.boundsRadius;
    if(!Number.isFinite(radius)||radius<sourceRadius-1e-8)fail('boundsRadius must contain all vertices');
    if(radius<=0)fail('geometry radius must be positive');
    const variants=definition.variants || [];
    if(!Array.isArray(variants)||!variants.every(v=>v&&/^[a-z][a-z0-9-]*$/.test(v.id)&&typeof v.title==='string'&&v.title.trim()))fail('variants need stable ids and titles');
    if(new Set(variants.map(v=>v.id)).size!==variants.length)fail('duplicate variant id');
    if(definition.defaultVariant!==undefined&&!variants.some(v=>v.id===definition.defaultVariant))fail('defaultVariant must exist');
    const views=definition.views || [];
    if(!Array.isArray(views)||!views.every(v=>v&&/^[a-z][a-z0-9-]*$/.test(v.id)&&typeof v.title==='string'&&v.title.trim()))fail('views need stable ids and titles');
    if(new Set(views.map(v=>v.id)).size!==views.length)fail('duplicate view id');
    if(definition.defaultView!==undefined&&!views.some(v=>v.id===definition.defaultView))fail('defaultView must exist');
    if(definition.journeyStops!==undefined){
      if(typeof definition.journeyStops!=='function')fail('journeyStops must be a pure function');
      for(const variant of variants.length?variants:[{}])for(const selected of views.length?views:[{}]){
        const stops=definition.journeyStops({variantId:variant.id,parameters:variant.parameters || {},viewId:selected.id});
        if(!Array.isArray(stops)||!stops.length)fail('journeyStops must return nonempty stops');
        if(!stops.every((s,i)=>s&&/^[a-z][a-z0-9-]*$/.test(s.id)&&typeof s.title==='string'&&s.title.trim()&&Number.isFinite(s.progress)&&s.progress>=0&&s.progress<1&&(!i?s.progress===0:s.progress>stops[i-1].progress)))fail('journey stops need ids, titles and increasing progress starting at zero');
        if(new Set(stops.map(s=>s.id)).size!==stops.length)fail('duplicate journey stop id');
        if(!stops.every((s,i)=>s.leaveProgress===undefined||Number.isFinite(s.leaveProgress)&&s.leaveProgress>=s.progress&&s.leaveProgress<(stops[i+1]?.progress ?? 1)))fail('journey leaveProgress must end before the next stop');
      }
    }
    if(definition.defaultDuration!==undefined&&(!Number.isFinite(definition.defaultDuration)||definition.defaultDuration<=0))fail('defaultDuration must be positive');
    if(definition.durationRevision!==undefined&&(!Number.isInteger(definition.durationRevision)||definition.durationRevision<1))fail('durationRevision must be a positive integer');
    if(definition.previousDefaultDuration!==undefined&&(!Number.isFinite(definition.previousDefaultDuration)||definition.previousDefaultDuration<=0))fail('previousDefaultDuration must be positive');
    if(definition.camera!==undefined&&typeof definition.camera!=='function')fail('camera must be a pure function');
    if(definition.occludes!==undefined&&typeof definition.occludes!=='function')fail('occludes must be a pure function');
    for(const key of ['prepareDeform','prepareOcclusion'])if(definition[key]!==undefined&&typeof definition[key]!=='function')fail(key+' must be a pure function');
    if(definition.gpu!==undefined&&(!definition.gpu||definition.gpu.type!=='torus'||!Array.isArray(definition.gpu.uv)||definition.gpu.uv.length!==g.vertices.length||!definition.gpu.uv.every(v=>Array.isArray(v)&&v.length===4&&v.every(Number.isFinite)&&Math.abs(v[0]**2+v[1]**2-1)<1e-8&&Math.abs(v[2]**2+v[3]**2-1)<1e-8)||typeof definition.gpuParameters!=='function'||!g.paths.length||!g.paths.every(p=>p.closed&&p.indices.length%(definition.renderStride || 1)===0)))fail('invalid analytic GPU torus');
    if(definition.renderStride!==undefined&&(!Number.isInteger(definition.renderStride)||definition.renderStride<1||definition.renderStride>4))fail('renderStride must be an integer from 1 to 4');
    if(definition.zoom!==undefined&&typeof definition.zoom!=='function')fail('zoom must be a pure function');
    const maxZoom=definition.maxZoom ?? 1;
    if(!Number.isFinite(maxZoom)||maxZoom<1)fail('maxZoom must be finite and at least one');
    if(definition.deform!==undefined&&typeof definition.deform!=='function')fail('deform must be a pure function');
    if(definition.motion!==undefined && !['orbit','still'].includes(definition.motion) && typeof definition.motion!=='function')fail('motion must be orbit, still, or a pure function');
    if(definition.project!==undefined && typeof definition.project!=='function')fail('project must be a pure function');
    if(definition.project && !g.vertices.every(v=>finiteVector(definition.project(v))))fail('custom projection must return finite [screenX,screenY,depth]');
    return {...definition,geometry:{vertices:g.vertices.map(v=>v.slice()),edges:edges.map(e=>e.slice()),paths:paths.map(p=>({indices:p.indices.slice(),closed:p.closed})),nodes:nodes.slice()},view:{right:view.right.slice(),up:view.up.slice(),forward:view.forward.slice()},variants:variants.map(v=>({...v,parameters:JSON.parse(JSON.stringify(v.parameters||{}))})),defaultVariant:definition.defaultVariant || variants[0]?.id,views:views.map(v=>({...v})),defaultView:definition.defaultView || views[0]?.id,maxZoom,radius,motion:definition.motion || 'orbit'};
  }
  function register(definition) {
    const scene=validate(definition);
    if(entries.has(scene.id))throw Error(`Duplicate scene id: ${scene.id}`);
    entries.set(scene.id,freeze(scene));return scene;
  }
  // Curves become one stroke per path, rather than many expensive glow gradients.
  function geometryBuilder() {
    const vertices=[],edges=[],paths=[],nodes=new Set();
    return {
      vertex(point,{joint=false}={}) {if(!finiteVector(point))throw Error('Invalid point'); const i=vertices.push(point.slice())-1;if(joint)nodes.add(i);return i;},
      edge(a,b) {edges.push([a,b]);nodes.add(a);nodes.add(b);return this;},
      path(points,{closed=false,joints=false}={}) {const indices=points.map(p=>this.vertex(p,{joint:joints}));paths.push({indices,closed});return this;},
      circle({center=[0,0,0],normal=[0,0,1],radius=1,samples=64}) {
        if(!finiteVector(center)||!finiteVector(normal)||!Number.isFinite(radius)||radius<=0||!Number.isInteger(samples)||samples<12||samples>512)throw Error('Invalid circle');
        const n=unit(normal),ref=Math.abs(n[0])<.9?[1,0,0]:[0,1,0],u=unit(cross(n,ref)),v=cross(n,u);
        return this.path(Array.from({length:samples},(_,i)=>{const t=i/samples*Math.PI*2;return center.map((p,j)=>p+radius*(Math.cos(t)*u[j]+Math.sin(t)*v[j]));}),{closed:true});
      },
      build(){return {vertices:vertices.map(v=>v.slice()),edges:edges.map(e=>e.slice()),paths:paths.map(p=>({...p,indices:p.indices.slice()})),nodes:[...nodes]};}
    };
  }
  const api={register,validate,get:id=>entries.get(id),list:()=>[...entries.values()],geometryBuilder,dot};
  root.AmbientScenes=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
