/* Optional WebGL 1 torus drawing. Static UV buffers, analytic moving curves,
   depth-tested surface; no per-frame CPU vertex deformation or ray queries. */
(function(root){
  'use strict';
  const vertexCommon=`
precision highp float;
uniform vec4 u_shape;
uniform mat3 u_rotation;
uniform vec4 u_camera;
uniform vec2 u_scale;
vec4 projectUV(vec4 uv){
 float cv=uv.z*u_shape.z-uv.w*u_shape.w;
 float sv=uv.w*u_shape.z+uv.z*u_shape.w;
 vec3 p=u_rotation*vec3((u_shape.x+u_shape.y*cv)*uv.xy,u_shape.y*sv);
 float w=1.0-u_camera.x*p.z;
 float z=u_camera.x>0.0?u_camera.z*w-u_camera.w:-p.z/3.464101615;
 return vec4(p.xy*u_scale,z,w);
}`;
  const lineVertex=vertexCommon+`
attribute vec4 a_first;
attribute vec4 a_last;
attribute vec2 a_corner;
attribute float a_curve;
uniform vec3 u_colors[64];
uniform mediump vec2 u_pixels;
uniform mediump float u_width;
uniform float u_near;
uniform float u_bias;
varying mediump float v_side;
varying mediump vec3 v_color;
void clipPlane(float a,float b,inout float lo,inout float hi,inout bool valid){
 if(a<0.0&&b<0.0)valid=false;
 else if(a<0.0)lo=max(lo,a/(a-b));
 else if(b<0.0)hi=min(hi,a/(a-b));
}
void main(){
 v_color=u_colors[int(a_curve)];
 vec4 a=projectUV(a_first),b=projectUV(a_last);
 float lo=0.0,hi=1.0;bool valid=true;
 clipPlane(a.w-u_near,b.w-u_near,lo,hi,valid);
 clipPlane(a.x+a.w,b.x+b.w,lo,hi,valid);
 clipPlane(a.w-a.x,b.w-b.x,lo,hi,valid);
 clipPlane(a.y+a.w,b.y+b.w,lo,hi,valid);
 clipPlane(a.w-a.y,b.w-b.y,lo,hi,valid);
 if(!valid||lo>hi){gl_Position=vec4(2.0,2.0,2.0,1.0);v_side=0.0;return;}
 vec4 first=mix(a,b,lo),last=mix(a,b,hi),p=mix(first,last,a_corner.x);
 vec2 delta=(last.xy/last.w-first.xy/first.w)*u_pixels;
 float len=length(delta);
 if(len<0.00001){gl_Position=vec4(2.0,2.0,2.0,1.0);v_side=0.0;return;}
 vec2 normal=vec2(-delta.y,delta.x)/len;
 float edge=u_width*.5+.5;
 p.xy+=normal*(a_corner.y*edge)/u_pixels*p.w;
 // Bias depth toward the eye without changing the projected curve positions.
 // Surface sagitta is <.0003 model units at the fixed depth-mesh resolution.
 if(u_camera.x>0.0){float closer=max(u_near,p.w-u_camera.x*u_bias);p.z=(u_camera.z*closer-u_camera.w)*p.w/closer;}
 gl_Position=p;v_side=a_corner.y*edge;
}`;
  const lineFragment=`
precision mediump float;
uniform float u_width;
uniform float u_alpha;
varying float v_side;
varying vec3 v_color;
void main(){
 float coverage=clamp(u_width*.5+.5-abs(v_side),0.0,1.0);
 float alpha=u_alpha*coverage;gl_FragColor=vec4(v_color*alpha,alpha);
}`;
  const surfaceVertex=vertexCommon+`
attribute vec4 a_uv;
// An occluding wall inside the line near-plane still blocks more distant lines.
// Clamp its depth rather than cutting a hole in the occluder during entry.
void main(){vec4 p=projectUV(a_uv);p.z=max(p.z,-p.w);gl_Position=p;}`;
  const surfaceFragment=`precision mediump float;void main(){gl_FragColor=vec4(0.0);}`;
  function create(){
    const canvas=root.document.createElement('canvas');
    const gl=canvas.getContext('webgl',{alpha:true,depth:true,stencil:true,antialias:true,premultipliedAlpha:true,preserveDrawingBuffer:false});
    if(!gl||gl.getParameter(gl.DEPTH_BITS)<24)return null;
    gl.disable(gl.DITHER);
    const debug=gl.getExtension('WEBGL_debug_renderer_info'),driver=String(gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER));
    let lost=false;canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;});
    const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
    const program=(vs,fs)=>{const p=gl.createProgram(),v=shader(gl.VERTEX_SHADER,vs),f=shader(gl.FRAGMENT_SHADER,fs);gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);gl.deleteShader(v);gl.deleteShader(f);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));return p;};
    const lines=program(lineVertex,lineFragment),surface=program(surfaceVertex,surfaceFragment);
    const locations=p=>Object.fromEntries(['shape','rotation','camera','scale','pixels','width','near','bias','alpha','colors'].map(k=>[k,gl.getUniformLocation(p,'u_'+k+(k==='colors'?'[0]':''))]));
    const lineUniforms=locations(lines),surfaceUniforms=locations(surface),cache=new WeakMap();
    const buffer=(target,data)=>{const b=gl.createBuffer();gl.bindBuffer(target,b);gl.bufferData(target,data,gl.STATIC_DRAW);return b;};
    // Include horn contact and spindle axis-crossing angles exactly in v.
    const U=288,V=192,uv=new Float32Array((U+1)*(V+1)*4),indices=new Uint16Array(U*V*6);
    for(let u=0;u<=U;u++)for(let v=0;v<=V;v++){
      const a=2*Math.PI*u/U,b=2*Math.PI*v/V,i=(u*(V+1)+v)*4;
      uv[i]=Math.cos(a);uv[i+1]=Math.sin(a);uv[i+2]=Math.cos(b);uv[i+3]=Math.sin(b);
    }
    let at=0;for(let u=0;u<U;u++)for(let v=0;v<V;v++){const a=u*(V+1)+v,b=a+V+1;indices.set([a,b,a+1,b,b+1,a+1],at);at+=6;}
    const surfaceBuffer=buffer(gl.ARRAY_BUFFER,uv),surfaceIndices=buffer(gl.ELEMENT_ARRAY_BUFFER,indices);
    const surfaceAttribute=gl.getAttribLocation(surface,'a_uv');
    const attrs=['first','last','corner','curve'].map(k=>gl.getAttribLocation(lines,'a_'+k));
    function geometry(scene){
      let data=cache.get(scene.geometry);if(data)return data;
      const vertices=[],corners=[[0,-1],[1,-1],[0,1],[0,1],[1,-1],[1,1]];
      for(let curve=0;curve<scene.geometry.paths.length;curve++){
        const path=scene.geometry.paths[curve],ids=path.indices.filter((_,i)=>i%(scene.renderStride || 1)===0);
        for(let i=0;i<ids.length;i++){
          const a=scene.gpu.uv[ids[i]],b=scene.gpu.uv[ids[(i+1)%ids.length]];
          for(const corner of corners)vertices.push(...a,...b,...corner,curve);
        }
      }
      data={buffer:buffer(gl.ARRAY_BUFFER,new Float32Array(vertices)),count:vertices.length/11};cache.set(scene.geometry,data);return data;
    }
    const common=(p,u,state,shape)=>{
      gl.useProgram(p);gl.uniform4f(u.shape,shape.major,shape.minor,shape.cos,shape.sin);
      gl.uniformMatrix3fv(u.rotation,false,state.rotation);
      const k=state.pose.invDistance,near=state.pose.near,far=k?1/k+4.5:8;
      gl.uniform4f(u.camera,k,0,(far+near)/(far-near),2*far*near/(far-near)*k);
      gl.uniform2f(u.scale,state.pose.gain*state.drawScale*2/state.width,state.pose.gain*state.drawScale*2/state.height);
    };
    function draw(scene,state,shape,paint){
      if(lost||gl.isContextLost()||scene.geometry.paths.length>64)return false;
      if(canvas.width!==state.pixelWidth||canvas.height!==state.pixelHeight){canvas.width=state.pixelWidth;canvas.height=state.pixelHeight;}
      if(gl.drawingBufferWidth!==state.pixelWidth||gl.drawingBufferHeight!==state.pixelHeight)return false;
      gl.viewport(0,0,canvas.width,canvas.height);gl.colorMask(true,true,true,true);gl.depthMask(true);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);gl.clearColor(0,0,0,0);gl.clearDepth(1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      const data=geometry(scene),opaque=state.pose.surfaceOpacity;
      if(opaque>0){
        common(surface,surfaceUniforms,state,{...shape,cos:1,sin:0});
        gl.bindBuffer(gl.ARRAY_BUFFER,surfaceBuffer);gl.enableVertexAttribArray(surfaceAttribute);gl.vertexAttribPointer(surfaceAttribute,4,gl.FLOAT,false,16,0);
        for(const a of attrs)if(a!==surfaceAttribute)gl.disableVertexAttribArray(a);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,surfaceIndices);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.colorMask(false,false,false,false);
        gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);gl.colorMask(true,true,true,true);
      }
      state.markVisibility();
      common(lines,lineUniforms,state,shape);gl.bindBuffer(gl.ARRAY_BUFFER,data.buffer);
      if(!attrs.includes(surfaceAttribute))gl.disableVertexAttribArray(surfaceAttribute);
      for(let i=0;i<attrs.length;i++){gl.enableVertexAttribArray(attrs[i]);gl.vertexAttribPointer(attrs[i],[4,4,2,1][i],gl.FLOAT,false,44,[0,16,32,40][i]);}
      gl.uniform2f(lineUniforms.pixels,canvas.width/2,canvas.height/2);gl.uniform1f(lineUniforms.near,state.pose.near*state.pose.invDistance);gl.uniform1f(lineUniforms.bias,.00075*Math.sqrt(12)/scene.radius);
      gl.depthMask(false);gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.ONE,gl.ONE_MINUS_SRC_COLOR,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      for(const pass of paint.passes){
        gl.uniform1f(lineUniforms.width,pass.width);
        // One table upload retains every curve color in a shared draw call.
        // 64 colors plus camera uniforms fit the WebGL 1 vertex uniform minimum.
        gl.uniform3fv(lineUniforms.colors,pass.colors);
        for(const hidden of opaque>0?[false,true]:[false]){
          const alpha=pass.alpha*(hidden?1-opaque:1);if(alpha<=0)continue;
          if(opaque>0){gl.enable(gl.DEPTH_TEST);gl.depthFunc(hidden?gl.GREATER:gl.LEQUAL);}else gl.disable(gl.DEPTH_TEST);
          gl.uniform1f(lineUniforms.alpha,alpha);
          gl.drawArrays(gl.TRIANGLES,0,data.count);
        }
      }
      // The caller copies synchronously before returning, so preserveDrawingBuffer
      // stays false and no readPixels/CPU readback is requested during playback.
      if(gl.getError()!==gl.NO_ERROR)return false;
      return true;
    }
    return {canvas,draw,driver,prepare:geometry};
  }
  root.AmbientTorusGPU={create};
})(globalThis);
