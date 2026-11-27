(() => {
  "use strict";
  const live=document.getElementById("live"), clip=document.getElementById("clip");
  const canvas=document.createElement("canvas");
  const ctx=canvas.getContext("2d",{alpha:false,willReadFrequently:true});
  let callbacks, stream, worker, workerUrl, timer, running=false, busy=false, stopped=false;
  let trackFrame, visible=-1, loaded=-1, requested=-1, lastSeen=0, lastCorners, lastSize;
  let candidate=-1, candidateCount=0, openingTimer=0;
  const planeSize=160;
  // Solve the rectangle-to-quadrilateral homography and pass it to the native
  // video layer. No decoding, texture upload, or per-video-frame JS rendering.
  function place(corners,w,h) {
    const scale=Math.max(innerWidth/w,innerHeight/h);
    const left=(innerWidth-w*scale)*.5, top=(innerHeight-h*scale)*.5;
    const q=corners.map(([x,y])=>[left+x*scale,top+y*scale]);
    const [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]=q;
    const dx1=x1-x2,dx2=x3-x2,dx3=x0-x1+x2-x3;
    const dy1=y1-y2,dy2=y3-y2,dy3=y0-y1+y2-y3;
    const determinant=dx1*dy2-dx2*dy1;
    if(!Number.isFinite(determinant)||Math.abs(determinant)<1e-5)return;
    const g=(dx3*dy2-dx2*dy3)/determinant, h1=(dx1*dy3-dx3*dy1)/determinant;
    const m=[(x1-x0+g*x1)/planeSize,(y1-y0+g*y1)/planeSize,0,g/planeSize,
      (x3-x0+h1*x3)/planeSize,(y3-y0+h1*y3)/planeSize,0,h1/planeSize,
      0,0,1,0,x0,y0,0,1];
    clip.style.transform="matrix3d("+m.join(",")+")";
  }

  function accept(result,w,h) {
    if(stopped)return;
    const now=performance.now();
    if(result){
      const same=result.index===visible;
      if(!same) {
        if(candidate===result.index)candidateCount++;else{candidate=result.index;candidateCount=1;}
        // Brief ambiguity while switching pages should not replace a stable image.
        if(visible>=0 && candidateCount<2) return;
        if(visible>=0){const old=visible;visible=-1;callbacks.lost(old);}
        visible=result.index; lastCorners=null;
      }
      lastSeen=now;candidate=-1;candidateCount=0;
      if(lastCorners && lastSize?.[0]===w && lastSize?.[1]===h){
        const motion=Math.max(...result.corners.map(([x,y],i)=>Math.hypot(x-lastCorners[i][0],y-lastCorners[i][1])));
        const mix=motion<3?.31:motion<17?.73:.96;
        lastCorners=result.corners.map(([x,y],i)=>[lastCorners[i][0]*(1-mix)+x*mix,lastCorners[i][1]*(1-mix)+y*mix]);
      }else lastCorners=result.corners;
      lastSize=[w,h];place(lastCorners,w,h);
      if(!same)callbacks.found(visible);
    }else{
      candidate=-1;candidateCount=0;
      if(visible>=0 && now-lastSeen>650) {
        const old=visible; visible=-1; lastCorners=null; callbacks.lost(old);
      }
    }
  }
  function schedule(delay) { clearTimeout(timer); if(!stopped)timer=setTimeout(scan,delay); }
  function result(data) {
    busy=false;
    if(stopped)return;
    if(data.failure){stopWithError(Error("Photo recognition failed"));return;}
    if(data.ready){callbacks.ready();schedule(0);return;}
    accept(data.match,data.w,data.h);
    // Known landmarks are inexpensive to follow. Descriptor search runs less
    // often and never uses the video's native presentation clock.
    schedule(data.match?54:130);
  }
  function scan() {
    if(stopped||busy)return;
    if(live.readyState<2||!live.videoWidth||!live.videoHeight){schedule(60);return;}
    const down=Math.min(1,440/Math.max(live.videoWidth,live.videoHeight));
    const w=Math.max(1,Math.round(live.videoWidth*down)), h=Math.max(1,Math.round(live.videoHeight*down));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    let rgba;
    try{ctx.drawImage(live,0,0,w,h);rgba=ctx.getImageData(0,0,w,h).data;}catch{schedule(200);return;}
    const gray=new Uint8Array(w*h);
    for(let i=0,k=0;i<gray.length;i++,k+=4)gray[i]=(77*rgba[k]+150*rgba[k+1]+29*rgba[k+2])>>>8;
    busy=true;
    if(worker)worker.postMessage({gray:gray.buffer,w,h},[gray.buffer]);
    else result({match:trackFrame(gray,w,h,performance.now()),w,h});
  }
  function workerMain(){
    const vision=albumPhotoVision(); let track;
    self.onmessage=({data})=>{
      try{
        if(data.models){const models=vision.unpack(data.models);if(models.length!==data.count)throw Error();track=vision.tracker(models);self.postMessage({ready:true});return;}
        const match=track(new Uint8Array(data.gray),data.w,data.h,performance.now());
        self.postMessage({match,w:data.w,h:data.h});
      }catch{self.postMessage({failure:true});}
    };
  }
  function configure(buffer,count){
    if(stopped)return;
    const raw=buffer instanceof ArrayBuffer?buffer: buffer?.buffer || buffer;
    if(!raw.byteLength)throw Error("Empty photo model");
    try{
      const text=albumPhotoVision.toString()+"\n("+workerMain.toString()+")()";
      workerUrl=URL.createObjectURL(new Blob([text],{type:"text/javascript"}));
      worker=new Worker(workerUrl);
      worker.onmessage=event=>result(event.data);
      worker.onerror=()=>stopWithError(Error("Recognition worker unavailable"));
    }catch{worker=null;}
    if(worker){
      // The buffer was decrypted in the parent realm. A structured clone + transfer
      // transfers its ownership directly to the local worker.
      worker.postMessage({models:raw,count},[raw]);
    }else{
      const engine=albumPhotoVision(),models=engine.unpack(raw);
      if(models.length!==count)throw Error("Photo count mismatch");
      trackFrame=engine.tracker(models);
      result({ready:true});
    }
  }
  function clearClip(){
    clearTimeout(openingTimer);openingTimer=0;
    requested=loaded=-1; clip.classList.remove("shown");clip.muted=true;clip.pause();
    if(clip.hasAttribute("src")){clip.removeAttribute("src");clip.load();}
  }
  function prepareClip(index){clearClip();if(stopped)throw Error("Camera stopped");loaded=index;return clip;}
  function playRequested(index){
    if(stopped||loaded!==index||visible!==index||requested!==index)return;
    clip.play().catch(e=>{if(e.name!=="AbortError" && !stopped && requested===index)callbacks.playError();});
  }
  function showReady(){
    // Seeking can leave the previous frame on the native compositor.
    if(stopped||loaded<0||loaded!==requested||visible!==loaded||clip.readyState<2||clip.seeking)return;
    if(clip.classList.contains("shown")){
      if(!openingTimer && clip.paused)playRequested(loaded);
      return;
    }
    // Safari can require play() to decode its first frame. Stop the clock before
    // revealing that frame, including when a busy main thread handled it late.
    clip.pause();
    if(clip.currentTime>.02){clip.currentTime=0;return;}
    clip.classList.add("shown");
    const index=loaded;
    openingTimer=setTimeout(()=>{
      openingTimer=0;playRequested(index);
    },matchMedia("(prefers-reduced-motion:reduce)").matches?16:120);
  }
  function showClip(index){
    if(stopped||index!==loaded||index!==visible)return;
    requested=index;
    if(clip.readyState<2){playRequested(index);return;}
    showReady();
  }
  function hideClip(index){
    if(requested!==index)return;
    clearTimeout(openingTimer);openingTimer=0;
    requested=-1;clip.classList.remove("shown");clip.muted=true;clip.pause();
    // This is only called for a confirmed loss, after the tracking grace period.
    // Reacquiring the same printed photo should animate its opening frame again.
    if(clip.readyState>=1 && clip.currentTime>0)clip.currentTime=0;
  }
  function setSound(index,enabled){
    if(index!==visible||index!==loaded||requested!==index)return false;
    clip.muted=!enabled;
    if(enabled && !openingTimer)clip.play().catch(()=>{if(!stopped&&requested===index)callbacks.playError();});
    return !clip.muted;
  }
  function stop(){
    if(stopped)return;stopped=true;
    clearTimeout(timer);
    worker?.terminate();worker=null;if(workerUrl)URL.revokeObjectURL(workerUrl);
    clearClip();for(const track of stream?.getTracks()||[])track.stop();live.pause();live.srcObject=null;
    stream=null;trackFrame=null;lastCorners=null;canvas.width=canvas.height=1;
  }
  function stopWithError(error){if(!stopped){stop();callbacks?.error(error);}}
  function start(streamPromise,featureBytesPromise,count,hooks){
    if(stopped||running||window.parent===window)return;
    running=true;callbacks=hooks;
    let firstPreview=false;
    function preview(){
      if(!stopped&&!firstPreview&&live.videoWidth){
        firstPreview=true;callbacks.preview?.();
      }
    }
    live.addEventListener("playing",preview,{once:true});
    const native=Promise.resolve(streamPromise).then(async next=>{
      if(stopped){for(const track of next.getTracks())track.stop();return;}
      stream=next;live.srcObject=stream;
      await live.play();
      if(live.requestVideoFrameCallback)live.requestVideoFrameCallback(preview);
      else preview();
    });
    Promise.all([native,Promise.resolve(featureBytesPromise)]).then(([,buffer])=>{
      if(!stopped)configure(buffer,count);
    }).catch(stopWithError);
  }
  for(const event of ["loadeddata","seeked","playing"])clip.addEventListener(event,showReady);
  window.addEventListener("resize",()=>{if(lastCorners&&lastSize)place(lastCorners,...lastSize);});
  window.addEventListener("pagehide",stop,{once:true});
  window.albumCamera=Object.freeze({start,prepareClip,showClip,hideClip,setSound,clearClip,stop});
})();
