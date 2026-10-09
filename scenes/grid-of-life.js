// Geometry is generated from the approved source by build.cjs. Do not edit that model here.
AmbientScenes.register({
  id:'grid-of-life',
  title:'Grid of Life',
  subtitle:'Light in perfect relation.',
  eyebrow:'64 TETRAHEDRA · ONE CONTINUOUS JOURNEY',
  study:'STUDY 001',
  canonicalLabel:'THE GRID',
  geometry:GRID_GEOMETRY,
  view:{right:[1/Math.sqrt(2),-1/Math.sqrt(2),0],up:[1/Math.sqrt(6),1/Math.sqrt(6),-2/Math.sqrt(6)],forward:[1/Math.sqrt(3),1/Math.sqrt(3),1/Math.sqrt(3)]},
  // Preserve the original algebra and rounding of the exact isometric projection.
  project:([x,y,z])=>[(x-y)/Math.sqrt(2),-(x+y-2*z)/Math.sqrt(6),(x+y+z)/Math.sqrt(3)],
  views:[{id:'orbit',title:'Orbit'},{id:'sacred',title:'Sacred view'}],defaultView:'orbit',
  journeyStops:({viewId})=>viewId==='sacred'?[{id:'sacred',title:'Sacred view',progress:0}]:[{id:'sacred',title:'Sacred view',progress:0,leaveProgress:0},{id:'orbit',title:'Orbit',progress:.25}],
  motion:({progress,eased,viewId})=>viewId==='sacred'?{x:0,y:0,z:0}
    : {x:Math.PI*2*eased,y:Math.PI*2*eased+.65*Math.sin(Math.PI*2*eased),z:Math.PI*4*eased},
  provenance:'../grid of life/Geometry notes.md',
  expected:{vertices:63,edges:240,projectedVertices:49}
});
