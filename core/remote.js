/* Remote navigation uses the shared settings and their input handlers. */
(function(root){
 'use strict';
 root.AmbientRemote={create({panel,setQuiet,keepAwake,navigate}){
  const $=id=>document.getElementById(id);
  let restore='settings',lastArrow=-Infinity;
  function controls(){
   const scope=$('panel').hidden?document.querySelector('nav'):$('panel');
   return [...scope.querySelectorAll('button,input,select,summary')].filter(el=>!el.disabled&&el.getClientRects().length);
  }
  function focus(el){if(!el)return;el.focus({preventScroll:true});el.scrollIntoView({block:'nearest',inline:'nearest'});}
  function reveal(){setQuiet(false);focus(controls().find(el=>el.id===restore)||controls()[0]);}
  function quiet(){if(document.activeElement.id)restore=document.activeElement.id;document.activeElement.blur();}
  function back(){
   const detail=document.activeElement.closest('details');
   if(detail?.open){detail.open=false;focus(detail.querySelector('summary'));return true;}
   if(!$('panel').hidden){panel(false);return true;}
   if(!document.body.classList.contains('quiet')){quiet();setQuiet(true);return true;}
   return false;
  }
  function key(key,repeat=false){
   if(key==='Escape'||key==='Back')return repeat?true:back();
   const arrow=key.startsWith('Arrow');
   if(!arrow&&!['Enter','Menu',' '].includes(key))return false;
   keepAwake();
   // Playback keys are shared by browser keyboards and Android's native bridge.
   // Ignore held-button repeats here; each deliberate press visits one destination.
   const quietPlayback=document.body.classList.contains('quiet');
   const buttonFocused=controls().includes(document.activeElement);
   if(arrow&&$('panel').hidden&&(quietPlayback||!buttonFocused&&(AmbientPlatform.remote||document.fullscreenElement))){
    if(!repeat)navigate(key);return true;
   }
   if(arrow){const now=performance.now();if(repeat&&now-lastArrow<140)return true;lastArrow=now;}
   else if(repeat)return true;
   if(key==='Menu'){panel($('panel').hidden);return true;}
   if(document.body.classList.contains('quiet')){reveal();return true;}
   const list=controls(),active=document.activeElement,index=list.indexOf(active);
   if(index<0){focus(list[0]);return true;}
   if(key==='ArrowUp'||key==='ArrowDown'){
    focus(list[(index+(key==='ArrowDown'?1:-1)+list.length)%list.length]);return true;
   }
   if(key==='ArrowLeft'||key==='ArrowRight'){
    const delta=key==='ArrowRight'?1:-1;
    if(active.tagName==='SELECT'){
     const options=[...active.options].filter(o=>!o.disabled),i=options.indexOf(active.selectedOptions[0]);
     active.value=options[(i+delta+options.length)%options.length].value;active.dispatchEvent(new Event('input',{bubbles:true}));
    }else if(active.type==='range'){
     active.value=String(Math.min(+active.max,Math.max(+active.min,+active.value+delta*(+active.step||1))));
     active.dispatchEvent(new Event('input',{bubbles:true}));
    }else focus(list[(index+delta+list.length)%list.length]);
    return true;
   }
   if(active.tagName==='SELECT'){key('ArrowRight');return true;}
   if(active.type==='range'){key('ArrowRight');return true;}
   active.click();
   const detail=active.closest('details');if(detail?.open)detail.scrollIntoView({block:'end'});
   return true;
  }
  if(AmbientPlatform.remote){
   document.body.classList.add('remote');
   $('hint').textContent='↑↓ geometry · ←→ view · OK shows controls · Back hides controls';
   for(const el of document.querySelectorAll('select,input[type=range]')){
    const hint=document.createElement('span');hint.className='remote-value';hint.setAttribute('aria-hidden','true');
    el.insertAdjacentElement('afterend',hint);
   }
  }
  document.addEventListener('keydown',event=>{
   const buttonFocused=$('panel').hidden&&document.querySelector('nav').contains(document.activeElement);
   const playback=event.key.startsWith('Arrow')&&$('panel').hidden&&(document.body.classList.contains('quiet')||document.fullscreenElement||buttonFocused);
   if((AmbientPlatform.remote||playback)&&key(event.key,event.repeat)){event.preventDefault();event.stopImmediatePropagation();}
  },true);
  function sync(){if(!AmbientPlatform.remote)return;for(const el of document.querySelectorAll('select,input[type=range]')){
   if(el.nextElementSibling?.classList.contains('remote-value'))el.nextElementSibling.textContent='‹ '+(el.tagName==='SELECT'?el.selectedOptions[0]?.textContent:el.value)+' ›';
  }}
  return {key,back,quiet,sync,reveal};
 }};
})(window);
