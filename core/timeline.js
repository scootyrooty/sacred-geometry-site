(function(root) {
  'use strict';
  const TAU=Math.PI*2;
  const wrap=(seconds,period)=>((seconds%period)+period)%period;
  const smooth=x=>x*x*x*(x*(x*6-15)+10);
  const durationFor=(scene,settings)=>settings.durations?.[scene.id] ?? settings.duration;
  // Named stationary destinations are supplied by each scene, never inferred
  // from camera angles. Seek times scale with its independently saved duration.
  function stopsFor(scene,settings){
    const variant=scene.variants.find(v=>v.id===settings.forms?.[scene.id]) || scene.variants.find(v=>v.id===scene.defaultVariant);
    const viewId=settings.views?.[scene.id] || scene.defaultView;
    const stops=scene.journeyStops?scene.journeyStops({variantId:variant?.id,parameters:variant?.parameters || {},viewId}):[{id:'canonical',title:scene.canonicalLabel,progress:0}];
    const at=progress=>settings.hold+(durationFor(scene,settings)-settings.hold)*progress;
    return stops.map(stop=>({...stop,seconds:stop.progress===0?0:at(stop.progress),leaveSeconds:stop.leaveProgress===undefined?(stop.progress===0?settings.hold:at(stop.progress)):at(stop.leaveProgress)}));
  }
  // Follow the normal path, removing declared stationary dwell intervals.
  // Reverse travel traverses the same camera/morph path backwards.
  function routeFor(scene,from,to,settings){
    const low=Math.min(from,to),high=Math.max(from,to),segments=[];let cursor=low;
    for(const stop of stopsFor(scene,settings)){
      const start=Math.max(low,stop.seconds),end=Math.min(high,stop.leaveSeconds);
      if(end<=start)continue;
      if(start>cursor)segments.push([cursor,start]);cursor=Math.max(cursor,end);
    }
    if(cursor<high)segments.push([cursor,high]);
    if(to<from){segments.reverse();for(const segment of segments)segment.reverse();}
    const length=segments.reduce((sum,[a,b])=>sum+Math.abs(b-a),0);
    return {from,to,segments,length,duration:Math.min(20,length)};
  }
  function routeAt(route,age){
    if(age>=route.duration-1e-9||!route.length)return route.to;
    let distance=Math.max(0,age)/route.duration*route.length;
    for(const [a,b] of route.segments){const length=Math.abs(b-a);if(distance<=length)return a+Math.sign(b-a)*distance;distance-=length;}
    return route.to;
  }
  function blendPose(from,to,amount){
    const quaternion=({x,y,z})=>{
      const sx=Math.sin(x/2),cx=Math.cos(x/2),sy=Math.sin(y/2),cy=Math.cos(y/2),sz=Math.sin(z/2),cz=Math.cos(z/2);
      return [sx*cy*cz-cx*sy*sz,cx*sy*cz+sx*cy*sz,cx*cy*sz-sx*sy*cz,cx*cy*cz+sx*sy*sz];
    };
    const a=quaternion(from.motion),b=quaternion(to.motion);let dot=a.reduce((s,v,i)=>s+v*b[i],0);
    if(dot<0){for(let i=0;i<4;i++)b[i]=-b[i];dot=-dot;}
    const angle=Math.acos(Math.min(1,dot)),s=Math.sin(angle);
    const q=a.map((v,i)=>s<1e-5?v*(1-amount)+b[i]*amount:(v*Math.sin((1-amount)*angle)+b[i]*Math.sin(amount*angle))/s);
    const length=Math.hypot(...q),[x,y,z,w]=q.map(v=>v/length),mix=(a,b)=>a+(b-a)*amount;
    const motion={...to.motion,x:Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y)),y:Math.asin(Math.max(-1,Math.min(1,2*(w*y-z*x)))),z:Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z)),amount:mix(from.motion.amount,to.motion.amount)};
    const camera={...to.camera};for(const key of ['amount','distance','fov','near','surfaceOpacity'])camera[key]=mix(from.camera[key] ?? 0,to.camera[key] ?? 0);
    const progress=mix(from.context.progress,to.context.progress);
    return {motion,camera,context:{progress,eased:smooth(progress),seconds:mix(from.context.seconds,to.context.seconds),phase:mix(from.context.phase,to.context.phase),holding:amount<1?false:to.context.holding}};
  }
  function stopIndex(scene,seconds,settings){
    const stops=stopsFor(scene,settings),local=Math.min(durationFor(scene,settings)-1e-7,Math.max(0,seconds));
    // Transition ramps belong to the preceding stop until the destination lands.
    return stops.reduce((index,stop,i)=>stop.seconds<=local+1e-7?i:index,0);
  }
  function destination(scene,seconds,direction,scenes,settings,geometryOnly=false){
    if(!geometryOnly){
      const stops=stopsFor(scene,settings),index=stopIndex(scene,seconds,settings)+direction;
      if(index>=0&&index<stops.length)return {scene,stop:stops[index]};
    }
    const index=scenes.findIndex(s=>s.id===scene.id),next=scenes[wrap(index+direction,scenes.length)],stops=stopsFor(next,settings);
    return {scene:next,stop:stops[!geometryOnly&&direction<0?stops.length-1:0]};
  }
  function motion(scene,seconds,settings,canonical=false) {
    if(settings.pose?.sceneId===scene.id)return settings.pose.motion;
    const {hold,forms,views}=settings,duration=durationFor(scene,settings);
    const t=wrap(seconds,duration);
    const holding=canonical || t<=hold || scene.motion==='still';
    const progress=holding?0:(t-hold)/(duration-hold),eased=smooth(progress);
    const variant=scene.variants.find(v=>v.id===forms?.[scene.id]) || scene.variants.find(v=>v.id===scene.defaultVariant);
    const view=scene.views?.find(v=>v.id===views?.[scene.id]) || scene.views?.find(v=>v.id===scene.defaultView);
    const angles=typeof scene.motion==='function'?scene.motion({progress,eased,holding,variantId:variant?.id,parameters:variant?.parameters || {},viewId:view?.id}):{x:TAU*eased,y:TAU*eased+.65*Math.sin(TAU*eased),z:TAU*2*eased};
    if(!angles||!['x','y','z'].every(k=>Number.isFinite(angles[k])))throw Error(`Scene ${scene.id}: invalid motion result`);
    return {...angles,amount:holding?0:Math.sin(Math.PI*progress)**2,holding};
  }
  function sample(seconds,scenes,settings,locked=false) {
    if(!scenes.length)throw Error('No registered scenes');
    if(!(scenes.every(scene=>durationFor(scene,settings)>settings.hold)&&settings.hold>=0&&settings.transition>=0))throw Error('Invalid timeline timing');
    const start=Math.max(0,scenes.findIndex(s=>s.id===settings.sceneId));
    const order=[...scenes.slice(start),...scenes.slice(0,start)];
    const all=settings.sequence==='all' && scenes.length>1 && !locked;
    const transition=all?settings.transition:0,slots=order.map(scene=>durationFor(scene,settings)+transition);
    const period=all?slots.reduce((sum,n)=>sum+n,0):slots[0];
    const time=wrap(seconds,period);let index=0,local=time;
    if(all)while(local>=slots[index]&&index<order.length-1){local-=slots[index];index++;}
    const scene=order[index];
    const duration=durationFor(scene,settings);
    const blending=all && transition>0 && local>=duration;
    const fraction=blending?smooth((local-duration)/transition):0;
    const layers=blending?[
      {scene,seconds:duration,opacity:1-fraction,canonical:true},
      {scene:order[(index+1)%order.length],seconds:0,opacity:fraction,canonical:true}
    ]:[{scene,seconds:local,opacity:1,canonical:locked}];
    return {period,time,phase:time/period,scene,local,duration,blending,layers,next:blending?order[(index+1)%order.length]:null,previousScene:all?order[(index+order.length-1)%order.length]:null,followingScene:all?order[(index+1)%order.length]:null};
  }
  const api={wrap,smooth,durationFor,stopsFor,routeFor,routeAt,blendPose,stopIndex,destination,motion,sample};root.AmbientTimeline=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
