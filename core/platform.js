/* Explicit shell adaptation; the website keeps its own install identity. */
(function(root){
 'use strict';
 const embedded=location.origin==='https://appassets.androidplatform.net' && location.pathname.startsWith('/assets/site/') && navigator.userAgent.includes(' AmbientGeometryAndroid/1');
 root.AmbientPlatform=Object.freeze({embedded,remote:embedded||new URLSearchParams(location.search).get('remote')==='1'});
})(window);
