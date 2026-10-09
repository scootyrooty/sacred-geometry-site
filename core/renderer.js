/* Shared renderer. Scene definitions supply geometry and view, never browser controls. */
(function(root){
  'use strict';
  // Clip a 3D line in homogeneous camera coordinates before dividing by depth.
  // Near and viewport planes prevent behind-eye joins and huge canvas coordinates.
  function clipSegment(a,b,camera,halfX,halfY,out){
    const {invDistance:k,gain,near}=camera,da=1-k*a.z,db=1-k*b.z;
    const ax=gain*a.x,bx=gain*b.x,ay=gain*a.y,by=gain*b.y;
    let low=0,high=1;
    for(let plane=0;plane<5;plane++){
      let first,last;
      if(plane===0){first=da-near*k;last=db-near*k;}
      else if(plane===1){first=ax+halfX*da;last=bx+halfX*db;}
      else if(plane===2){first=-ax+halfX*da;last=-bx+halfX*db;}
      else if(plane===3){first=ay+halfY*da;last=by+halfY*db;}
      else {first=-ay+halfY*da;last=-by+halfY*db;}
      if(first<0&&last<0)return null;
      if(first<0)low=Math.max(low,first/(first-last));
      else if(last<0)high=Math.min(high,first/(first-last));
      if(low>high)return null;
    }
    const result=out || [{x:0,y:0,z:0},{x:0,y:0,z:0}];
    for(let i=0;i<2;i++){
      const t=i?high:low,z=a.z+(b.z-a.z)*t,d=1-k*z,p=result[i];
      p.x=gain*(a.x+(b.x-a.x)*t)/d;p.y=gain*(a.y+(b.y-a.y)*t)/d;p.z=z;
    }
    return result;
  }
  function create(canvas,options={}){
  const TAU=Math.PI*2,RADIUS=Math.sqrt(12),ctx=canvas.getContext('2d',{alpha:false});
  let width=0,height=0,dpr=1,scale=1,settings,nativeViewport;
  let timings={projectionMs:0,visibilityMs:0,strokeMs:0,backend:'Canvas'};
  const gpuWanted=options.gpu===true || options.gpu!==false&&(root.AmbientPlatform?.embedded || root.location?.search.includes('gpu=1'));
  let gpu,gpuFailed=false;
  const now=()=>root.performance?.now() || 0;
  const drawingCache=new WeakMap();
  function drawingGeometry(scene){
    const source=scene.geometry,step=settings.quality==='high'?1:scene.renderStride || 1;
    let cache=drawingCache.get(source);if(!cache){cache=new Map();drawingCache.set(source,cache);}
    if(cache.has(step))return cache.get(step);
    const paths=source.paths.map(path=>{
      if(step===1||path.indices.length<step*12||path.closed&&path.indices.length%step)return path;
      return {...path,indices:path.indices.filter((_,i)=>i%step===0||!path.closed&&i===path.indices.length-1)};
    });
    const indices=step===1?null:[...new Set([...source.edges.flat(),...source.nodes,...paths.flatMap(path=>path.indices)])];
    // Mutable drawing storage belongs to this renderer, never the scene.
    const points=new Array(source.vertices.length);
    for(const index of indices || source.vertices.keys())points[index]={x:0,y:0,z:0};
    const store=()=>({items:[],length:0});
    const drawing={...source,paths,indices,points,modelPoints:new Array(source.vertices.length),hidden:new Int8Array(source.vertices.length),edgeSegments:store(),curveSegments:paths.map(store)};
    cache.set(step,drawing);return drawing;
  }
  const stars = [];
  let seed = 91827;
  const random = () => { seed = (Math.imul(seed,1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i=0; i<560; i++) stars.push({r:random(), a:random()*TAU, p:random()*TAU, turns:i%5===0?-1:1, twinkle:1+i%4, size:.35+random()*1.25, bright:.2+random()*.8});

  function frameContext(scene,seconds,canonical,animation) {
    const m=AmbientTimeline.motion(scene,seconds,settings,canonical);
    const variant=scene.variants.find(v=>v.id===settings.forms?.[scene.id]) || scene.variants.find(v=>v.id===scene.defaultVariant);
    const view=scene.views?.find(v=>v.id===settings.views?.[scene.id]) || scene.views?.find(v=>v.id===scene.defaultView);
    const duration=AmbientTimeline.durationFor(scene,settings);
    const t=canonical||m.holding?0:AmbientTimeline.wrap(seconds,duration);
    const progress=t===0?0:(t-settings.hold)/(duration-settings.hold);
    return {m,context:{seconds:t,phase:t/duration,progress,eased:AmbientTimeline.smooth(progress),holding:m.holding,animationPhase:animation?.phase,animationPeriod:animation?.period,variantId:variant?.id,parameters:variant?.parameters || {},viewId:view?.id}};
  }
  function camera(scene,seconds,canonical=false){
    const pose=scene.camera?scene.camera(frameContext(scene,seconds,canonical).context):{amount:0,distance:scene.radius*3,fov:60,near:.01};
    if(!pose||!['amount','distance','fov','near'].every(k=>Number.isFinite(pose[k]))||pose.amount<0||pose.amount>1||pose.near<=0||pose.distance<=pose.near||pose.fov<=0||pose.fov>=175)throw Error(`Scene ${scene.id}: invalid perspective camera`);
    const normalization=RADIUS/scene.radius,distance=pose.distance*normalization;
    const invDistance=pose.amount/distance;
    const axis=pose.fovAxis || 'short',surfaceOpacity=pose.surfaceOpacity ?? 0;
    if(!['short','vertical','horizontal'].includes(axis)||!Number.isFinite(surfaceOpacity)||surfaceOpacity<0||surfaceOpacity>1)throw Error(`Scene ${scene.id}: invalid camera lens/surface`);
    const focal=(axis==='vertical'?height:axis==='horizontal'?width:Math.min(width,height))/2/Math.tan(pose.fov*Math.PI/360)*settings.size/100;
    const gain=1-pose.amount+pose.amount*focal/(distance*scale);
    const ratio=RADIUS*invDistance;
    const envelope=ratio>=1?1e6:Math.max(1,gain/Math.sqrt(1-ratio*ratio));
    return {...pose,surfaceOpacity,invDistance,gain,near:pose.near*normalization,envelope};
  }
  function animationClock(scene,seconds){const period=AmbientTimeline.durationFor(scene,settings);return {phase:AmbientTimeline.wrap(seconds,period)/period,period};}
  function zoom(scene,seconds,canonical=false) {
    if(!scene.zoom)return 1;
    const {m,context}=frameContext(scene,seconds,canonical);
    const value=m.holding?1:scene.zoom(context);
    if(!Number.isFinite(value)||value<1||value>scene.maxZoom)throw Error(`Scene ${scene.id}: zoom exceeds finite maxZoom`);
    return value;
  }
  function project(scene,seconds,canonical=false,animation=animationClock(scene,seconds),indices=null,target=null,models=null) {
    const {m,context}=frameContext(scene,seconds,canonical,animation),sx=Math.sin(m.x),cx=Math.cos(m.x),sy=Math.sin(m.y),cy=Math.cos(m.y),sz=Math.sin(m.z),cz=Math.cos(m.z);
    const normalization=RADIUS/scene.radius,deform=scene.prepareDeform?scene.prepareDeform(context):scene.deform?(v,i)=>scene.deform(v,i,context):null;
    if(deform&&typeof deform!=='function')throw Error(`Scene ${scene.id}: invalid prepared deformation`);
    const radiusSquared=(scene.radius+1e-8)**2,right=scene.view.right,up=scene.view.up,forward=scene.view.forward;
    const projectVertex=(vertex,index)=>{
      const point=deform?deform(vertex,index):vertex;
      if(models)models[index]=point;
      if(deform&&(!Array.isArray(point)||point.length!==3||!Number.isFinite(point[0])||!Number.isFinite(point[1])||!Number.isFinite(point[2])||point[0]*point[0]+point[1]*point[1]+point[2]*point[2]>radiusSquared))throw Error(`Scene ${scene.id}: deformation exceeds finite boundsRadius`);
      const [x,y,z]=point;
      const y1=y*cx-z*sx,z1=y*sx+z*cx,x2=x*cy+z1*sy,z2=-x*sy+z1*cy,x3=x2*cz-y1*sz,y3=x2*sz+y1*cz;
      if(!target){
        if(scene.project){const p=scene.project([x3,y3,z2]);return {x:p[0]*normalization,y:p[1]*normalization,z:p[2]*normalization};}
        return {x:(x3*right[0]+y3*right[1]+z2*right[2])*normalization,y:-(x3*up[0]+y3*up[1]+z2*up[2])*normalization,z:(x3*forward[0]+y3*forward[1]+z2*forward[2])*normalization};
      }
      const result=target[index];
      if(scene.project){const p=scene.project([x3,y3,z2]);result.x=p[0]*normalization;result.y=p[1]*normalization;result.z=p[2]*normalization;}
      else {result.x=(x3*right[0]+y3*right[1]+z2*right[2])*normalization;result.y=-(x3*up[0]+y3*up[1]+z2*up[2])*normalization;result.z=(x3*forward[0]+y3*forward[1]+z2*forward[2])*normalization;}
      return result;
    };
    if(target){for(const index of indices || scene.geometry.vertices.keys())projectVertex(scene.geometry.vertices[index],index);return target;}
    if(!indices)return scene.geometry.vertices.map(projectVertex);
    const points=new Array(scene.geometry.vertices.length);
    for(const index of indices)points[index]=projectVertex(scene.geometry.vertices[index],index);
    return points;
  }
  function screenProject(scene,seconds,canonical=false,animation=animationClock(scene,seconds)){
    const pose=camera(scene,seconds,canonical);
    return project(scene,seconds,canonical,animation).map(p=>{
      const depth=1-pose.invDistance*p.z;
      return depth<pose.near*pose.invDistance?null:{x:p.x*pose.gain/depth,y:p.y*pose.gain/depth,z:p.z};
    });
  }
  function resize(nextSettings, budgetDpr=1.6) {
    settings=nextSettings;
    width = window.innerWidth; height = window.innerHeight;
    if(root.AmbientPlatform?.embedded){
      // CSS pixels differ from display pixels at Android densities such as 1.5.
      // Use the native View dimensions when supplied; never reduce Android resolution.
      const exact=nativeViewport && nativeViewport.layoutWidth===width && nativeViewport.layoutHeight===height;
      canvas.width=exact?nativeViewport.width:Math.round(width*(window.devicePixelRatio||1));
      canvas.height=exact?nativeViewport.height:Math.round(height*(window.devicePixelRatio||1));
      dpr=canvas.width/width;
    }else{
      const cap=settings.quality==='soft'?1:settings.quality==='high'?2:budgetDpr;
      dpr=Math.min(window.devicePixelRatio||1,cap);
      canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
    }
    ctx.setTransform(canvas.width/width,0,0,canvas.height/height,0,0);
    scale = Math.min(width,height)*.385/RADIUS*settings.size/100;
    // Initialize static shader/buffer resources before the opening frame,
    // rather than paying compilation/allocation during an interior hold.
    if(gpuWanted&&!gpu&&!gpuFailed&&settings.quality==='soft'&&settings.glow===0&&settings.trails===0){
      try{gpu=root.AmbientTorusGPU?.create();if(gpu){for(const scene of root.AmbientScenes.list())if(scene.gpu)gpu.prepare(scene);}else gpuFailed=true;}catch(error){gpuFailed=true;}
    }
  }

  function color(point, phase, alpha=1, lightness=60) {
    
    const radial = Math.hypot(point.x,point.y)/RADIUS;
    const spatial = (point.x*.13 + point.y*.11 + point.z*.10 + radial*.3);
    const wave = Math.sin(TAU*(phase*4-spatial));
    let hue;
    switch (settings.palette) {
      case 'aurora': hue=164+40*wave; break;
      case 'violet': hue=278+36*wave; break;
      case 'ember': hue=30+24*wave; break;
      default: hue=phase*720+spatial*230+230;
    }
    return `hsla(${hue},92%,${lightness}%,${Math.max(0,Math.min(1,alpha))})`;
  }
  function rgb(point,phase,lightness){
    const hue=Number(color(point,phase,1,lightness).split('(')[1].split(',')[0]),h=((hue/60)%6+6)%6,l=lightness/100,c=(1-Math.abs(2*l-1))*.92,x=c*(1-Math.abs(h%2-1)),m=l-c/2;
    const value=h<1?[c,x,0]:h<2?[x,c,0]:h<3?[0,c,x]:h<4?[0,x,c]:h<5?[x,0,c]:[c,0,x];return value.map(v=>v+m);
  }
  function gpuWireframe(scene,seconds,phase,period,opacity,canonical){
    if(!gpuWanted||gpuFailed||!scene.gpu||scene.geometry.edges.length||scene.geometry.nodes.length||settings.quality!=='soft'||settings.glow!==0||settings.trails!==0)return false;
    const start=now();
    try{
      if(!gpu){gpu=root.AmbientTorusGPU?.create();if(!gpu){gpuFailed=true;return false;}}
      const {m,context}=frameContext(scene,seconds,canonical,{phase,period}),shape=scene.gpuParameters(context),pose=camera(scene,seconds,canonical);
      if(!['major','minor','cos','sin'].every(k=>Number.isFinite(shape[k]))||shape.major<=0||shape.minor<=0||shape.major+shape.minor>scene.radius+1e-8||Math.abs(shape.cos**2+shape.sin**2-1)>1e-8)throw Error('Invalid GPU torus parameters');
      const sx=Math.sin(m.x),cx=Math.cos(m.x),sy=Math.sin(m.y),cy=Math.cos(m.y),sz=Math.sin(m.z),cz=Math.cos(m.z),n=RADIUS/scene.radius;
      const columns=[[cz*cy,sz*cy,-sy],[cz*sy*sx-sz*cx,sz*sy*sx+cz*cx,cy*sx],[cz*sy*cx+sz*sx,sz*sy*cx-cz*sx,cy*cx]],rotation=new Float32Array(9);
      for(let j=0;j<3;j++)for(let i=0;i<3;i++){const b=[scene.view.right,scene.view.up,scene.view.forward][i],p=columns[j];rotation[j*3+i]=n*(b[0]*p[0]+b[1]*p[1]+b[2]*p[2]);}
      const drawScale=scale*zoom(scene,seconds,canonical),stroke=Math.max(.65,Math.min(width,height)/850)*settings.weight/100;
      const mix=AmbientTimeline.smooth(Math.min(1,pose.amount/.2)),dx=.13/Math.hypot(.13,.11),dy=.11/Math.hypot(.13,.11);
      const extent=RADIUS+(Math.hypot((width/2+stroke*12)/drawScale,(height/2+stroke*12)/drawScale)-RADIUS)*pose.amount;
      const centers=mix<1?scene.geometry.paths.map(path=>{
        const uv=scene.gpu.uv,a=uv[path.indices[0]],sign=uv[path.indices[1]][3]>0?1:-1;
        const x=shape.minor/2*(a[0]*shape.cos+a[1]*shape.sin*sign),y=shape.minor/2*(a[1]*shape.cos-a[0]*shape.sin*sign);
        return {x:rotation[0]*x+rotation[3]*y,y:-(rotation[1]*x+rotation[4]*y),z:rotation[2]*x+rotation[5]*y};
      }):[];
      const passes=[{width:stroke*canvas.width/width,alpha:.63,lightness:59},{width:stroke*.36*canvas.width/width,alpha:.38,lightness:84}].map(pass=>{
        const stops=[];for(let i=0;i<=12;i++){const t=(i/12*2-1)*extent;stops.push(...rgb({x:dx*t,y:dy*t,z:0},phase,pass.lightness));}
        return {...pass,alpha:pass.alpha*opacity*settings.brightness/100,stops:new Float32Array(stops),colors:centers.map(p=>rgb(p,phase,pass.lightness))};
      });
      const projected=now();let prepared=projected;
      const state={rotation,pose,drawScale,width,height,pixelWidth:canvas.width,pixelHeight:canvas.height,markVisibility(){prepared=now();}};
      if(!gpu.draw(scene,state,shape,{passes,mix,energy:.84+.16*Math.sin(TAU*phase*4),fieldScale:[dx*width/(2*extent*drawScale),-dy*height/(2*extent*drawScale)]})){gpuFailed=true;return false;}
      // Both buffers already have the exact native pixel dimensions. Copy
      // one-to-one, avoiding fractional layout transforms and resampling.
      ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='screen';ctx.drawImage(gpu.canvas,0,0);ctx.restore();
      timings.projectionMs+=projected-start;timings.visibilityMs+=prepared-projected;timings.strokeMs+=now()-prepared;timings.backend='WebGL torus';timings.gpuDriver=gpu.driver;return true;
    }catch(error){gpuFailed=true;return false;}
  }
  function starfield(phase,framingZoom=1,visibility=1) {
    const short = Math.min(width,height);
    const exclusion = RADIUS*scale*framingZoom + short*.045;
    const outer = Math.hypot(width,height)/2+60;
    // An immersive framing fills the viewport. Stars recede beyond its bound.
    if(exclusion>=outer||visibility<=0)return;
    const amount = settings.stars/100;
    ctx.globalCompositeOperation='screen';
    const atmosphere=ctx.createRadialGradient(width*.5,height*.5,exclusion*.5,width*.5,height*.5,outer);
    atmosphere.addColorStop(0,'rgba(30,10,66,0)');
    atmosphere.addColorStop(.55,`rgba(28,13,52,${.21*amount*visibility*Math.min(1,(outer-exclusion)/(short*.3))})`);
    atmosphere.addColorStop(1,'rgba(2,3,10,0)');
    ctx.fillStyle=atmosphere;ctx.fillRect(0,0,width,height);
    const count=Math.floor(stars.length*amount);
    for (let i=0;i<count;i++) {
      const star=stars[i];
      const r=Math.sqrt(exclusion*exclusion + star.r*(outer*outer-exclusion*exclusion));
      const a=star.a + TAU*phase*star.turns;
      const drift=short*.006*Math.sin(TAU*phase*2+star.p);
      const x=width/2+(r+drift)*Math.cos(a), y=height/2+(r+drift)*Math.sin(a);
      if(x<-5||y<-5||x>width+5||y>height+5)continue;
      const alpha=(.28+.26*Math.sin(TAU*phase*star.twinkle+star.p))*star.bright*visibility;
      ctx.fillStyle=`hsla(${220+45*Math.sin(star.p)},65%,83%,${alpha})`;
      ctx.beginPath();ctx.arc(x,y,star.size,0,TAU);ctx.fill();
      if(star.size>1.35){ctx.fillStyle=`rgba(164,161,255,${alpha*.15})`;ctx.beginPath();ctx.arc(x,y,star.size*3,0,TAU);ctx.fill();}
    }
    // Sparse luminous dust, staying outside the object's full rotational bounds.
    for(let i=0;i<26*amount;i++){
      const a=TAU*(phase+(i/26)),r=exclusion+short*(.02+.20*(.5+.5*Math.sin(i*4.17)));
      const x=width/2+Math.cos(a)*r,y=height/2+Math.sin(a)*r;
      const alpha=(.09+.06*Math.sin(TAU*phase*3+i))*visibility;
      ctx.strokeStyle=`hsla(${260+50*Math.sin(i)},80%,72%,${alpha})`;ctx.lineWidth=.6;
      ctx.beginPath();ctx.arc(width/2,height/2,r,a,a+.011);ctx.stroke();
      ctx.fillStyle=`rgba(211,193,255,${alpha*2})`;ctx.beginPath();ctx.arc(x,y,.7,0,TAU);ctx.fill();
    }
  }
  function wireframe(scene, seconds, phase, opacity=1, echo=false, canonical=false, period=settings.duration) {
    if(settings.brightness<=0||opacity<=0)return;
    if(!echo&&gpuWireframe(scene,seconds,phase,period,opacity,canonical))return;
    const start=now(),geometry=drawingGeometry(scene),pose=camera(scene,seconds,canonical),perspective=pose.amount>0;
    // Keep the compact orthographic path; pools address the heavier clipped
    // perspective pipeline without adding work to the approved exterior views.
    const points=project(scene,seconds,canonical,{phase,period},geometry.indices,perspective?geometry.points:null,perspective?geometry.modelPoints:null),brightness=settings.brightness/100;
    const projected=now();timings.projectionMs+=projected-start;
    const drawScale=scale*zoom(scene,seconds,canonical);
    const opaque=(scene.occludes||scene.prepareOcclusion)&&pose.surfaceOpacity>1e-8&&perspective?pose.surfaceOpacity:0;
    const {m,context}=opaque?frameContext(scene,seconds,canonical,{phase,period}):{};
    const classify=opaque?(scene.prepareOcclusion?scene.prepareOcclusion(context):(point,eye)=>scene.occludes(point,eye,context)):null;
    if(opaque&&typeof classify!=='function')throw Error(`Scene ${scene.id}: invalid prepared occlusion`);
    const rotation=opaque?{cz:Math.cos(m.z),sz:Math.sin(m.z),cy:Math.cos(m.y),sy:Math.sin(m.y),cx:Math.cos(m.x),sx:Math.sin(m.x)}:null;
    // Undo the declared view and Euler rotation for the scene's mathematical ray test.
    const inverse=v=>{
      const {cz,sz,cy,sy,cx,sx}=rotation,n=scene.radius/RADIUS;
      const x1=v[0]*cz+v[1]*sz,y1=-v[0]*sz+v[1]*cz,x2=x1*cy-v[2]*sy,z2=x1*sy+v[2]*cy;
      return [n*x2,n*(y1*cx+z2*sx),n*(-y1*sx+z2*cx)];
    };
    const right=opaque?inverse(scene.view.right):null,up=opaque?inverse(scene.view.up):null,forward=opaque?inverse(scene.view.forward):null;
    const rayPoint=[0,0,0];
    const unproject=(p,out=rayPoint)=>{
      out[0]=p.x*right[0]-p.y*up[0]+p.z*forward[0];out[1]=p.x*right[1]-p.y*up[1]+p.z*forward[1];out[2]=p.x*right[2]-p.y*up[2]+p.z*forward[2];return out;
    };
    const eye=opaque?unproject({x:0,y:0,z:1/pose.invDistance},[0,0,0]):null;
    // Classify only endpoints of segments that survive viewport/near clipping.
    // Interior framing puts much of the surface behind the eye or off screen.
    const hidden=geometry.hidden;if(opaque)hidden.fill(-1);
    const vertexHidden=index=>{if(hidden[index]<0)hidden[index]=classify(geometry.modelPoints[index],eye)?1:0;return hidden[index]===1;};
    const point=()=>({x:0,y:0,z:0}),unscaled=point(),clipped=[point(),point()],middle=point(),probe=point(),edge=point();
    const hiddenScreen=p=>{const d=1-pose.invDistance*p.z;unscaled.x=p.x*d/pose.gain;unscaled.y=p.y*d/pose.gain;unscaled.z=p.z;return classify(unproject(unscaled),eye);};
    const between=(a,b,t,out)=>{
      const d=1/((1-t)/(1-pose.invDistance*a.z)+t/(1-pose.invDistance*b.z));
      out.x=a.x+(b.x-a.x)*t;out.y=a.y+(b.y-a.y)*t;out.z=(1-d)/pose.invDistance;return out;
    };
    const append=(store,a,b,hidden)=>{
      if(hidden&&opaque===1)return;
      let segment=store.items[store.length];
      if(!segment){segment={a:point(),b:point(),hidden:false};store.items.push(segment);}
      segment.a.x=a.x;segment.a.y=a.y;segment.a.z=a.z;segment.b.x=b.x;segment.b.y=b.y;segment.b.z=b.z;segment.hidden=hidden;store.length++;
    };
    function split(store,a,b,ha,hb,level=0){
        const dx=a.x-b.x,dy=a.y-b.y,lengthSquared=(dx*dx+dy*dy)*drawScale*drawScale;
        if(ha===hb){
          // Long near-plane segments can pass a silhouette even with matching ends.
          if(level===0&&lengthSquared>64){between(a,b,.5,middle);const hm=hiddenScreen(middle);if(hm!==ha){split(store,a,middle,ha,hm,1);split(store,middle,b,hm,hb,1);return;}}
          append(store,a,b,ha);return;
        }
        let low=0,high=1;const length=Math.sqrt(lengthSquared);
        for(let i=0;i<10&&length*(high-low)>.2;i++){
          const t=(low+high)/2;if(hiddenScreen(between(a,b,t,probe))===ha)low=t;else high=t;
        }
        between(a,b,(low+high)/2,edge);append(store,a,edge,ha);append(store,edge,b,hb);
    }
    const surfaceSegments=(ia,ib,store)=>{
      const a=points[ia],b=points[ib],segment=perspective?clipSegment(a,b,pose,halfX,halfY,clipped):null;
      if(perspective&&!segment)return;
      const first=perspective?segment[0]:a,last=perspective?segment[1]:b;
      if(!opaque){append(store,first,last,false);return;}
      split(store,first,last,first.z===a.z?vertexHidden(ia):hiddenScreen(first),last.z===b.z?vertexHidden(ib):hiddenScreen(last));
    };
    const stroke = Math.max(.65,Math.min(width,height)/850)*settings.weight/100;
    ctx.save();ctx.translate(width/2,height/2);ctx.globalCompositeOperation='screen';ctx.lineCap='round';ctx.lineJoin='round';
    // A few wide low-opacity strokes give bloom without expensive per-edge shadows.
    const passes = echo ? [{width:1.3,alpha:.12}] : [
      {width:12,alpha:.027*settings.glow/100},
      {width:5,alpha:.095*settings.glow/100},
      {width:1,alpha:.63},
      {width:.36,alpha:.38,core:true}
    ];
    const halfX=(width/2+stroke*12)/drawScale,halfY=(height/2+stroke*12)/drawScale;
    const edgeStore=geometry.edgeSegments;edgeStore.length=0;
    for(const [ia,ib] of geometry.edges)surfaceSegments(ia,ib,edgeStore);
    const edges=edgeStore.items;
    // Prepare perspective curves once and share pooled segments across passes.
    for(let p=0;perspective&&p<geometry.paths.length;p++){
      const path=geometry.paths[p],store=geometry.curveSegments[p];store.length=0;
      const count=path.indices.length-(path.closed?0:1);
      for(let i=0;i<count;i++)surfaceSegments(path.indices[i],path.indices[(i+1)%path.indices.length],store);
    }
    const prepared=now();timings.visibilityMs+=prepared-projected;
    for(const pass of passes){
      if(pass.alpha===0)continue;
      ctx.lineWidth=stroke*pass.width;
      if(settings.quality==='soft' && edgeStore.length&&!opaque){
        // One continuous color field per pass lets the backend rasterize the entire
        // wireframe together. All segments remain; only fine edge lighting is simplified.
        const dx=.13/Math.hypot(.13,.11),dy=.11/Math.hypot(.13,.11);
        const gradient=ctx.createLinearGradient(-dx*RADIUS*drawScale,-dy*RADIUS*drawScale,dx*RADIUS*drawScale,dy*RADIUS*drawScale);
        const alpha=pass.alpha*opacity*brightness*(.84+.16*Math.sin(TAU*phase*4));
        for(let i=0;i<=12;i++){
          const t=(i/12*2-1)*RADIUS;
          gradient.addColorStop(i/12,color({x:dx*t,y:dy*t,z:0},phase,alpha,pass.core?84:59));
        }
        ctx.strokeStyle=gradient;ctx.beginPath();
        for(let i=0;i<edgeStore.length;i++){const {a,b}=edges[i];ctx.moveTo(a.x*drawScale,a.y*drawScale);ctx.lineTo(b.x*drawScale,b.y*drawScale);}
        ctx.stroke();
      }else for(let i=0;i<edgeStore.length;i++){
        const {a,b,hidden}=edges[i];
        const depth=.78+.22*(a.z+b.z)/(2*RADIUS);
        const energy=.84+.16*Math.sin(TAU*(phase*4 - Math.hypot((a.x+b.x)/2,(a.y+b.y)/2)*.23));
        const alpha=pass.alpha*opacity*brightness*depth*energy*(hidden?1-opaque:1);
        const gradient=ctx.createLinearGradient(a.x*drawScale,a.y*drawScale,b.x*drawScale+.00001,b.y*drawScale);
        gradient.addColorStop(0,color(a,phase,alpha,pass.core?84:59));
        gradient.addColorStop(1,color(b,phase,alpha,pass.core?84:59));
        ctx.strokeStyle=gradient;
        ctx.beginPath();ctx.moveTo(a.x*drawScale,a.y*drawScale);ctx.lineTo(b.x*drawScale,b.y*drawScale);ctx.stroke();
      }
    }

    if(!echo){
      for(const index of geometry.nodes){
        const source=points[index],depth=1-pose.invDistance*source.z;
        if(perspective&&depth<pose.near*pose.invDistance)continue;
        const p=perspective?{x:source.x*pose.gain/depth,y:source.y*pose.gain/depth,z:source.z}:source;
        if(perspective&&(Math.abs(p.x)>halfX||Math.abs(p.y)>halfY))continue;
        const nodeOpacity=opaque&&vertexHidden(index)?1-opaque:1;
        const sparkle=.55+.45*Math.sin(TAU*(phase*4 - Math.hypot(p.x,p.y)*.22));
        const r=stroke*(.7+sparkle*.65);
        if(settings.glow>0){ctx.fillStyle=color(p,phase,.07*brightness*settings.glow/100*opacity*nodeOpacity);ctx.beginPath();ctx.arc(p.x*drawScale,p.y*drawScale,r*4.2,0,TAU);ctx.fill();}
        ctx.fillStyle=color(p,phase,.68*brightness*opacity*nodeOpacity,83);ctx.beginPath();ctx.arc(p.x*drawScale,p.y*drawScale,r,0,TAU);ctx.fill();
      }
    }
    const trace=(path,store,obscured)=>{
      if(perspective){
        let lastX=Infinity,lastY=Infinity;
        for(let i=0;i<store.length;i++){
          const {a,b,hidden}=store.items[i];if(hidden!==obscured)continue;
          const ax=a.x*drawScale,ay=a.y*drawScale,bx=b.x*drawScale,by=b.y*drawScale;
          if(Math.abs(ax-lastX)+Math.abs(ay-lastY)>1e-6)ctx.moveTo(ax,ay);
          ctx.lineTo(bx,by);lastX=bx;lastY=by;
        }
      }else{
        for(let i=0;i<path.indices.length;i++){const p=points[path.indices[i]];if(i)ctx.lineTo(p.x*drawScale,p.y*drawScale);else ctx.moveTo(p.x*drawScale,p.y*drawScale);}
        if(path.closed)ctx.closePath();
      }
    };
    const batchMix=settings.quality==='soft'?AmbientTimeline.smooth(Math.min(1,pose.amount/.2)):0;
    if(batchMix>0&&geometry.paths.length){
      // Match Gentle's edge batching: one spatial color field per line pass,
      // with separate visible/obscured batches while opacity is transitioning.
      const dx=.13/Math.hypot(.13,.11),dy=.11/Math.hypot(.13,.11);
      const extent=RADIUS+(Math.hypot(halfX,halfY)-RADIUS)*pose.amount;
      for(const pass of passes){
        if(pass.alpha===0)continue;ctx.lineWidth=stroke*pass.width;
        for(const obscured of opaque?[false,true]:[false]){
          const visibility=obscured?1-opaque:1;if(visibility<=0)continue;
          const gradient=ctx.createLinearGradient(-dx*extent*drawScale,-dy*extent*drawScale,dx*extent*drawScale,dy*extent*drawScale);
          const alpha=pass.alpha*opacity*brightness*visibility*batchMix*(.84+.16*Math.sin(TAU*phase*4));
          for(let i=0;i<=12;i++){const t=(i/12*2-1)*extent;gradient.addColorStop(i/12,color({x:dx*t,y:dy*t,z:0},phase,alpha,pass.core?84:59));}
          ctx.strokeStyle=gradient;ctx.beginPath();
          for(let p=0;p<geometry.paths.length;p++)trace(geometry.paths[p],geometry.curveSegments[p],obscured);
          ctx.stroke();
        }
      }
    }
    if(batchMix<1)for(let p=0;p<geometry.paths.length;p++){
      const path=geometry.paths[p],center={x:0,y:0,z:0},count=path.indices.length;
      for(const i of path.indices){const v=points[i];center.x+=v.x/count;center.y+=v.y/count;center.z+=v.z/count;}
      for(const pass of passes){
        if(pass.alpha===0)continue;
        ctx.lineWidth=stroke*pass.width;
        for(const obscured of opaque?[false,true]:[false]){
          const visibility=obscured?1-opaque:1;if(visibility<=0)continue;
          ctx.strokeStyle=color(center,phase,pass.alpha*opacity*brightness*visibility*(1-batchMix),pass.core?84:59);
          ctx.beginPath();
          trace(path,geometry.curveSegments[p],obscured);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
    timings.strokeMs+=now()-prepared;
  }

  function render(sample,nextSettings){
    timings={projectionMs:0,visibilityMs:0,strokeMs:0,backend:gpuFailed?'Canvas (GPU unavailable)':'Canvas'};
    settings=nextSettings;
    const withLayer=(layer,draw)=>{
      settings=layer.settings || nextSettings;
      try{return draw();}finally{settings=nextSettings;}
    };
    ctx.globalCompositeOperation='source-over';ctx.fillStyle='#030309';
    // Clear exact backing pixels. Fractional CSS-to-native scale must not leave
    // antialiased edge pixels carrying the previous frame into a loop seam.
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.fillRect(0,0,canvas.width,canvas.height);ctx.restore();
    const framingZoom=Math.max(1,...sample.layers.filter(l=>l.opacity>0).flatMap(layer=>withLayer(layer,()=>{
      const m=AmbientTimeline.motion(layer.scene,layer.seconds,settings,layer.canonical);
      const times=settings.trails>0&&m.amount>0.005?[layer.seconds,layer.seconds-.7,layer.seconds-1.5]:[layer.seconds];
      return times.map(t=>zoom(layer.scene,t,layer.canonical)*camera(layer.scene,t,layer.canonical).envelope);
    })));
    // Fixed Interior can also be selected during collection crossfades. Fade
    // the sky before that layer appears, then restore it after the eye leaves;
    // particles never occupy the bounds of a visible interior layer.
    const inside=scene=>scene&&camera(scene,0,true).invDistance*RADIUS>=1;
    const fade=t=>AmbientTimeline.smooth(Math.max(0,Math.min(1,t/3)));
    const visibility=(inside(sample.scene)?0:1)*(inside(sample.previousScene)?fade(sample.local):1)*(inside(sample.followingScene)?fade(sample.duration-sample.local):1);
    starfield(sample.phase,framingZoom,visibility);
    for(const layer of sample.layers){
      if(layer.opacity<=0)continue;
      withLayer(layer,()=>{
        const period=layer.animationPeriod ?? sample.animationPeriod ?? sample.period,phase=layer.animationPhase ?? sample.phase;
        const m=AmbientTimeline.motion(layer.scene,layer.seconds,settings,layer.canonical);
        if(settings.trails>0&&m.amount>0.005){
          for(const [offset,strength] of [[1.5,.35],[.7,.6]])wireframe(layer.scene,layer.seconds-offset,AmbientTimeline.wrap(phase*period-offset,period)/period,layer.opacity*settings.trails/100*m.amount*strength,true,false,period);
        }
        wireframe(layer.scene,layer.seconds,phase,layer.opacity,false,layer.canonical,period);
      });
    }
  }
  return {resize,render,project,zoom,camera,screenProject,setNativeViewport(viewport){nativeViewport={...viewport,layoutWidth:window.innerWidth,layoutHeight:window.innerHeight};},get deviceScale(){return dpr;},get performance(){return {...timings};}};
  }
  // Advance from the previous deadline, preserving fractional time across late
  // callbacks. At most one update is submitted per callback; missed frames are skipped.
  function nextFrameDeadline(now,deadline,interval){
    return Number.isFinite(deadline)?deadline+Math.max(1,Math.floor((now-deadline+.5)/interval)+1)*interval:now+interval;
  }
  root.AmbientRenderer={create,nextFrameDeadline,clipSegment};
})(globalThis);
