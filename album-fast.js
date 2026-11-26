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
  let session, player, scanner, activeIndex = 0;

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
      for (const [index,page] of current.pages.entries()) $("pages").add(new Option(page.title, String(index)));
      $("page-choice").hidden = current.pages.length < 2;
      $("actions").hidden = $("lock").hidden = false;
      if (!navigator.mediaDevices?.getUserMedia) {
        $("camera-hint").hidden = false;
        $("camera-hint").textContent = "В этом браузере камера недоступна. Ролик можно посмотреть без неё.";
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

  async function trackingUrl(scan, current) {
    if (typeof DecompressionStream === "function") {
      try {
        const packed = await decrypt(current.scope, current.id, "target-gzip", current.key,
          scan.abort.signal, "tracking-" + current.id + ".bin");
        const plain = new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"));
        const url = URL.createObjectURL(await new Response(plain).blob());
        if (scan.abort.signal.aborted) { URL.revokeObjectURL(url); throw Error(); }
        scan.urls.add(url);
        return url;
      } catch (error) { if (scan.abort.signal.aborted) throw error; }
    }
    return mediaUrl(scan, current.scope, current.id, "target", current.key, "application/octet-stream");
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

  function clearMedia(element) {
    element.pause();
    if (element.hasAttribute("src")) { element.removeAttribute("src"); element.load(); }
  }

  function clearPlayer() {
    release(player); player = null;
    clearMedia($("film")); clearMedia($("voice"));
    $("film").muted = true;
    $("film-sound").hidden = $("audio-only").hidden = true;
    $("voice").hidden = true; $("load-voice").hidden = false; $("load-voice").disabled = false;
    $("media").hidden = true;
  }

  function closePlayer() {
    clearPlayer(); $("player").hidden = true; $("page-title").textContent = "";
    $("player-status").textContent = "";
  }

  async function showPlayer(index) {
    if (!session?.pages[index]) return;
    closeScanner();
    clearPlayer();
    const slot = player = mediaSlot();
    const page = session.pages[index];
    activeIndex = index;
    $("pages").value = String(index);
    $("page-title").textContent = page.title;
    $("player").hidden = false;
    $("player-status").textContent = "Открываю ролик…";
    try {
      const info = await pageInfo(page, slot.abort.signal);
      if (player !== slot) return;
      slot.voicePage = page;
      const film = $("film");
      film.addEventListener("loadeddata", () => {
        if (player === slot) $("player-status").textContent = "";
      }, {once:true,signal:slot.abort.signal});
      attachVideo(slot, page, film, info, resume => {
        if (player !== slot) return;
        $("film-sound").hidden = $("audio-only").hidden = !info.audioType;
        $("film-sound").textContent = film.muted ? "Включить звук" : "Выключить звук";
        $("media").hidden = false;
        if (resume && !document.hidden && $("voice").paused) film.play().catch(() => {});
      }, () => {
        if (player === slot) $("player-status").textContent = "Не удалось загрузить ролик. Открой его ещё раз.";
      });
    } catch {
      if (player !== slot) return;
      clearPlayer();
      $("player-status").textContent = "Не удалось открыть записи. Проверь подключение и нажми «Посмотреть без камеры» ещё раз.";
    }
  }

  async function playAudioOnly() {
    const slot = player;
    const page = slot?.voicePage;
    if (!page?.info.audioType) return;
    $("load-voice").disabled = true;
    $("film").pause();
    const voice = $("voice");
    try {
      const url = await mediaUrl(slot, "p", page.id, "audio", page.key, page.info.audioType);
      if (player !== slot) return;
      voice.src = url; voice.hidden = false; $("load-voice").hidden = true;
      voice.play().catch(() => {});
    } catch {
      if (player === slot) {
        $("load-voice").disabled = false;
        $("player-status").textContent = "Не удалось открыть звук. Попробуй ещё раз.";
      }
    }
  }

  function showPlayerAndScroll(index) {
    showPlayer(index);
    if (!$("player").hidden) $("player").scrollIntoView({block:"start"});
  }

  function scanStatus(text) { $("scan-status").textContent = text; }
  function detachPage(scan) {
    scan.hasSound = scan.soundEnabled = false;
    release(scan.pageMedia); scan.pageMedia = null; scan.loadedIndex = -1;
    scan.frame?.contentWindow?.albumCamera?.clearClip();
    $("scan-voice").hidden = true;
  }

  function closeScanner() {
    if (!scanner) return;
    const closing = scanner;
    scanner = null;
    detachPage(closing);
    clearTimeout(closing.timer);
    closing.frame?.contentWindow?.albumCamera?.stop();
    closing.frame?.remove();
    release(closing);
    $("scanner").hidden = true;
    $("main").inert = false;
    $("camera").focus({preventScroll:true});
  }

  function scanFailure(scan) {
    if (scanner !== scan) return;
    scan.failed = true;
    clearTimeout(scan.timer);
    detachPage(scan);
    scan.frame?.contentWindow?.albumCamera?.stop();
    scanStatus("Не удалось запустить распознавание. Проверь доступ к камере в браузере или открой ролик без неё.");
  }

  async function scanFound(scan, index) {
    if (scanner !== scan || scan.failed || !session?.pages[index]) return;
    activeIndex = index;
    scan.visible = index;
    const page = session.pages[index];
    const camera = scan.frame.contentWindow.albumCamera;
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
        if (scanner === scan && scan.visible === index && scan.pageMedia === slot)
          scanStatus("В кадре — «" + page.title + "».");
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
          scanStatus("Не удалось открыть запись. Открой ролик в плеере без камеры.");
      });
    } catch {
      if (scanner !== scan || scan.pageMedia !== slot) return;
      if (!scan.clipReady) { detachPage(scan); }
      scanStatus("Не удалось открыть запись. Проверь подключение или открой плеер без камеры.");
    }
  }

  function scanLost(scan, index) {
    if (scanner !== scan || scan.failed || scan.visible !== index) return;
    scan.visible = -1;
    scan.soundEnabled = false;
    $("scan-voice").textContent = "Включить звук";
    scan.frame?.contentWindow?.albumCamera?.hideClip(index);
    $("scan-voice").hidden = true;
    scanStatus("Верни фотографию в кадр.");
  }

  async function showScanner() {
    if (!session || scanner) return;
    closePlayer();
    const scan = scanner = Object.assign(mediaSlot(), {hasSound:false, soundEnabled:false, loadedIndex:-1, visible:-1});
    $("scanner").hidden = false; $("main").inert = true; $("exit-camera").focus();
    $("scan-voice").hidden = true;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { scanFailure(scan); return; }
    scanStatus("Подготавливаю камеру…");
    scan.timer = setTimeout(() => {
      if (scanner === scan && !scan.failed) scanStatus("Подготовка затянулась. Проверь разрешение камеры или открой ролик без неё.");
    }, 22000);
    try {
      const current = session;
      const frame = scan.frame = document.createElement("iframe");
      frame.id = "camera-frame"; frame.title = "Камера фотографии"; frame.allow = "camera 'self'";
      const frameReady = new Promise((resolve, reject) => {
        frame.addEventListener("load", resolve, {once:true,signal:scan.abort.signal});
        frame.addEventListener("error", reject, {once:true,signal:scan.abort.signal});
        scan.abort.signal.addEventListener("abort", reject, {once:true});
      });
      frame.src = "camera-fast.html";
      $("frame").append(frame);
      const [targetUrl] = await Promise.all([trackingUrl(scan, current), frameReady]);
      if (scanner !== scan) return;
      frame.contentWindow.albumCamera.start(targetUrl, current.pages.length, {
            permission:() => { if (scanner === scan) scanStatus("Разреши браузеру доступ к камере."); },
            ready:() => {
              if (scanner !== scan || scan.failed) return;
              clearTimeout(scan.timer); scanStatus(session.scope === "a" ? "Наведи камеру на любую фотографию альбома." : "Наведи камеру на фотографию.");
            },
            error:() => scanFailure(scan),
            playError:() => { if (scanner === scan) scanStatus("Фотография найдена. Ролик можно запустить в плеере без камеры."); },
            found:index => scanFound(scan, index),
            lost:index => scanLost(scan, index)
      });
    } catch { scanFailure(scan); }
  }

  function closeSession() {
    closeScanner(); closePlayer();
    session?.abort.abort(); session = null; incoming = ""; activeIndex = 0;
    $("title").textContent = "Альбом закрыт";
    $("intro-text").textContent = "Чтобы открыть воспоминание, отсканируй QR-код на фотографии или открой личную ссылку.";
    $("actions").hidden = $("lock").hidden = $("camera-hint").hidden = true;
    $("pages").replaceChildren();
    $("page-choice").hidden = true; $("scan-status").textContent = "";
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("camera").addEventListener("click", showScanner);
    $("exit-camera").addEventListener("click", closeScanner);
    $("manual").addEventListener("click", () => showPlayerAndScroll(activeIndex));
    $("scan-fallback").addEventListener("click", () => showPlayerAndScroll(activeIndex));
    $("close-player").addEventListener("click", () => { closePlayer(); $("manual").focus(); });
    $("pages").addEventListener("change", () => showPlayer(Number($("pages").value)));
    $("lock").addEventListener("click", closeSession);
    $("scan-voice").addEventListener("click", () => {
      const scan = scanner;
      if (!scan?.hasSound || scan.visible < 0) return;
      scan.soundEnabled = scan.frame.contentWindow.albumCamera.setSound(scan.visible, !scan.soundEnabled);
      $("scan-voice").textContent = scan.soundEnabled ? "Выключить звук" : "Включить звук";
    });
    $("load-voice").addEventListener("click", playAudioOnly);
    $("film-sound").addEventListener("click", () => {
      const film = $("film");
      film.muted = !film.muted;
      if (!film.muted) film.play().catch(() => { if (player) $("player-status").textContent = "Нажми кнопку воспроизведения на ролике."; });
    });
    $("film").addEventListener("volumechange", () => {
      $("film-sound").textContent = $("film").muted ? "Включить звук" : "Выключить звук";
    });
    $("voice").addEventListener("play", () => $("film").pause());
    $("film").addEventListener("play", () => $("voice").pause());
    for (const id of ["film", "voice"]) $(id).addEventListener("error", () => {
      if (player && $(id).hasAttribute("src")) $("player-status").textContent = "Браузеру не удалось воспроизвести запись. Попробуй открыть исходную ссылку в Safari или Chrome.";
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
      if (document.hidden) { closeScanner(); $("film").pause(); $("voice").pause(); }
    });
    window.addEventListener("keydown", event => { if (event.key === "Escape" && scanner) closeScanner(); });
    openSession();
  }, {once:true});
})();
