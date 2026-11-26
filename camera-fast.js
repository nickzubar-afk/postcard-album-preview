(() => {
  "use strict";
  let scene, system, surface, texture, material, geometry, clip, callbacks;
  let stopped = false, loadedIndex = -1, expectedIndex = -1;
  const anchors = [];

  function clearClip() {
    expectedIndex = loadedIndex = -1;
    if (surface) { surface.visible = false; surface.removeFromParent(); }
    if (!clip) return;
    clip.muted = true;
    clip.pause();
    if (clip.hasAttribute("src")) { clip.removeAttribute("src"); clip.load(); }
  }

  function prepareClip(index) {
    clearClip();
    if (stopped) throw new Error("Camera stopped");
    loadedIndex = index;
    return clip;
  }

  function showClip(index) {
    if (stopped || loadedIndex !== index || !anchors[index]) return;
    expectedIndex = index;
    anchors[index].object3D.add(surface);
    if (clip.videoWidth && clip.videoHeight) {
      surface.scale.y = clip.videoHeight / clip.videoWidth;
      surface.visible = true;
    }
    clip.play().catch(() => { if (!stopped && expectedIndex === index) callbacks.playError(); });
  }

  function hideClip(index) {
    if (expectedIndex !== index) return;
    expectedIndex = -1;
    if (surface) surface.visible = false;
    if (clip) { clip.muted = true; clip.pause(); }
  }

  function setSound(index, enabled) {
    if (!clip || stopped || expectedIndex !== index || loadedIndex !== index) return false;
    clip.muted = !enabled;
    if (enabled) clip.play().catch(() => { if (!stopped && expectedIndex === index) callbacks.playError(); });
    return !clip.muted;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearClip();
    if (system) {
      // MindAR's stop expects a fully initialised controller. Permission may still be pending.
      try { system.controller?.stopProcessVideo(); } catch {}
      const stream = system.video?.srcObject;
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (system.video) { system.video.pause(); system.video.srcObject = null; }
      try { system.controller?.dispose(); } catch {}
    }
    scene?.pause();
    texture?.dispose(); material?.dispose(); geometry?.dispose();
    scene?.renderer?.dispose();
  }

  function start(targetUrl, count, incomingCallbacks) {
    if (stopped || scene || window.parent === window) return;
    callbacks = incomingCallbacks;
    if (!window.AFRAME || !window.MINDAR?.IMAGE) { callbacks.error(); return; }
    const THREE = window.AFRAME.THREE;
    const stage = document.getElementById("stage");
    clip = document.createElement("video");
    clip.muted = clip.defaultMuted = true; clip.loop = true; clip.playsInline = true;
    clip.setAttribute("playsinline", ""); clip.setAttribute("webkit-playsinline", "");
    clip.preload = "auto";
    // A real but visually hidden video element also allows WebKit inline texture playback.
    clip.hidden = true; stage.append(clip);
    clip.addEventListener("loadeddata", () => {
      if (stopped || expectedIndex < 0 || expectedIndex !== loadedIndex || !clip.videoWidth) return;
      surface.scale.y = clip.videoHeight / clip.videoWidth;
      surface.visible = true;
    });
    clip.addEventListener("error", () => { if (!stopped && loadedIndex >= 0) callbacks.playError(); });
    texture = new THREE.VideoTexture(clip);
    if ("colorSpace" in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    else if ("encoding" in texture && THREE.sRGBEncoding) texture.encoding = THREE.sRGBEncoding;
    geometry = new THREE.PlaneGeometry(1, 1);
    material = new THREE.MeshBasicMaterial({map:texture, side:THREE.DoubleSide, toneMapped:false});
    surface = new THREE.Mesh(geometry, material); surface.visible = false;

    scene = document.createElement("a-scene");
    for (const [name, value] of Object.entries({
      embedded:"", "mindar-image":"imageTargetSrc: " + targetUrl + "; autoStart: false; maxTrack: 1; uiLoading: no; uiScanning: no; uiError: no",
      renderer:"alpha: true; colorManagement: true", "vr-mode-ui":"enabled: false", "xr-mode-ui":"enabled: false",
      "device-orientation-permission-ui":"enabled: false", "loading-screen":"enabled: false"
    })) scene.setAttribute(name, value);
    const camera = document.createElement("a-camera");
    camera.setAttribute("position", "0 0 0");
    camera.setAttribute("look-controls", "enabled: false"); camera.setAttribute("wasd-controls", "enabled: false");
    scene.append(camera);
    for (let index = 0; index < count; index++) {
      const anchor = document.createElement("a-entity");
      anchor.dataset.pageIndex = String(index);
      anchor.setAttribute("mindar-image-target", "targetIndex: " + index);
      anchor.addEventListener("targetFound", () => { if (!stopped) callbacks.found(index); });
      anchor.addEventListener("targetLost", () => { if (!stopped) callbacks.lost(index); });
      anchors.push(anchor); scene.append(anchor);
    }
    scene.addEventListener("arReady", () => { if (!stopped) callbacks.ready(); });
    scene.addEventListener("arError", () => { if (!stopped) callbacks.error(); });
    scene.addEventListener("renderstart", () => {
      if (stopped) return;
      try {
        system = scene.systems["mindar-image-system"];
        callbacks.permission();
        system.start();
      } catch { callbacks.error(); }
    }, {once:true});
    stage.append(scene);
  }

  window.addEventListener("unhandledrejection", event => {
    if (callbacks && !stopped) { event.preventDefault(); callbacks.error(); }
  });
  window.addEventListener("pagehide", stop);
  window.albumCamera = Object.freeze({start, prepareClip, showClip, hideClip, setSound, clearClip, stop});
})();
