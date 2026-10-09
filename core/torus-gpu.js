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
uniform mediump vec2 u_pixels;
uniform mediump float u_width;
uniform float u_near;
uniform float u_bias;
varying mediump float v_side;
varying mediump vec2 v_screen;
void clipPlane(float a,float b,inout float lo,inout float hi,inout bool valid){
 if(a<0.0&&b<0.0)valid=false;
 else if(a<0.0)lo=max(lo,a/(a-b));
 else if(b<0.0)hi=min(hi,a/(a-b));
}
void main(){
 vec4 a=projectUV(a_first),b=projectUV(a_last);
 float lo=0.0,hi=1.0;bool valid=true;
 clipPlane(a.w-u_near,b.w-u_near,lo,hi,valid);
 clipPlane(a.x+a.w,b.x+b.w,lo,hi,valid);
 clipPlane(a.w-a.x,b.w-b.x,lo,hi,valid);
 clipPlane(a.y+a.w,b.y+b.w,lo,hi,valid);
 clipPlane(a.w-a.y,b.w-b.y,lo,hi,valid);
 if(!valid||lo>hi){gl_Position=vec4(2.0,2.0,2.0,1.0);v_side=0.0;v_screen=vec2(0.0);return;}
 vec4 first=mix(a,b,lo),last=mix(a,b,hi),p=mix(first,last,a_corner.x);
 vec2 delta=(last.xy/last.w-first.xy/first.w)*u_pixels;
 float len=length(delta);
 if(len<0.00001){gl_Position=vec4(2.0,2.0,2.0,1.0);v_side=0.0;v_screen=vec2(0.0);return;}
 vec2 normal=vec2(-delta.y,delta.x)/len;
 float edge=u_width*.5+.5;
 p.xy+=normal*(a_corner.y*edge)/u_pixels*p.w;
 // Bias depth toward the eye without changing the projected curve positions.
 // Surface sagitta is <.0003 model units at the fixed depth-mesh resolution.
 if(u_camera.x>0.0){float closer=max(u_near,p.w-u_camera.x*u_bias);p.z=(u_camera.z*closer-u_camera.w)*p.w/closer;}
 gl_Position=p;v_side=a_corner.y*edge;
 v_screen=p.xy/p.w;
}`;
  const lineFragment=`
precision mediump float;
uniform float u_width;
uniform float u_alpha;
uniform float u_field;
uniform vec2 u_fieldScale;
uniform vec2 u_pixels;
uniform vec3 u_color;
uniform sampler2D u_palette;
varying float v_side;
varying vec2 v_screen;
void main(){
 float coverage=clamp(u_width*.5+.5-abs(v_side),0.0,1.0);
 vec3 color=u_color;
 if(u_field>.5){
  float t=clamp((dot(gl_FragCoord.xy/u_pixels-1.0,u_fieldScale)+1.0)*6.0,0.0,12.0);
  color=texture2D(u_palette,vec2((t+.5)/13.0,.5)).rgb;
 }
 float alpha=u_alpha*coverage;gl_FragColor=vec4(color*alpha,alpha);
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
    const locations=p=>Object.fromEntries(['shape','rotation','camera','scale','pixels','width','near','bias','alpha','field','fieldScale','color','palette'].map(k=>[k,gl.getUniformLocation(p,'u_'+k)]));
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
    const attrs=['first','last','corner'].map(k=>gl.getAttribLocation(lines,'a_'+k));
    const palette=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,palette);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,13,1,0,gl.RGB,gl.UNSIGNED_BYTE,null);
    function geometry(scene){
      let data=cache.get(scene.geometry);if(data)return data;
      const vertices=[],ranges=[],corners=[[0,-1],[1,-1],[0,1],[0,1],[1,-1],[1,1]];
      for(const path of scene.geometry.paths){
        const start=vertices.length/10,ids=path.indices.filter((_,i)=>i%(scene.renderStride || 1)===0);
        for(let i=0;i<ids.length;i++){
          const a=scene.gpu.uv[ids[i]],b=scene.gpu.uv[ids[(i+1)%ids.length]];
          for(const corner of corners)vertices.push(...a,...b,...corner);
        }
        ranges.push({start,count:vertices.length/10-start});
      }
      data={buffer:buffer(gl.ARRAY_BUFFER,new Float32Array(vertices)),count:vertices.length/10,ranges};cache.set(scene.geometry,data);return data;
    }
    const common=(p,u,state,shape)=>{
      gl.useProgram(p);gl.uniform4f(u.shape,shape.major,shape.minor,shape.cos,shape.sin);
      gl.uniformMatrix3fv(u.rotation,false,state.rotation);
      const k=state.pose.invDistance,near=state.pose.near,far=k?1/k+4.5:8;
      gl.uniform4f(u.camera,k,0,(far+near)/(far-near),2*far*near/(far-near)*k);
      gl.uniform2f(u.scale,state.pose.gain*state.drawScale*2/state.width,state.pose.gain*state.drawScale*2/state.height);
    };
    function draw(scene,state,shape,paint){
      if(lost||gl.isContextLost())return false;
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
      for(let i=0;i<attrs.length;i++){gl.enableVertexAttribArray(attrs[i]);gl.vertexAttribPointer(attrs[i],i===2?2:4,gl.FLOAT,false,40,i*16);}
      gl.uniform2f(lineUniforms.pixels,canvas.width/2,canvas.height/2);gl.uniform1f(lineUniforms.near,state.pose.near*state.pose.invDistance);gl.uniform1f(lineUniforms.bias,.00075*Math.sqrt(12)/scene.radius);
      gl.depthMask(false);gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.ONE,gl.ONE_MINUS_SRC_COLOR,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,palette);gl.uniform1i(lineUniforms.palette,0);
      for(const pass of paint.passes){
        gl.uniform1f(lineUniforms.width,pass.width);
        if(paint.mix>0)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,13,1,gl.RGB,gl.UNSIGNED_BYTE,new Uint8Array(Array.from(pass.stops,v=>Math.round(v*255))));
        for(const hidden of opaque>0?[false,true]:[false]){
          const alpha=pass.alpha*(hidden?1-opaque:1);if(alpha<=0)continue;
          if(opaque>0){gl.enable(gl.DEPTH_TEST);gl.depthFunc(hidden?gl.GREATER:gl.LEQUAL);}else gl.disable(gl.DEPTH_TEST);
          if(paint.mix>0){
            gl.uniform1f(lineUniforms.alpha,alpha*paint.mix*paint.energy);gl.uniform1f(lineUniforms.field,1);gl.uniform2f(lineUniforms.fieldScale,paint.fieldScale[0],paint.fieldScale[1]);
            gl.drawArrays(gl.TRIANGLES,0,data.count);
          }
          if(paint.mix<1){
            gl.uniform1f(lineUniforms.alpha,alpha*(1-paint.mix));gl.uniform1f(lineUniforms.field,0);
            for(let i=0;i<data.ranges.length;i++){const range=data.ranges[i];gl.uniform3fv(lineUniforms.color,pass.colors[i]);gl.drawArrays(gl.TRIANGLES,range.start,range.count);}
          }
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
