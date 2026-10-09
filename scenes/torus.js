// A surface of revolution, sampled once. Form changes preserve every path and UV.
(() => {
  'use strict';
  const TAU = 2 * Math.PI, OUTER = 1.8, SAMPLES = 288, FAMILIES = [17,15];
  const b = AmbientScenes.geometryBuilder(), uv = [];
  const point = (u, v, major) => {
    const minor = OUTER - major, radial = major + minor * Math.cos(v);
    // Retain signed radial coordinates: the spindle includes its inner sheet.
    return [radial * Math.cos(u), radial * Math.sin(u), minor * Math.sin(v)];
  };
  function curve(offset, sign) {
    const points = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = TAU * i / SAMPLES;
      const u = t + offset, v = sign * t;
      uv.push(Object.freeze([Math.cos(u), Math.sin(u), Math.cos(v), Math.sin(v)]));
      points.push(point(u, v, 1.2));
    }
    b.path(points, {closed:true});
  }
  // Two opposite winding families, each circling the ring and tube once.
  // Coprime counts prevent whole families coinciding overhead during circulation.
  for (let family = 0; family < 2; family++) {
    for (let i = 0; i < FAMILIES[family]; i++) {
      curve(TAU * (i + family / 2) / FAMILIES[family], family === 0 ? 1 : -1);
    }
  }
  Object.freeze(uv);
  const smooth = x => x*x*x*(x*(x*6-15)+10);
  // Each stable form gets a full camera tour before the next flat-ended morph.
  // Default travel is 690 seconds: three 220-second tours and 10-second morphs.
  const stops = Object.freeze([
    [0,1.2], [220/690,1.2], [230/690,.9], [450/690,.9],
    [460/690,.6], [680/690,.6], [1,1.2]
  ].map(Object.freeze));
  const tours = Object.freeze([[0,220/690],[230/690,450/690],[460/690,680/690]].map(Object.freeze));
  function majorAt(progress) {
    const p = Math.max(0, Math.min(1, progress));
    for (let i = 1; i < stops.length; i++) {
      const [end, to] = stops[i], [start, from] = stops[i-1];
      if (p <= end) return from + (to-from) * smooth((p-start)/(end-start));
    }
    return 1.2;
  }
  const cubicAt=(a,b,c,t)=>((t+a)*t+b)*t+c;
  const oppositeSign=(first,value)=>value===0||(value<0)!==(first<0);
  function prepareOcclusion({progress,parameters}) {
    const R=parameters.automatic?majorAt(progress):parameters.major,r=OUTER-R;
    const R4=4*R*R,offset=R*R-r*r;
    return (point,eye)=>{
      const [x,y,z]=point;let dx=eye[0]-x,dy=eye[1]-y,dz=eye[2]-z;
      const length=Math.sqrt(dx*dx+dy*dy+dz*dz);
      if(length<=.002)return false;
      dx/=length;dy/=length;dz/=length;
      const b=2*(x*dx+y*dy+z*dz),c=x*x+y*y+z*z+offset;
      // Divide the known surface root out of the ray's torus quartic. To test
      // whether its cubic has another root, inspect its endpoints and at most
      // two extrema; no inverse trig, cube roots, or root arrays are needed.
      const a=2*b,bb=b*b+2*c-R4*(dx*dx+dy*dy),cc=2*b*c-2*R4*(x*dx+y*dy);
      const low=.001,high=Math.min(length-.001,2*OUTER+.001);
      const first=cubicAt(a,bb,cc,low);
      if(oppositeSign(first,cubicAt(a,bb,cc,high)))return true;
      const discriminant=a*a-3*bb;if(discriminant<0)return false;
      const s=Math.sqrt(discriminant),left=(-a-s)/3,right=(-a+s)/3;
      return (left>low&&left<high&&oppositeSign(first,cubicAt(a,bb,cc,left)))||(right>low&&right<high&&oppositeSign(first,cubicAt(a,bb,cc,right)));
    };
  }
  const occludes=(point,eye,context)=>prepareOcclusion(context)(point,eye);
  function prepareDeform({progress,parameters,animationPhase=0,animationPeriod=120}) {
    const major=parameters.automatic?majorAt(progress):parameters.major,minor=OUTER-major;
    const angle=-TAU*Math.max(1,Math.floor(animationPeriod/60))*animationPhase,c=Math.cos(angle),s=Math.sin(angle);
    return (vertex,index)=>{
      const [cu,su,baseCos,baseSin]=uv[index],cv=baseCos*c-baseSin*s,sv=baseSin*c+baseCos*s,radial=major+minor*cv;
      return [radial*cu,radial*su,minor*sv];
    };
  }
  const elevation = 0; // Exact side-on canonical view; overhead tours reach 90°.
  function tourProgress(progress, automatic) {
    if(!automatic)return progress;
    const tour=tours.find(([start,end])=>progress>=start&&progress<=end);
    return tour?(progress-tour[0])/(tour[1]-tour[0]):null;
  }
  function orbit(progress, automatic) {
    const local=tourProgress(progress,automatic);
    if(local===null)return {x:0,y:0,z:0};
    const ramp=(value,start,end)=>smooth(Math.max(0,Math.min(1,(value-start)/(end-start))));
    // Side, overhead, side again, then the interior camera approaches.
    const tilt=(Math.PI/2-elevation)*ramp(local,60/220,70/220)*(1-ramp(local,130/220,140/220));
    // Keep the camera motionless for each 60-second stop. Complete a full turn
    // across the two overhead approaches, rather than rotating during a stop.
    const azimuth=Math.PI*(ramp(local,60/220,70/220)+ramp(local,130/220,140/220));
    // Desired rotation is Rx(tilt) Rz(azimuth): orbit first, then elevate.
    // Convert to the renderer's Rz(z) Ry(y) Rx(x) order so azimuth never
    // accidentally tips the camera back down during the overhead plateau.
    return {
      x:Math.atan2(Math.sin(tilt)*Math.cos(azimuth),Math.cos(tilt)),
      y:Math.asin(-Math.sin(tilt)*Math.sin(azimuth)),
      z:Math.atan2(Math.cos(tilt)*Math.sin(azimuth),Math.cos(azimuth))
    };
  }
  AmbientScenes.register({
    id:'torus', title:'Torus', subtitle:'One surface. Three forms.',
    eyebrow:'RING · HORN · SPINDLE', study:'STUDY 002', canonicalLabel:'THE TORUS',
    geometry:b.build(),
    view:{right:[1,0,0], up:[0,0,1], forward:[0,-1,0]},
    motion:({progress,parameters,viewId}) => viewId==='overhead'?{x:Math.PI/2,y:0,z:0}
      : ['side','interior'].includes(viewId)?{x:0,y:0,z:0}:orbit(progress,parameters.automatic),
    views:[{id:'all',title:'All views'},{id:'side',title:'Side'},{id:'overhead',title:'Overhead'},{id:'interior',title:'Interior'}],
    viewAliases:{orbit:'all',inside:'interior'},defaultView:'all',defaultDuration:720,
    journeyStops:({variantId,parameters,viewId}) => {
      const selected=viewId==='all'?['side','overhead','interior']:[viewId];
      const offsets={side:0,overhead:70/220,interior:150/220},leaves={side:60/220,overhead:130/220,interior:210/220};
      const forms=parameters.automatic?['ring','horn','spindle']:[variantId];
      return forms.flatMap((form,i)=>selected.map(view=>({
        id:form+'-'+view,title:form[0].toUpperCase()+form.slice(1)+' · '+view[0].toUpperCase()+view.slice(1),
        progress:parameters.automatic?tours[i][0]+(tours[i][1]-tours[i][0])*(selected.length===1?0:offsets[view]):selected.length===1?0:offsets[view],
        leaveProgress:selected.length===1?undefined:parameters.automatic?tours[i][0]+(tours[i][1]-tours[i][0])*leaves[view]:leaves[view]
      })));
    },
    durationRevision:2,previousDefaultDuration:240,
    camera:({progress,parameters,viewId}) => {
      const local=tourProgress(progress,parameters.automatic);
      const ramp=(value,start,end)=>smooth(Math.max(0,Math.min(1,(value-start)/(end-start))));
      const amount=viewId==='interior'?1:viewId==='all'&&local!==null
        ? Math.max(0,Math.min(1,ramp(local,140/220,150/220)*(1-ramp(local,210/220,1)))):0;
      // Eye on the radial line toward the throat, between the axis and outer wall.
      // A wide lens exposes the pillar and surrounding sides without magnification.
      return {amount,distance:1.69,fov:60+30*amount,fovAxis:'vertical',near:.025,surfaceOpacity:amount};
    },
    occludes,prepareOcclusion,prepareDeform,renderStride:2,
    gpu:{type:'torus',uv},
    gpuParameters:({progress,parameters,animationPhase=0,animationPeriod=120})=>{
      const major=parameters.automatic?majorAt(progress):parameters.major,angle=-TAU*Math.max(1,Math.floor(animationPeriod/60))*animationPhase;
      return {major,minor:OUTER-major,cos:Math.cos(angle),sin:Math.sin(angle)};
    },
    variants:[
      {id:'ring', title:'Ring torus', parameters:{major:1.2}},
      {id:'horn', title:'Horn torus', parameters:{major:.9}},
      {id:'spindle', title:'Spindle torus', parameters:{major:.6}},
      {id:'morph', title:'Automatic morph', parameters:{automatic:true}}
    ],
    defaultVariant:'morph', boundsRadius:OUTER,
    // Fixed u and steady decreasing v: upward inside, outward above, downward
    // outside, inward below. Whole circuits preserve single/collection seams.
    deform:(vertex,index,context)=>prepareDeform(context)(vertex,index),
    provenance:'scenes/torus.md'
  });
})();
