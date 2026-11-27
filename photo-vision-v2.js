"use strict";
function albumPhotoVision() {
  const directions = [[0,-3],[1,-3],[2,-2],[3,-1],[3,0],[3,1],[2,2],[1,3],[0,3],[-1,3],[-2,2],[-3,1],[-3,0],[-3,-1],[-2,-2],[-1,-3]];
  let seed = 147346171;
  function random() { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; }
  const offsets = [];
  for (let bit=0;bit<128;bit++) {
    const pair=[];
    while (pair.length<4) {
      const x=Math.round(20*random()-10), y=Math.round(20*random()-10);
      if (x*x+y*y<=110) pair.push(x,y);
    }
    offsets.push(pair);
  }
  const patterns=Array.from({length:32},(_,bin)=>{
    const a=bin*2*Math.PI/32, c=Math.cos(a), s=Math.sin(a);
    return offsets.map(([x,y,u,v])=>[Math.round(c*x-s*y), Math.round(s*x+c*y), Math.round(c*u-s*v), Math.round(s*u+c*v)]);
  });

  function smooth(image,w,h) {
    const hor=new Uint16Array(image.length), out=new Uint8Array(image.length);
    for (let y=0;y<h;y++) for(let x=1,i=y*w+1;x<w-1;x++,i++)
      hor[i]=image[i-1]+2*image[i]+image[i+1];
    for(let i=w+1;i<image.length-w-1;i++) out[i]=(hor[i-w]+2*hor[i]+hor[i+w]+8)>>4;
    return out;
  }
  // FAST-9 corners, spatially balanced so a textured edge cannot dominate the fit.
  function describe(image,w,h,limit) {
    const gray=smooth(image,w,h), d=directions.map(([x,y])=>y*w+x);
    const candidates=[], border=13, t=13;
    for(let y=border;y<h-border;y++) for(let x=border;x<w-border;x++) {
      const i=y*w+x, center=gray[i], lo=center-t, hi=center+t;
      const a=gray[i+d[0]], b=gray[i+d[8]], c=gray[i+d[4]], e=gray[i+d[12]];
      if ((a<=hi&&b<=hi || c<=hi&&e<=hi) && (a>=lo&&b>=lo || c>=lo&&e>=lo)) continue;
      let bright=0,dark=0,corner=false;
      for(let j=0;j<24;j++) {
        const v=gray[i+d[j&15]];
        bright=v>hi?bright+1:0; dark=v<lo?dark+1:0;
        if (bright>=9||dark>=9) {corner=true;break;}
      }
      if(!corner) continue;
      let strength=0;
      for(let j=0;j<16;j++) strength+=Math.abs(gray[i+d[j]]-center);
      candidates.push({x,y,i,strength});
    }
    candidates.sort((a,b)=>b.strength-a.strength);
    const columns=Math.ceil(w/24), cells=new Uint8Array(columns*Math.ceil(h/24));
    const blocked=new Uint8Array(w*h), points=[];
    const patternOffsets=patterns.map(pattern=>pattern.map(([x,y,u,v])=>[y*w+x,v*w+u]));
    for(const {x,y,i} of candidates) {
      const cell=Math.floor(y/24)*columns+Math.floor(x/24);
      if(blocked[i] || cells[cell]>=5) continue;
      let mx=0,my=0;
      for(let py=-7;py<=7;py+=2)for(let px=-7;px<=7;px+=2){
        const weight=gray[i+py*w+px]; mx+=px*weight; my+=py*weight;
      }
      const angle=Math.round(Math.atan2(my,mx)*(16/Math.PI))&31;
      const pattern=patternOffsets[angle], words=[0,0,0,0];
      for(let j=0;j<128;j++){
        const [u,v]=pattern[j];
        if(gray[i+u]<gray[i+v])words[j>>5]|=1<<(j&31);
      }
      points.push({x,y,a:words[0],b:words[1],c:words[2],d:words[3]});
      for(let k=-4;k<=4;k++) blocked.fill(1,i+k*w-4,i+k*w+5);
      cells[cell]++;
      if(points.length>=limit)break;
    }
    return points;
  }

  function pop(x) {
    x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333);
    return Math.imul((x+(x>>>4))&0x0f0f0f0f,0x01010101)>>>24;
  }
  function matches(observed, target) {
    const pairs=[];
    for(const q of observed) {
      let best=129, runnerUp=129, chosen;
      for(const p of target.points) {
        const h=pop(q.a^p.a)+pop(q.b^p.b)+pop(q.c^p.c)+pop(q.d^p.d);
        if(h<best){
          if(!chosen||Math.abs(chosen.x-p.x)+Math.abs(chosen.y-p.y)>.045)runnerUp=best;
          best=h;chosen=p;
        }else if(h<runnerUp && Math.abs(chosen.x-p.x)+Math.abs(chosen.y-p.y)>.045)runnerUp=h;
      }
      if(chosen && best<39 && best<runnerUp*.84) pairs.push({x:chosen.x,y:chosen.y,u:q.x,v:q.y,dist:best});
    }
    pairs.sort((a,b)=>a.dist-b.dist);
    const good=[];
    for(const p of pairs) if(!good.some(q=>Math.abs(q.x-p.x)+Math.abs(q.y-p.y)<.025))good.push(p);
    return good;
  }
  function leastSquares(points, projective) {
    const n=projective?8:6, mat=Array.from({length:n},()=>new Float64Array(n+1));
    for(const {x,y,u,v} of points) {
      const a=[x,y,1,0,0,0,-u*x,-u*y], b=[0,0,0,x,y,1,-v*x,-v*y];
      for(let i=0;i<n;i++){
        for(let j=0;j<n;j++)mat[i][j]+=a[i]*a[j]+b[i]*b[j];
        mat[i][n]+=a[i]*u+b[i]*v;
      }
    }
    for(let col=0;col<n;col++){
      let pivot=col;
      for(let i=col+1;i<n;i++)if(Math.abs(mat[i][col])>Math.abs(mat[pivot][col]))pivot=i;
      if(Math.abs(mat[pivot][col])<1e-8)return null;
      [mat[col],mat[pivot]]=[mat[pivot],mat[col]];
      const diagonal=mat[col][col];
      for(let j=col;j<=n;j++)mat[col][j]/=diagonal;
      for(let i=0;i<n;i++)if(i!==col){
        const f=mat[i][col];
        for(let j=col;j<=n;j++)mat[i][j]-=f*mat[col][j];
      }
    }
    const H=mat.map(row=>row[n]); if(!projective)H.push(0,0);
    return H;
  }
  function project(H,x,y) {
    const z=1+H[6]*x+H[7]*y;
    return [(H[0]*x+H[1]*y+H[2])/z,(H[3]*x+H[4]*y+H[5])/z];
  }
  function inliers(H,pairs,eps) {
    return pairs.filter(({x,y,u,v})=>{
      const [a,b]=project(H,x,y);
      return (a-u)*(a-u)+(b-v)*(b-v)<eps*eps;
    });
  }
  function fit(pairs,ratio,w,h) {
    if(pairs.length<7)return null;
    let best=[], tries=0;
    const pool=pairs.slice(0,36), max=Math.max(w,h);
    for(let i=0;i<pool.length;i++) for(let j=i+1;j<pool.length && tries<330;j++) {
      const a=pool[i],b=pool[j], x=b.x-a.x,y=b.y-a.y, u=b.u-a.u,v=b.v-a.v, len=x*x+y*y;
      if(len<.011)continue;
      tries++;
      const c=(u*x+v*y)/len, s=(v*x-u*y)/len, scale=Math.hypot(c,s);
      if(scale<max*.065||scale>max*4)continue;
      const H=[c,-s,a.u-c*a.x+s*a.y,s,c,a.v-s*a.x-c*a.y,0,0];
      const cluster=inliers(H,pairs,Math.max(7,Math.min(17,scale*.095)));
      if(cluster.length>best.length)best=cluster;
    }
    if(best.length<6)return null;
    let H=leastSquares(best,false); if(!H)return null;
    best=inliers(H,pairs,7.5);
    if(best.length<7)return null;
    H=leastSquares(best,true); if(!H)return null;
    best=inliers(H,pairs,5);
    if(best.length<7)return null;
    H=leastSquares(best,true); if(!H)return null;
    const span=key=>Math.max(...best.map(p=>p[key]))-Math.min(...best.map(p=>p[key]));
    if(span('x')<.24||span('y')<ratio*.18)return null;
    const corners=[[0,0],[1,0],[1,ratio],[0,ratio]].map(([x,y])=>project(H,x,y));
    if(corners.flat().some(v=>!Number.isFinite(v)||Math.abs(v)>max*5))return null;
    let area=0;
    for(let i=0;i<4;i++){
      const a=corners[i],b=corners[(i+1)%4],c=corners[(i+2)%4];
      if((b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0])<=0)return null;
      area+=a[0]*b[1]-a[1]*b[0];
    }
    if(area/2<w*h*.008||area/2>w*h*8)return null;
    // Keep spatially separated landmarks for cheap frame-to-frame tracking.
    const landmarks=[];
    for(const p of best) {
      if(landmarks.every(q=>(q.u-p.u)**2+(q.v-p.v)**2>55))landmarks.push(p);
      if(landmarks.length>=32)break;
    }
    return {corners,score:best.length,landmarks};
  }
  function unpack(buffer) {
    const dv=new DataView(buffer);
    if(dv.getUint32(0)!==0x46545632)throw Error('Invalid feature model');
    const count=dv.getUint16(4); if(!count||count>64)throw Error('Invalid target count');
    let at=6; const models=[];
    for(let i=0;i<count;i++){
      const ratio=dv.getFloat32(at,true), n=dv.getUint16(at+4,true); at+=6;
      if(!Number.isFinite(ratio)||ratio<=0||ratio>10 || n>1800)throw Error('Invalid descriptor');
      const points=[];
      for(let j=0;j<n;j++,at+=20){
        points.push({x:dv.getUint16(at,true)/65535,y:dv.getUint16(at+2,true)/65535*ratio,
          a:dv.getInt32(at+4,true),b:dv.getInt32(at+8,true),c:dv.getInt32(at+12,true),d:dv.getInt32(at+16,true)});
      }
      models.push({ratio,points});
    }
    if(at!==buffer.byteLength)throw Error('Invalid feature model');
    return models;
  }
  function identify(image,w,h,models) {
    const observed=describe(image,w,h,310);
    const candidates=[];
    for(let i=0;i<models.length;i++){
      const estimate=fit(matches(observed,models[i]),models[i].ratio,w,h);
      if(!estimate)continue;
      const q=estimate.corners, mx=w/2,my=h/2;
      // On a spread with adjoining prints, prefer the photograph underneath
      // the camera's centre even if its neighbour has a more detailed texture.
      let aimed=true;
      for(let j=0;j<4;j++){
        const [x,y]=q[j],[nx,ny]=q[(j+1)%4];
        if((nx-x)*(my-y)-(ny-y)*(mx-x)<0)aimed=false;
      }
      const cx=q.reduce((s,p)=>s+p[0],0)/4,cy=q.reduce((s,p)=>s+p[1],0)/4;
      const distance=Math.hypot((mx-cx)/w,(my-cy)/h);
      if(!aimed && distance>.36)continue;
      candidates.push({...estimate,index:i,aimed,distance});
    }
    const pointed=candidates.filter(c=>c.aimed);
    const ranked=(pointed.length?pointed:candidates).sort((a,b)=>b.score-a.score);
    return ranked.length && (!ranked[1]||ranked[0].score>ranked[1].score*1.18)?ranked[0]:null;
  }
  // Match a small normalized luminance patch around each previously confirmed
  // landmark. The original target coordinates survive every update. A full
  // descriptor match periodically corrects drift and detects a different page.
  function follow(image,previous,w,h,prior,ratio) {
    const pairs=[];
    for(const p of prior.landmarks) {
      const x=Math.round(p.u),y=Math.round(p.v), pad=7;
      if(x<pad||x>=w-pad||y<pad||y>=h-pad)continue;
      let total=0,varA=0;
      const patch=new Float32Array(49), offsets=new Int32Array(49);
      for(let py=-6,j=0;py<=6;py+=2)for(let px=-6;px<=6;px+=2,j++){
        offsets[j]=py*w+px;total+=patch[j]=previous[y*w+x+offsets[j]];
      }
      for(let j=0;j<49;j++){patch[j]-=total/49;varA+=patch[j]*patch[j];}
      if(varA<49*24)continue;
      const predictedX=Math.round(p.u+(p.vx||0)),predictedY=Math.round(p.v+(p.vy||0));
      let bx=predictedX,by=predictedY,best=-1;
      function examine(cx,cy) {
        if(cx<pad||cx>=w-pad||cy<pad||cy>=h-pad)return;
        let sum=0,sq=0,dot=0;const center=cy*w+cx;
        for(let j=0;j<49;j++){
          const value=image[center+offsets[j]];
          sum+=value;sq+=value*value;dot+=patch[j]*value;
        }
        const variance=sq-sum*sum/49;
        if(variance<49*24||dot<=0)return;
        const score=dot*dot/(varA*variance);
        if(score>best){best=score;bx=cx;by=cy;}
      }
      examine(predictedX,predictedY);
      if(best<.91){
        for(let dy=-12;dy<=12;dy+=3)for(let dx=-12;dx<=12;dx+=3)examine(predictedX+dx,predictedY+dy);
        const coarseX=bx,coarseY=by;
        for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)examine(coarseX+dx,coarseY+dy);
      }
      if(best>.69)pairs.push({x:p.x,y:p.y,u:bx,v:by,oldU:p.u,oldV:p.v,vx:bx-p.u,vy:by-p.v});
    }
    if(pairs.length<7)return null;
    // Small frame-to-frame movements have four well-conditioned degrees of
    // freedom. Refitting eight perspective coefficients from a handful of
    // landmarks can otherwise make a distant corner jump tens of pixels.
    const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
    const dx=median(pairs.map(p=>p.vx)),dy=median(pairs.map(p=>p.vy));
    let kept=pairs.filter(p=>Math.hypot(p.vx-dx,p.vy-dy)<8);
    function similarity(points){
      let x=0,y=0,u=0,v=0;
      for(const p of points){x+=p.oldU;y+=p.oldV;u+=p.u;v+=p.v;}
      x/=points.length;y/=points.length;u/=points.length;v/=points.length;
      let norm=0,a=0,b=0;
      for(const p of points){
        const X=p.oldU-x,Y=p.oldV-y,U=p.u-u,V=p.v-v;
        norm+=X*X+Y*Y;a+=X*U+Y*V;b+=X*V-Y*U;
      }
      if(norm<100)return null;
      a/=norm;b/=norm;
      return [a,-b,u-a*x+b*y,b,a,v-b*x-a*y,0,0];
    }
    if(kept.length<7)return null;
    let H=similarity(kept);if(!H)return null;
    kept=kept.filter(p=>{const [u,v]=project(H,p.oldU,p.oldV);return Math.hypot(u-p.u,v-p.v)<3.5;});
    if(kept.length<7 || !(H=similarity(kept)) || Math.abs(Math.hypot(H[0],H[3])-1)>.12)return null;
    const corners=prior.corners.map(([x,y])=>project(H,x,y));
    return {index:prior.index,score:kept.length,corners,landmarks:kept};
  }
  function tracker(models) {
    let previous=null,prior=null,lastW=0,lastH=0,lastFull=-Infinity;
    return (image,w,h,now)=>{
      let result=null;
      if(prior && previous && w===lastW && h===lastH)
        result=follow(image,previous,w,h,prior,models[prior.index].ratio);
      if(!result||now-lastFull>=420){
        const detected=identify(image,w,h,models);
        if(detected)result=detected;
        lastFull=now;
      }
      previous=image;prior=result;lastW=w;lastH=h;
      return result?{corners:result.corners,index:result.index,score:result.score}:null;
    };
  }
  return {describe,unpack,identify,tracker};
}
if(typeof module!=='undefined' && module.exports)module.exports=albumPhotoVision;
