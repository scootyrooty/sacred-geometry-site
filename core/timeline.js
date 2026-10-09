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
    return stops.map(stop=>({...stop,seconds:stop.progress===0?0:settings.hold+(durationFor(scene,settings)-settings.hold)*stop.progress}));
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
  const api={wrap,smooth,durationFor,stopsFor,stopIndex,destination,motion,sample};root.AmbientTimeline=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
