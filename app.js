(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const scenes=AmbientScenes.list();
  if(!scenes.length)throw Error('No geometry scenes registered');
  for(const scene of scenes){const option=document.createElement('option');option.value=scene.id;option.textContent=scene.title;$('sceneId').append(option);}
  const defaults = {sceneId:scenes[0].id, sequence:'all', transition:8, duration:120, hold:30, palette:'spectrum', brightness:115, weight:140, glow:0, trails:0, size:100, stars:70, quality:'soft', resolution:'native'};
  const STORAGE_KEY = 'ambient-geometry-settings-v1';
  const defaultDurations=Object.fromEntries(scenes.map(scene=>[scene.id,scene.defaultDuration || defaults.duration]));
  const defaultDurationRevisions=Object.fromEntries(scenes.map(scene=>[scene.id,scene.durationRevision || 1]));
  let settings = {...defaults,forms:{},views:{},durations:{...defaultDurations},durationRevisions:{...defaultDurationRevisions}};
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    for(const scene of scenes)if(scene.variants.some(v=>v.id===saved.forms?.[scene.id]))settings.forms[scene.id]=saved.forms[scene.id];
    for(const scene of scenes){
      const view=scene.viewAliases?.[saved.views?.[scene.id]] || saved.views?.[scene.id];
      if(scene.views.some(v=>v.id===view))settings.views[scene.id]=view;
      let duration=saved.durations?.[scene.id] ?? (saved.duration!==defaults.duration?saved.duration:undefined);
      if(Number.isFinite(scene.previousDefaultDuration)&&(saved.durationRevisions?.[scene.id] || 0)<defaultDurationRevisions[scene.id]&&duration===scene.previousDefaultDuration)duration=scene.defaultDuration;
      if([...$('duration').options].some(option=>+option.value===duration))settings.durations[scene.id]=duration;
    }
    for (const key of Object.keys(defaults)) {
      const element = $(key);
      if (element.type === 'range' && Number.isFinite(saved[key])) settings[key] = Math.max(+element.min, Math.min(+element.max, saved[key]));
      if (element.tagName === 'SELECT' && [...element.options].some(option => option.value === String(saved[key]))) settings[key] = typeof defaults[key] === 'number' ? +saved[key] : saved[key];
    }
  } catch { /* Private browsing may not offer storage. Playback still works. */ }
  let remote;
  const canvas = $('scene');
  const renderer=AmbientRenderer.create(canvas);
  let elapsed = 0, lastTick = performance.now(), nextDraw = -Infinity;
  let animationElapsed=0,heldSeconds=null,heldStopId=null,heldPeriod=null,heldPose=null,navigationFade=null,navigationTravel=null;
  let paused = false, locked = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let hidden = document.hidden, hideTimer, toastTimer, wakeLock;
  let frameCosts = [], budgetDpr = 1.6, lastQualityCheck = 0;
  // These count submitted canvas updates, not guaranteed display presentations.
  let meterStart=performance.now(),meterCallbacks=0,meterDraws=0,meterCost=0;
  let meterProjection=0,meterVisibility=0,meterStrokes=0;
  let performanceStats={updatesPerSecond:0,callbacksPerSecond:0,commandMs:0,projectionMs:0,visibilityMs:0,strokeMs:0,backend:'Canvas',target:30};
  function clearMeter(now){meterStart=now;meterCallbacks=0;meterDraws=0;meterCost=0;meterProjection=0;meterVisibility=0;meterStrokes=0;}
  const wrap=AmbientTimeline.wrap;
  let activeId=null,lastSample;
  function resize(){renderer.resize(settings,budgetDpr);}
  function setMetadata(scene){
    if($('sceneId').value!==scene.id)$('sceneId').value=scene.id;
    if(activeId===scene.id)return;
    activeId=scene.id;
    $('scene-title').textContent=scene.title;$('scene-subtitle').textContent=scene.subtitle;
    $('scene-eyebrow').textContent=scene.eyebrow;$('study').textContent=scene.study;
    canvas.setAttribute('aria-label',`${scene.title} in a field of stars.`);
    syncForm(scene);
  }
  function syncForm(scene){
    $('form-row').hidden=!scene.variants.length;
    $('form').replaceChildren(...scene.variants.map(variant=>{const option=document.createElement('option');option.value=variant.id;option.textContent=variant.title;return option;}));
    $('form').value=settings.forms[scene.id] || scene.defaultVariant || '';
    $('view-row').hidden=!scene.views.length;
    $('view').replaceChildren(...scene.views.map(view=>{const option=document.createElement('option');option.value=view.id;option.textContent=view.title;return option;}));
    $('view').value=settings.views[scene.id] || scene.defaultView || '';
    $('duration').value=AmbientTimeline.durationFor(scene,settings);
    syncStops(scene);
  }
  function syncStops(scene){
    const follow=document.createElement('option');follow.value='';follow.textContent='Continue journey';
    $('journey-stop').replaceChildren(follow,...AmbientTimeline.stopsFor(scene,journeySettings(scene)).map(stop=>{
      const option=document.createElement('option');option.value=stop.id;option.textContent=stop.title;return option;
    }));
    if(locked&&!heldStopId){const option=document.createElement('option');option.value='current';option.textContent='Current position · held';$('journey-stop').append(option);}
    syncStopSelection(scene);
  }
  function syncStopSelection(scene){
    const value=locked?(heldStopId || 'current'):'';
    if($('journey-stop').value!==value){$('journey-stop').value=value;remote?.sync();}
  }
  function playbackSample(seconds){
    const sample=AmbientTimeline.sample(seconds,scenes,settings,locked);
    if(locked&&heldSeconds!==null){sample.local=heldSeconds;sample.layers=[{scene:sample.scene,seconds:heldSeconds,opacity:1,canonical:false,pose:heldPose}];}
    sample.animationPeriod=heldPeriod ?? sample.period;
    sample.phase=wrap(animationElapsed,sample.animationPeriod)/sample.animationPeriod;
    sample.animationTime=wrap(animationElapsed,sample.animationPeriod);
    if(navigationTravel){
      const travel=navigationTravel,age=Math.max(0,animationElapsed-travel.start);
      if(age>=travel.duration){navigationTravel=null;heldPose=null;}
      else {
        const local=AmbientTimeline.routeAt(travel.route,age);
        let pose=age===0?travel.fromPose:null;
        if(age>0&&age<travel.blendDuration){const target=renderer.poseAt(sample.scene,local);pose={sceneId:sample.scene.id,...AmbientTimeline.blendPose(travel.fromPose,target,AmbientTimeline.smooth(age/travel.blendDuration))};}
        sample.local=local;sample.layers=[{scene:sample.scene,seconds:local,opacity:1,canonical:false,pose}];
      }
    }
    if(navigationFade){
      const amount=AmbientTimeline.smooth(Math.min(1,Math.max(0,animationElapsed-navigationFade.start)));
      if(amount>=1)navigationFade=null;
      else sample.layers=[...navigationFade.from.map(layer=>({...layer,animationPhase:wrap(layer.animationTime+animationElapsed-navigationFade.start,layer.animationPeriod)/layer.animationPeriod,opacity:layer.opacity*(1-amount)})),...sample.layers.map(layer=>({...layer,opacity:layer.opacity*amount}))];
    }
    return sample;
  }
  function project(seconds){
    const sample=AmbientTimeline.sample(seconds,scenes,settings,locked);
    if(locked&&heldPeriod){sample.period=heldPeriod;sample.phase=wrap(seconds,heldPeriod)/heldPeriod;}
    return renderer.project(AmbientScenes.get(settings.sceneId),locked&&heldSeconds!==null?heldSeconds:seconds,locked&&heldSeconds===null,sample);
  }
  function render(seconds,forceUI=true){
    const sample=playbackSample(seconds);lastSample=sample;
    renderer.render(sample,settings);setMetadata(sample.scene);
    updatePlaybackUI(sample,forceUI);
  }
  let lastUiUpdate=-Infinity;
  function updatePlaybackUI(sample,force=false){
    if(!sample || document.body.classList.contains('quiet'))return;
    const now=performance.now();if(!force&&now-lastUiUpdate<100)return;lastUiUpdate=now;
    const m=AmbientTimeline.motion(sample.scene,sample.local,settings,locked);
    const view=sample.scene.views.find(v=>v.id===(settings.views[sample.scene.id] || sample.scene.defaultView));
    const stop=AmbientTimeline.stopsFor(sample.scene,settings)[AmbientTimeline.stopIndex(sample.scene,sample.local,settings)];
    $('phase').textContent=navigationTravel?'MOVING TO VIEW':sample.blending?'FLOWING TO '+sample.next.title.toUpperCase():locked?stop.title.toUpperCase()+' · HELD':m.holding?sample.scene.canonicalLabel:sample.local>sample.duration-15?'RETURNING':renderer.camera(sample.scene,sample.local).amount>.9?'INTERIOR':view&&view.id!=='all'&&view.id!=='orbit'?view.title.toUpperCase():'IN ORBIT';
    syncStopSelection(sample.scene);
    $('time').textContent=`${clock(sample.time)} / ${clock(sample.period)}`;
    $('progress').style.width=`${sample.time/sample.period*100}%`;
  }
  function clock(t){return `${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;}
  function frame(now){
    if(!hidden)meterCallbacks++;
    // The first rAF timestamp can precede script initialization or a resume.
    // Never wrap a tiny negative startup delta into the collection's last scene.
    if(!hidden&&!paused){const delta=Math.max(0,now-lastTick)/1000;animationElapsed+=delta;if(!navigationFade&&!navigationTravel&&!locked)elapsed+=delta;}
    lastTick=Math.max(lastTick,now);
    const interval=settings.quality==='high'?1000/60:1000/30;
    if(!hidden&&now>=nextDraw-.5){
      const begin=performance.now();render(elapsed,false);nextDraw=AmbientRenderer.nextFrameDeadline(now,nextDraw,interval);
      const commandMs=performance.now()-begin;meterDraws++;meterCost+=commandMs;
      const stages=renderer.performance;meterProjection+=stages.projectionMs;meterVisibility+=stages.visibilityMs;meterStrokes+=stages.strokeMs;
      if(settings.resolution==='auto'&&!AmbientPlatform.embedded){
        frameCosts.push(commandMs);
        if(frameCosts.length>60)frameCosts.shift();
        if(now-lastQualityCheck>8000&&frameCosts.length===60){
          lastQualityCheck=now;
          const average=frameCosts.reduce((a,b)=>a+b,0)/60;
          const floor=1;
          if(average>25&&budgetDpr>floor){budgetDpr=Math.max(floor,budgetDpr-.25);resize();}
        }
      }
    }
    if(now-meterStart>=2000){
      const span=(now-meterStart)/1000;
      const count=meterDraws || 1;
      performanceStats={updatesPerSecond:meterDraws/span,callbacksPerSecond:meterCallbacks/span,commandMs:meterCost/count,projectionMs:meterProjection/count,visibilityMs:meterVisibility/count,strokeMs:meterStrokes/count,backend:renderer.performance.backend,gpuDriver:renderer.performance.gpuDriver,target:settings.quality==='high'?60:30};
      clearMeter(now);if($('app-info').open)updateInfo();
    }
    requestAnimationFrame(frame);
  }
  function save(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(settings));}catch{}}
  function journeySettings(scene){return {...settings,views:{...settings.views,[scene.id]:scene.defaultView}};}
  function clearNavigation(){navigationFade=null;navigationTravel=null;heldSeconds=null;heldStopId=null;heldPeriod=null;heldPose=null;locked=false;}
  function goTo(scene,stop,hold=false,viewId,routeFrom){
    // At most two outgoing layers: rapid deliberate taps cannot grow render work.
    const snapshot={...settings,forms:{...settings.forms},views:{...settings.views},durations:{...settings.durations}};
    const from=lastSample.layers.filter(layer=>layer.opacity>0).sort((a,b)=>b.opacity-a.opacity).slice(0,2).map(layer=>{
      const period=layer.animationPeriod ?? lastSample.animationPeriod;
      return {...layer,settings:layer.settings || snapshot,animationPeriod:period,animationTime:(layer.animationPhase ?? lastSample.phase)*period};
    });
    const total=from.reduce((sum,layer)=>sum+layer.opacity,0);
    const sameGeometry=lastSample.scene.id===scene.id&&from.every(layer=>layer.scene.id===scene.id);
    const source=lastSample.layers.find(layer=>layer.scene.id===scene.id) || lastSample.layers[0];
    const fromPose=sameGeometry?renderer.poseAt(scene,source.seconds,source.canonical,{...(source.settings || snapshot),pose:source.pose}):null;
    const correctPose=sameGeometry&&(source.pose || viewId&&(snapshot.views[scene.id] || scene.defaultView)!==viewId);
    if(viewId)settings.views[scene.id]=viewId;
    settings.sceneId=scene.id;locked=hold;heldSeconds=hold?stop.seconds:null;heldStopId=hold?stop.id:null;heldPeriod=hold?lastSample.animationPeriod:null;heldPose=null;elapsed=stop.seconds;
    const period=heldPeriod ?? AmbientTimeline.sample(elapsed,scenes,settings,locked).period;
    animationElapsed=lastSample.phase*period;
    navigationFade=null;navigationTravel=null;
    if(!paused){
      if(sameGeometry){
        const route=AmbientTimeline.routeFor(scene,routeFrom ?? lastSample.local,stop.seconds,settings),blendDuration=correctPose?2:0;
        navigationTravel={route,duration:Math.max(route.duration,blendDuration),blendDuration,fromPose,start:animationElapsed,target:stop.seconds};
        if(!navigationTravel.duration)navigationTravel=null;
      }else navigationFade={from:from.map(layer=>({...layer,opacity:layer.opacity/total})),start:animationElapsed};
    }
    lastTick=performance.now();save();render(elapsed);syncControls();
  }
  function navigate(key){
    const direction=key==='ArrowDown'||key==='ArrowRight'?1:-1;
    const scene=lastSample.scene,geometryOnly=key==='ArrowUp'||key==='ArrowDown';
    let local=navigationTravel?.target ?? lastSample.local;
    let routeFrom=lastSample.local;
    const expanded=geometryOnly?settings:journeySettings(scene);
    // Leaving a fixed View resumes the complete view order at that same form.
    if(!geometryOnly&&(settings.views[scene.id] || scene.defaultView)!==scene.defaultView){
      const current=AmbientTimeline.stopsFor(scene,settings)[AmbientTimeline.stopIndex(scene,local,settings)];
      local=AmbientTimeline.stopsFor(scene,expanded).find(stop=>stop.id===current.id)?.seconds ?? local;
      routeFrom=local;
    }
    const destination=AmbientTimeline.destination(scene,local,direction,scenes,expanded,geometryOnly);
    goTo(destination.scene,destination.stop,false,!geometryOnly&&destination.scene.id===scene.id?scene.defaultView:undefined,routeFrom);return true;
  }
  function syncControls(){
    for(const key of Object.keys(defaults)){
      $(key).value=settings[key];
      const output=$(key+'-value');
      if(output)output.textContent=(key==='hold'||key==='transition')?`${settings[key]} sec`:`${settings[key]}%`;
    }
    $('grid').setAttribute('aria-pressed',String(locked));
    $('grid').textContent=locked?'Resume journey':'Hold this view';
    $('play').textContent=locked?'▷':'Ⅱ';$('play').setAttribute('aria-label',locked?'Resume journey':'Hold this view');$('play').setAttribute('aria-pressed',String(locked));$('play').title=locked?'Resume journey':'Hold this view';
    $('sequence').disabled=scenes.length<2;
    // The Android player always uses its native display buffer.
    $('resolution-row').hidden=AmbientPlatform.embedded;
    $('transition').disabled=scenes.length<2||settings.sequence!=='all';
    $('collection-note').textContent=scenes.length<2?'New geometries appear here as the collection grows.':`${scenes.length} geometries · transitions add time between journeys.`;
    syncForm(lastSample?.scene || AmbientScenes.get(settings.sceneId));remote?.sync();
  }
  function scheduleHide(){clearTimeout(hideTimer);if($('panel').hidden)hideTimer=setTimeout(()=>setQuiet(true),12000);}
  function setQuiet(value){if(value)remote?.quiet();document.body.classList.toggle('quiet',value);if(!value){updatePlaybackUI(lastSample,true);scheduleHide();}else clearTimeout(hideTimer);}
  function panel(open){$('panel').hidden=!open;$('settings').setAttribute('aria-expanded',String(open));setQuiet(false);clearTimeout(hideTimer);if(open)$('close').focus();else{scheduleHide();$('settings').focus();}}
  function notify(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
  async function keepAwake(){
    if(AmbientPlatform.embedded){$('awake-status').textContent='Android keeps the screen awake while this app is visible.';return;}
    if(!('wakeLock' in navigator)){$('awake-status').textContent='Keep-awake unavailable here; use Auto-Lock → Never for the show.';return;}
    if(wakeLock||document.hidden||paused)return;
    try{wakeLock=await navigator.wakeLock.request('screen');$('awake-status').textContent='Keep-awake active while this app is visible.';wakeLock.addEventListener('release',()=>{wakeLock=null;$('awake-status').textContent='Keep-awake released; tap a control to enable again.';});}
    catch{$('awake-status').textContent='Keep-awake unavailable right now; check Auto-Lock before the show.';}
  }
  for(const key of Object.keys(defaults))$(key).addEventListener('input',()=>{
    const element=$(key);
    if(key==='duration'){
      settings.sceneId=lastSample.scene.id;settings.durations[settings.sceneId]=+element.value;
    }else settings[key]=typeof defaults[key]==='number'?+element.value:element.value;
    if(key==='resolution'){budgetDpr=1.6;frameCosts=[];lastQualityCheck=performance.now();}
    if(['sceneId','sequence','transition','duration','hold'].includes(key)){clearNavigation();elapsed=0;}
    syncControls();save();resize();render(elapsed);
  });
  $('form').addEventListener('input',()=>{const scene=lastSample.scene;settings.forms[scene.id]=$('form').value;settings.sceneId=scene.id;clearNavigation();elapsed=0;save();syncControls();render(elapsed);});
  $('view').addEventListener('input',()=>{const scene=lastSample.scene;settings.views[scene.id]=$('view').value;settings.sceneId=scene.id;clearNavigation();elapsed=0;save();syncControls();render(elapsed);});
  $('journey-stop').addEventListener('input',()=>{
    const scene=lastSample.scene,stop=AmbientTimeline.stopsFor(scene,journeySettings(scene)).find(s=>s.id===$('journey-stop').value);
    if(stop)goTo(scene,stop,true,scene.defaultView);
    else if(locked)goTo(scene,{seconds:heldSeconds ?? 0},false);
  });
  $('scene').addEventListener('click',()=>{if(!$('panel').hidden)panel(false);else setQuiet(!document.body.classList.contains('quiet'));keepAwake();});
  $('settings').addEventListener('click',()=>panel($('panel').hidden));
  $('close').addEventListener('click',()=>panel(false));
  function toggleHold(){
    paused=false;
    if(!locked){
      const layer=lastSample.layers.find(layer=>layer.scene.id===lastSample.scene.id);
      heldPose=layer?.pose || null;navigationFade=null;navigationTravel=null;
      settings.sceneId=lastSample.scene.id;heldSeconds=Math.min(lastSample.local,lastSample.duration-1e-7);heldStopId=null;heldPeriod=lastSample.animationPeriod;elapsed=heldSeconds;locked=true;save();
    }else goTo(lastSample.scene,{seconds:heldSeconds ?? 0},false);
    lastTick=performance.now();syncControls();render(elapsed);
    keepAwake();
  }
  $('play').addEventListener('click',toggleHold);
  $('grid').addEventListener('click',toggleHold);
  $('restart').addEventListener('click',()=>{elapsed=0;clearNavigation();syncControls();render(elapsed);notify('Journey restarted');});
  $('reset').addEventListener('click',()=>{settings={...defaults,forms:{},views:{},durations:{...defaultDurations},durationRevisions:{...defaultDurationRevisions}};budgetDpr=1.6;frameCosts=[];lastQualityCheck=performance.now();clearNavigation();elapsed=0;animationElapsed=0;syncControls();save();resize();render(elapsed);notify('Default settings restored');});
  $('project').addEventListener('click',()=>{panel(false);setQuiet(true);keepAwake();});
  $('fullscreen').addEventListener('click',async()=>{
    try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else notify('For fullscreen on iPhone, launch from your Home Screen.');}catch{notify('Fullscreen is unavailable here. Try opening in a browser or from your Home Screen.');}
  });
  document.addEventListener('fullscreenchange',()=>{$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'Exit fullscreen':'Enter fullscreen');});
  document.addEventListener('pointerdown',()=>{keepAwake();if(!document.body.classList.contains('quiet'))scheduleHide();});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape')panel(false);
    if(event.target.matches('input,select,button,summary'))return;
    if(event.key.toLowerCase()==='h')setQuiet(!document.body.classList.contains('quiet'));
    if(event.code==='Space'){event.preventDefault();$('play').click();}
  });
  document.addEventListener('visibilitychange',()=>{hidden=document.hidden;lastTick=performance.now();clearMeter(lastTick);if(!hidden)keepAwake();});
  window.addEventListener('resize',()=>{resize();render(elapsed);});
  window.addEventListener('pagehide',()=>wakeLock?.release());
  async function offline(){
    const status=$('offline-status'),dot=$('offline-dot');
    if(AmbientPlatform.embedded){status.textContent='Bundled for offline playback · no connection needed';dot.classList.add('ready');return;}
    if(location.protocol==='file:'){status.textContent='Local desktop playback · install from HTTPS for iPhone offline use.';return;}
    if(!('serviceWorker' in navigator)||!window.isSecureContext){status.textContent='Offline saving needs an HTTPS address.';return;}
    try{
      const registered=await navigator.serviceWorker.register('./sw.js');
      const pending=registered.installing || registered.waiting;
      if(pending&&pending.state!=='activated')await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Update timed out')),20000);
        const changed=()=>{if(pending.state==='activated'){clearTimeout(timer);resolve();}else if(pending.state==='redundant'){clearTimeout(timer);reject(new Error('Update failed'));}};
        pending.addEventListener('statechange',changed);changed();
      });
      const registration=await navigator.serviceWorker.ready;
      const channel=new MessageChannel();
      const result=await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Timed out')),10000);
        channel.port1.onmessage=event=>{clearTimeout(timeout);resolve(event.data);};
        registration.active.postMessage('CHECK_OFFLINE',[channel.port2]);
      });
      if(!result.ready)throw new Error('Incomplete cache');
      status.textContent='Saved for offline playback';dot.classList.add('ready');
      try{if(navigator.storage?.persist)await navigator.storage.persist();}catch{}
    }catch{status.textContent='Offline save incomplete · reconnect and reload before the show.';}
  }
  remote=AmbientRemote.create({panel,setQuiet,keepAwake,navigate});
  window.ambientRemote=remote;
  window.ambientLifecycle=visible=>{hidden=!visible||document.hidden;lastTick=performance.now();clearMeter(lastTick);};
  window.ambientNativeInfo=info=>{
    $('native-info').textContent=JSON.stringify(info,null,2);
    const viewport=info.viewport;
    if(AmbientPlatform.embedded&&Number.isInteger(viewport?.width)&&Number.isInteger(viewport?.height)&&viewport.width>0&&viewport.height>0){renderer.setNativeViewport(viewport);resize();render(elapsed);}
    updateInfo();
  };
  function updateInfo(){
    const b=window.AmbientBuild;
    $('build-info').textContent=b?'Commit '+b.commit+(b.dirty?' (development changes)':'')+' · '+b.cacheVersion:'Development preview';
    $('performance-info').textContent='Canvas updates '+performanceStats.updatesPerSecond.toFixed(1)+'/sec · callbacks '+performanceStats.callbacksPerSecond.toFixed(1)+'/sec · target '+performanceStats.target+' · drawing commands '+performanceStats.commandMs.toFixed(1)+' ms. Display FPS can differ.';
    $('performance-info').textContent+=' Stages: mesh '+performanceStats.projectionMs.toFixed(1)+' ms · visibility '+performanceStats.visibilityMs.toFixed(1)+' ms · lines '+performanceStats.strokeMs.toFixed(1)+' ms.';
    $('performance-info').textContent+=' Drawing: '+performanceStats.backend+'.';
    if(performanceStats.gpuDriver)$('performance-info').textContent+=' Graphics: '+performanceStats.gpuDriver+'.';
    $('render-info').textContent='Layout (CSS units) '+innerWidth+' × '+innerHeight+' · DPR '+devicePixelRatio+' · canvas (render pixels) '+canvas.width+' × '+canvas.height+' · draw scale '+renderer.deviceScale;
  }
  $('app-info').addEventListener('toggle',updateInfo);
  if(AmbientPlatform.embedded){$('iphone-help').hidden=true;$('fullscreen').hidden=true;}
  syncControls();resize();render(0);remote.sync();updateInfo();scheduleHide();offline();lastTick=performance.now();clearMeter(lastTick);requestAnimationFrame(frame);
  // A deterministic preview hook also allows future scenes to share the same clock.
  window.ambientPreview={
    renderAt(seconds){paused=true;elapsed=seconds;animationElapsed=seconds;navigationFade=null;navigationTravel=null;render(seconds);},
    pauseClock(value){paused=value;lastTick=performance.now();},
    advanceBy(seconds){paused=true;animationElapsed+=seconds;if(!navigationFade&&!navigationTravel&&!locked)elapsed+=seconds;render(elapsed);},
    projectAt:project,
    zoomAt(seconds){return renderer.zoom(AmbientScenes.get(settings.sceneId),locked&&heldSeconds!==null?heldSeconds:seconds,locked&&heldSeconds===null);},
    cameraAt(seconds){return renderer.camera(AmbientScenes.get(settings.sceneId),locked&&heldSeconds!==null?heldSeconds:seconds,locked&&heldSeconds===null);},
    screenAt(seconds){return renderer.screenProject(AmbientScenes.get(settings.sceneId),locked&&heldSeconds!==null?heldSeconds:seconds,locked&&heldSeconds===null);},
    get settings(){return {...settings};},
    get elapsed(){return elapsed;},
    get navigating(){return !!(navigationFade||navigationTravel);},
    get navigation(){return navigationTravel?{type:'journey',target:navigationTravel.target,duration:navigationTravel.duration}:navigationFade?{type:'geometry'}:null;},
    get pose(){const layer=lastSample.layers.find(layer=>layer.scene.id===lastSample.scene.id);return renderer.poseAt(lastSample.scene,layer?.seconds ?? lastSample.local,layer?.canonical,{...settings,pose:layer?.pose});},
    get performance(){return {...performanceStats};},
    get sample(){return lastSample;},
    get stats(){const scene=lastSample.scene;return {sceneId:scene.id,vertices:scene.geometry.vertices.length,edges:scene.geometry.edges.length,paths:scene.geometry.paths.length,scenes:scenes.length,deviceScale:renderer.deviceScale,held:locked};}
  };
})();
