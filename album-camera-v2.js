(() => {
  "use strict";

  // Remove the capability before any other application resource is requested.
  let incoming = location.hash.slice(1);
  if (location.hash) {
    try { history.replaceState(null, "", location.pathname + location.search); }
    catch { incoming = ""; location.replace(location.pathname + location.search); return; }
  }
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "album.css";
  document.head.append(css);
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.href = "data:,";
  document.head.append(icon);

  const idPattern = /^[a-f0-9]{32}$/;
  const keyPattern = /^[A-Za-z0-9_-]{43}$/;
  const decodeText = new TextDecoder("utf-8", {fatal: true});
  const encodeText = new TextEncoder();
  const $ = id => document.getElementById(id);
  let session, scanner;

  function parseLink() {
    const fields = incoming.split("/");
    incoming = "";
    if (fields.length !== 3 || !["p", "a"].includes(fields[0]) ||
        !idPattern.test(fields[1]) || !keyPattern.test(fields[2])) throw Error();
    return {scope: fields[0], id: fields[1], key: fields[2]};
  }

  async function readKey(value) {
    if (!keyPattern.test(value)) throw Error();
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const raw = atob(base64);
    if (raw.length !== 32 || btoa(raw) !== base64) throw Error();
    const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
    try { return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["decrypt"]); }
    finally { bytes.fill(0); }
  }

  async function decrypt(scope, id, kind, key, signal, path = "data/" + id + "/" + kind + ".bin") {
    const response = await fetch(path, {signal, credentials:"omit", cache:"default", redirect:"error", referrerPolicy:"no-referrer"});
    if (!response.ok) throw Error();
    const packed = new Uint8Array(await response.arrayBuffer());
    if (packed.length < 28) throw Error();
    const aad = encodeText.encode(["album-lock/v1",scope,id,kind].join("/"));
    const clear = await crypto.subtle.decrypt({name:"AES-GCM", iv:packed.subarray(0,12), additionalData:aad, tagLength:128}, key, packed.subarray(12));
    signal.throwIfAborted?.();
    if (signal.aborted) throw Error();
    return clear;
  }

  async function manifest(scope, id, key, signal) {
    const raw = new Uint8Array(await decrypt(scope, id, "manifest", key, signal));
    let data;
    try { data = JSON.parse(decodeText.decode(raw)); }
    finally { raw.fill(0); }
    if (data?.version !== 1 || data.scope !== scope || data.id !== id ||
        typeof data.title !== "string" || !data.title.trim()) throw Error();
    return data;
  }

  function checkPage(data) {
    if (!/^video\/(mp4|webm|quicktime|ogg)$/.test(data.videoType) ||
        (data.audioType != null && !/^audio\/(mp4|mpeg|aac|ogg|webm|wav|x-wav|flac|x-m4a)$/.test(data.audioType))) throw Error();
    return data;
  }

  async function openSession() {
    if (!incoming) return;
    let current;
    try {
      const link = parseLink();
      if (!window.isSecureContext || !crypto.subtle) {
        $("intro-text").textContent = "Для открытия защищённой ссылки нужен браузер с HTTPS. Открой ссылку из QR-кода в Safari или Chrome.";
        return;
      }
      current = {scope:link.scope, id:link.id, abort:new AbortController(), pages:[]};
      session = current;
      $("intro-text").textContent = "Открываю ссылку…";
      current.key = await readKey(link.key);
      link.key = "";
      const info = await manifest(current.scope, current.id, current.key, current.abort.signal);
      if (current.scope === "p") {
        current.pages = [{id:current.id, title:info.title, key:current.key, info:checkPage(info)}];
      } else {
        if (!Array.isArray(info.pages) || !info.pages.length) throw Error();
        const seen = new Set();
        for (const page of info.pages) {
          if (!idPattern.test(page.id) || seen.has(page.id) || !keyPattern.test(page.key) ||
              typeof page.title !== "string" || !page.title.trim()) throw Error();
          seen.add(page.id);
          current.pages.push({id:page.id, title:page.title, encodedKey:page.key});
        }
      }
      if (session !== current) return;
      const album = current.scope === "a";
      $("title").textContent = info.title;
      $("intro-text").textContent = album ? "Наведи камеру на любую из фотографий альбома, чтобы увидеть её ролик." :
        "Наведи камеру на фотографию, чтобы увидеть её ролик.";
      $("lock").hidden = false;
      $("actions").hidden = false;
      if (!navigator.mediaDevices?.getUserMedia) {
        $("camera-hint").hidden = false;
        $("camera-hint").textContent = "Открой ссылку из QR-кода в браузере с доступом к камере.";
        $("actions").hidden = true;
      } else {
        warmCamera(current);
        features(current).catch(() => {});
      }
    } catch {
      if (current && current !== session) return;
      closeSession();
      $("title").textContent = "Ссылка не открылась";
      $("intro-text").textContent = "Проверь подключение к интернету и открой исходную ссылку целиком или заново отсканируй QR-код.";
    }
  }

  async function pageInfo(page, signal) {
    if (page.info) return page.info;
    if (!page.key) {
      // A second selection can start while the first key is being imported.
      page.pendingKey ||= readKey(page.encodedKey);
      page.key = await page.pendingKey;
      page.encodedKey = "";
    }
    const info = checkPage(await manifest("p", page.id, page.key, signal));
    page.info = info;
    return info;
  }

  function mediaSlot() { return {abort:new AbortController(), urls:new Set()}; }
  function release(slot) {
    if (!slot) return;
    slot.abort.abort();
    for (const url of slot.urls) URL.revokeObjectURL(url);
    slot.urls.clear();
  }

  async function mediaUrl(slot, scope, id, kind, key, mime, path) {
    const raw = new Uint8Array(await decrypt(scope, id, kind, key, slot.abort.signal, path));
    try {
      if (slot.abort.signal.aborted) throw Error();
      const url = URL.createObjectURL(new Blob([raw], {type:mime}));
      slot.urls.add(url);
      return url;
    } finally { raw.fill(0); }
  }

  function attachVideo(slot, page, element, info, ready, failed) {
    const signal = slot.abort.signal;
    const originalLoop = element.loop;
    let fallbackStarted = false;
    signal.addEventListener("abort", () => { element.loop = originalLoop; }, {once:true});
    async function fallback() {
      if (signal.aborted || fallbackStarted) return;
      fallbackStarted = true;
      const start = element.currentTime || 0;
      const resumeOriginal = !element.paused || start < 0.1;
      let preview = false;
      if (start < 0.1) {
        try {
          const url = await mediaUrl(slot,"p",page.id,"preview",page.key,"video/mp4","preview-" + page.id + ".bin");
          if (signal.aborted) return;
          element.loop = false;
          element.src = url;
          preview = true;
          ready(true);
        } catch { if (signal.aborted) return; }
      }
      try {
        const url = await mediaUrl(slot, "p", page.id, "video", page.key, info.videoType);
        if (signal.aborted) return;
        const position = Math.max(start, element.currentTime || 0);
        const resume = preview ? !element.paused || element.ended || Boolean(element.error) : resumeOriginal;
        element.loop = originalLoop;
        if (position > 0) element.addEventListener("loadedmetadata", () => {
          if (!signal.aborted) element.currentTime = Math.min(position, element.duration || position);
        }, {once:true,signal});
        element.src = url;
        ready(resume);
      } catch { if (!signal.aborted) failed(); }
    }
    try {
      if (window.albumStream?.attach(element, {id:page.id, key:page.key, signal, onError:fallback})) {
        ready(true);
        return;
      }
    } catch { /* A browser may expose MediaSource but reject its construction. */ }
    fallback();
  }

  function scanStatus(text) { $("scan-status").textContent = text; }
  function detachPage(scan) {
    scan.hasSound = scan.soundEnabled = false;
    release(scan.pageMedia); scan.pageMedia = null; scan.loadedIndex = -1;
    scan.frame?.contentWindow?.albumCamera?.clearClip();
    $("scan-voice").hidden = $("scan-play").hidden = true;
  }

  function showRetry(message) {
    scanStatus(message);
    $("scan-retry").hidden = false;
  }

  function stopTracks(stream) {
    if (stream) for (const track of stream.getTracks()) track.stop();
  }

  function closeScanner(prepareNext = true) {
    if (!scanner) return;
    const closing = scanner;
    scanner = null;
    clearTimeout(closing.timer);
    detachPage(closing);
    closing.camera?.stop();
    stopTracks(closing.stream);
    release(closing);
    closing.frame?.remove();
    $("scanner").hidden = true;
    $("main").inert = false;
    $("camera").focus({preventScroll:true});
    if (session && prepareNext) warmCamera(session);
  }

  function scanFailure(scan, error) {
    if (scanner !== scan || scan.failed) return;
    scan.failed = true;
    clearTimeout(scan.timer);
    detachPage(scan);
    scan.camera?.stop();
    stopTracks(scan.stream);
    release(scan);
    $("scan-play").hidden = true;
    let message = "Не удалось подготовить распознавание. Проверь подключение и попробуй ещё раз.";
    if (["NotAllowedError","SecurityError"].includes(error?.name))
      message = "Разреши доступ к камере в настройках этого сайта и попробуй ещё раз.";
    if (["NotFoundError","NotReadableError","OverconstrainedError"].includes(error?.name))
      message = "Не удалось включить камеру. Проверь, доступна ли она, и попробуй ещё раз.";
    showRetry(message);
  }

  function features(current) {
    if (!current.featureData) {
      current.featureData = decrypt(current.scope, current.id, "features-v2", current.key,
        current.abort.signal, "features-v2-" + current.id + ".bin").catch(error => {
          current.featureData = null;
          throw error;
        });
    }
    return current.featureData;
  }

  function warmCamera(current) {
    if (current.shell || current.abort.signal.aborted) return;
    const frame = document.createElement("iframe");
    frame.id = "camera-frame";
    frame.title = "Камера фотографии";
    frame.allow = "camera 'self'";
    const ready = new Promise((resolve,reject) => {
      function finish(error) {
        current.abort.signal.removeEventListener("abort",cancel);
        if (error) reject(error);
        else resolve(frame.contentWindow.albumCamera);
      }
      function cancel() { finish(new Error("Camera closed")); }
      frame.addEventListener("load", () => {
        finish(frame.contentWindow?.albumCamera ? null : new Error("Camera unavailable"));
      }, {once:true});
      frame.addEventListener("error", cancel, {once:true});
      current.abort.signal.addEventListener("abort", cancel, {once:true});
    });
    ready.catch(() => {});
    current.shell = {frame,ready};
    frame.src = "camera-lite.html";
    $("frame").append(frame);
  }

  async function scanFound(scan, index) {
    if (scanner !== scan || scan.failed || !session?.pages[index]) return;
    scan.visible = index;
    const page = session.pages[index];
    const camera = scan.camera;
    if (scan.loadedIndex === index) {
      if (scan.clipReady) {
        camera.showClip(index);
        scanStatus("В кадре — «" + page.title + "».");
        $("scan-voice").hidden = !scan.hasSound;
      }
      return;
    }
    detachPage(scan);
    const slot = scan.pageMedia = mediaSlot();
    scan.loadedIndex = index;
    scan.clipReady = false;
    scanStatus("Открываю «" + page.title + "»…");
    try {
      const info = await pageInfo(page, slot.abort.signal);
      if (scanner !== scan || scan.pageMedia !== slot) return;
      const element = camera.prepareClip(index);
      element.addEventListener("playing", () => {
        if (scanner === scan && scan.visible === index && scan.pageMedia === slot) {
          $("scan-play").hidden = true;
          scanStatus("В кадре — «" + page.title + "».");
        }
      }, {signal:slot.abort.signal});
      attachVideo(slot, page, element, info, () => {
        if (scanner !== scan || scan.pageMedia !== slot) return;
        scan.clipReady = true;
        if (scan.visible === index) camera.showClip(index);
        scan.hasSound = Boolean(info.audioType);
        $("scan-voice").textContent = scan.soundEnabled ? "Выключить звук" : "Включить звук";
        $("scan-voice").hidden = !scan.hasSound || scan.visible !== index;
      }, () => {
        if (scanner === scan && scan.pageMedia === slot)
          showRetry("Не удалось загрузить ролик. Проверь подключение и попробуй ещё раз.");
      });
    } catch {
      if (scanner !== scan || scan.pageMedia !== slot) return;
      if (!scan.clipReady) { detachPage(scan); }
      showRetry("Не удалось открыть ролик. Проверь подключение и попробуй ещё раз.");
    }
  }

  function scanLost(scan, index) {
    if (scanner !== scan || scan.failed || scan.visible !== index) return;
    scan.visible = -1;
    $("scan-play").hidden = true;
    scan.soundEnabled = false;
    $("scan-voice").textContent = "Включить звук";
    scan.frame?.contentWindow?.albumCamera?.hideClip(index);
    $("scan-voice").hidden = true;
    scanStatus("Верни фотографию в кадр.");
  }

  async function showScanner() {
    if (!session || scanner) return;
    const current = session;
    const scan = scanner = Object.assign(mediaSlot(), {loadedIndex:-1, visible:-1});
    $("scanner").hidden = false;
    $("main").inert = true;
    $("scan-play").hidden = $("scan-retry").hidden = $("scan-voice").hidden = true;
    $("exit-camera").focus();
    scanStatus("Открываю камеру…");
    try {
      const cameraAccess = navigator.mediaDevices.getUserMedia({
        audio:false, video:{facingMode:{ideal:"environment"},width:{ideal:640},height:{ideal:480},frameRate:{ideal:24,max:30}}
      }).then(stream => {
        if (scan.abort.signal.aborted) { stopTracks(stream); throw new Error("Camera closed"); }
        scan.stream = stream;
        return stream;
      });
      cameraAccess.catch(error => scanFailure(scan,error));
      warmCamera(current);
      const shell = current.shell;
      current.shell = null;
      scan.frame = shell.frame;
      // Each scan transfers its own copy to the recognition worker. Keep the
      // authenticated template available for reopening the camera in this tab.
      const data = features(current).then(buffer => buffer.slice(0));
      data.catch(() => {});
      scan.timer = setTimeout(() => {
        if (scanner === scan && !scan.failed && !scan.stream)
          scanStatus("Если браузер запросил доступ к камере, нажми «Разрешить».");
      }, 2500);
      const camera = await shell.ready;
      if (scanner !== scan || scan.failed) return;
      scan.camera = camera;
      await camera.start(cameraAccess, data, current.pages.length, {
        permission:() => {},
        preview:() => { if (scanner === scan && !scan.failed && !scan.listening)
          scanStatus("Наведи камеру на фотографию."); },
        ready:() => {
          if (scanner !== scan || scan.failed) return;
          clearTimeout(scan.timer);
          scan.listening = true;
          if (scan.visible < 0) scanStatus("Наведи камеру на одну фотографию так, чтобы были видны её края.");
        },
        error:error => scanFailure(scan,error),
        playError:() => {
          if (scanner === scan && scan.visible >= 0 && !scan.failed) {
            $("scan-play").hidden = false;
            scanStatus("Фотография найдена.");
          }
        },
        found:index => scanFound(scan,index),
        lost:index => scanLost(scan,index)
      });
    } catch (error) { scanFailure(scan,error); }
  }

  function closeSession() {
    closeScanner(false);
    session?.abort.abort();
    session?.shell?.frame.remove();
    session = null;
    incoming = "";
    $("title").textContent = "Альбом закрыт";
    $("intro-text").textContent = "Чтобы открыть воспоминание, отсканируй QR-код альбома.";
    $("actions").hidden = $("lock").hidden = $("camera-hint").hidden = true;
    $("scan-status").textContent = "";
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("camera").addEventListener("click", showScanner);
    $("exit-camera").addEventListener("click", () => closeScanner());
    $("scan-retry").addEventListener("click", () => { closeScanner(false); showScanner(); });
    $("scan-play").addEventListener("click", () => {
      if (scanner && scanner.visible >= 0) scanner.camera?.showClip(scanner.visible);
    });
    $("lock").addEventListener("click", closeSession);
    $("scan-voice").addEventListener("click", () => {
      const scan = scanner;
      if (!scan?.hasSound || scan.visible < 0) return;
      scan.soundEnabled = scan.camera.setSound(scan.visible,!scan.soundEnabled);
      $("scan-voice").textContent = scan.soundEnabled ? "Выключить звук" : "Включить звук";
    });
    window.addEventListener("hashchange", () => {
      const next = location.hash.slice(1);
      if (!next) return;
      try { history.replaceState(null, "", location.pathname + location.search); }
      catch { location.replace(location.pathname + location.search); return; }
      closeSession(); incoming = next; openSession();
    });
    window.addEventListener("pagehide", closeSession);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) closeScanner();
    });
    window.addEventListener("keydown", event => { if (event.key === "Escape" && scanner) closeScanner(); });
    openSession();
  }, {once:true});
})();
