(() => {
  "use strict";
  const HEADER = 4096;
  const PREFIX = 192 * 1024;
  const MAX_SIZE = 256 * 1024 * 1024;
  const encoder = new TextEncoder();

  // Read just enough of a response to authenticate the requested record. Some
  // proxies return HTTP 200 to a Range request: keep that one sequential reader.
  function byteWindow(response, start, limit) {
    let bytes = new Uint8Array(Math.min(limit, PREFIX));
    let used = 0;
    const reader = response.body?.getReader();
    return async function read(offset, count) {
      const end = offset + count - start;
      if (offset < start || end > limit) throw Error("Invalid stream range");
      while (used < end) {
        const next = reader ? await reader.read() : {value:new Uint8Array(await response.arrayBuffer())};
        if (next.done || !next.value?.length || used + next.value.length > limit) throw Error("Invalid stream response");
        const size = used + next.value.length;
        if (bytes.length < size) {
          const expanded = new Uint8Array(Math.min(limit, Math.max(bytes.length * 2, size)));
          expanded.set(bytes); bytes = expanded;
        }
        bytes.set(next.value, used); used = size;
      }
      return bytes.subarray(offset - start, end);
    };
  }

  function openFile(id, signal) {
    const path = new URL("stream-" + id + ".bin", location.href);
    let prefix, full, total;
    async function request(start, last) {
      const response = await fetch(path, {
        headers:{Range:"bytes=" + start + "-" + last}, signal, credentials:"omit",
        redirect:"error", referrerPolicy:"no-referrer", cache:"default"
      });
      if (response.status === 200) {
        const length = Number(response.headers.get("content-length"));
        const limit = length > 0 && !response.headers.has("content-encoding") ? length : MAX_SIZE;
        if (limit > MAX_SIZE || limit < HEADER) throw Error("Invalid stream size");
        full = byteWindow(response, 0, limit);
        return {end:limit, read:full};
      }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get("content-range") || "");
      if (response.status !== 206 || !range) throw Error("Stream unavailable");
      const begin = Number(range[1]), end = Number(range[2]) + 1, size = Number(range[3]);
      if (begin !== start || end !== Math.min(last + 1, size) || end <= start ||
          !Number.isSafeInteger(size) || size > MAX_SIZE || (total && size !== total)) throw Error("Invalid stream range");
      total = size;
      return {end, read:byteWindow(response, start, end - start)};
    }
    return async function read(start, count) {
      if (!prefix) prefix = await request(0, PREFIX - 1);
      if (full) return full(start, count);
      let initial;
      if (start < prefix.end) {
        const size = Math.min(count, prefix.end - start);
        initial = await prefix.read(start, size);
        if (size === count) return initial;
      }
      const rest = start + (initial?.length || 0);
      const record = await request(rest, start + count - 1);
      if (full) return full(start, count);
      const tail = await record.read(rest, start + count - rest);
      if (!initial) return tail;
      const complete = new Uint8Array(count);
      complete.set(initial); complete.set(tail, initial.length);
      return complete;
    };
  }

  function validate(info) {
    if (info?.v !== 1 || typeof info.mime !== "string" ||
        !/^video\/mp4;\s*codecs="avc1\.[\da-f]{6},\s*mp4a\.40\.2"$/i.test(info.mime) ||
        !Number.isFinite(info.duration) || info.duration <= 0 ||
        !Array.isArray(info.chunks) || info.chunks.length < 2) throw Error("Invalid stream index");
    let offset = HEADER, prev = -1;
    for (const [index, part] of info.chunks.entries()) {
      if (!Array.isArray(part) || part.length !== 3) throw Error("Invalid stream record");
      const [from, count, time] = part;
      if (from !== offset || !Number.isSafeInteger(count) || count <= 28 ||
          !Number.isFinite(time) || time < 0 || time >= info.duration ||
          (index <= 1 ? time !== 0 : time <= prev)) throw Error("Invalid stream record");
      offset += count; prev = time;
      if (offset > MAX_SIZE) throw Error("Stream too large");
    }
    return info;
  }

  // Resolve after updateend (rather than appendBuffer returning), and tear down
  // listeners if the user switches photographs while a buffer operation is pending.
  function eventAfter(target, name, signal, action) {
    return new Promise((resolve,reject) => {
      function clean() {
        target.removeEventListener(name, done); target.removeEventListener("error", fail);
        signal.removeEventListener("abort", fail);
      }
      function done() { clean(); resolve(); }
      function fail() { clean(); reject(Error("Stream operation interrupted")); }
      if (signal.aborted) return fail();
      target.addEventListener(name, done); target.addEventListener("error", fail);
      signal.addEventListener("abort", fail, {once:true});
      try { action(); } catch (error) { clean(); reject(error); }
    });
  }

  function openRecords(id, key, signal) {
    const read = openFile(id, signal);
    return async (index, start, length) => {
      const packed = await read(start, length);
      return new Uint8Array(await crypto.subtle.decrypt({
        name:"AES-GCM", iv:packed.subarray(0,12),
        additionalData:encoder.encode("album-fast/v1/" + id + "/" + index), tagLength:128
      }, key, packed.subarray(12)));
    };
  }

  async function readIndex(decrypt) {
    const raw = await decrypt("header",0,HEADER);
    try { return validate(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw))); }
    finally { raw.fill(0); }
  }

  function attach(video, {id, key, signal, onError}) {
    const realm = video.ownerDocument.defaultView;
    const Type = realm.MediaSource || realm.ManagedMediaSource;
    if (!Type || !Type.isTypeSupported || signal.aborted || !/^[0-9a-f]{32}$/.test(id)) return false;
    const source = new Type();
    const url = realm.URL.createObjectURL(source);
    const controller = new AbortController(), life = controller.signal;
    const decrypt = openRecords(id,key,life);
    let buffer, info, cursor = 1, generation = 0, busy = false, initialized = false;
    let quotaRetried = false, timer, frameTimer, playTimer;

    function stop() {
      if (life.aborted) return;
      clearTimeout(timer); clearTimeout(frameTimer); clearTimeout(playTimer);
      controller.abort();
      signal.removeEventListener("abort", stop);
      realm.URL.revokeObjectURL(url);
    }
    function fail(error) {
      if (life.aborted) return;
      stop();
      // The owner can still read currentTime/paused/muted before replacing src.
      onError(error);
    }
    function watchdog() {
      clearTimeout(timer);
      timer = setTimeout(() => fail(Error("Stream timed out")), 30000);
    }
    function clearFrameTimer() { clearTimeout(frameTimer); frameTimer = undefined; }
    function expectFrame() {
      if (frameTimer !== undefined || life.aborted) return;
      frameTimer = setTimeout(() => {
        clearFrameTimer();
        if (video.readyState < 2 || video.seeking) fail(Error("Video frame timed out"));
      }, 10000);
    }
    function clearPlayTimer() { clearTimeout(playTimer); playTimer = undefined; }
    function expectPlayback() {
      if (life.aborted || video.paused || playTimer !== undefined) return;
      const position = video.currentTime;
      playTimer = setTimeout(() => {
        clearPlayTimer();
        if (!video.paused && !video.ended && Math.abs(position - video.currentTime) < 0.05) {
          fail(Error("Stream playback stalled"));
        }
      }, 10000);
    }
    function update(fn) { return eventAfter(buffer,"updateend",life,fn); }
    function append(data) { return update(() => buffer.appendBuffer(data)); }
    function segmentAt(t) {
      let i = 1;
      while (i + 1 < info.chunks.length && info.chunks[i+1][2] <= t) i++;
      return i;
    }
    function bufferedAt(t) {
      for (let i=0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= t + 0.08 && video.buffered.end(i) > t + 0.03) return video.buffered.end(i);
      }
      return t;
    }
    function seek() {
      if (!initialized || life.aborted) return;
      if (video.seeking) expectFrame();
      const now = video.currentTime;
      if (!Number.isFinite(now)) return;
      const end = bufferedAt(now);
      cursor = Math.min(info.chunks.length, segmentAt(now));
      while (cursor < info.chunks.length && end > now &&
             (info.chunks[cursor+1]?.[2] ?? info.duration) <= end + 0.09) cursor++;
      generation++; pump();
    }
    function wake() {
      if (!initialized || life.aborted) return;
      // ManagedSourceBuffer may evict data even when JavaScript is paused.
      const t = video.currentTime;
      if (!busy && bufferedAt(t) === t && cursor > segmentAt(t) && !video.ended &&
          t < info.duration - 0.1) { seek(); return; }
      pump();
    }
    async function pump() {
      if (!initialized || busy || life.aborted) return;
      busy = true;
      try {
        while (!life.aborted && cursor < info.chunks.length) {
          const index = cursor;
          const [offset, count, start] = info.chunks[index];
          const time = video.currentTime;
          const horizon = video.paused ? 0.3 : 16;
          if (start > time + horizon) break;
          // Safari asks for data in bursts. Always fill a short runway on a new seek.
          if (source.streaming === false && bufferedAt(time) > time + 5) break;
          const g = generation;
          watchdog();
          const clear = await decrypt(index,offset,count);
          try {
            if (life.aborted) return;
            if (g !== generation) continue;
            await append(clear);
          } catch (err) {
            if (err.name !== "QuotaExceededError" || quotaRetried || !buffer.buffered.length ||
                time - buffer.buffered.start(0) < 12) throw err;
            quotaRetried = true;
            await update(() => buffer.remove(0, time - 8));
            continue;
          } finally { clear.fill(0); }
          if (g === generation) cursor++;
          quotaRetried = false;
        }
        if (!life.aborted && cursor === info.chunks.length && source.readyState === "open") source.endOfStream();
      } catch (error) { fail(error); }
      finally { clearTimeout(timer); busy = false; }
    }
    async function start() {
      watchdog();
      const opened = eventAfter(source, "sourceopen", life, () => {
        video.disableRemotePlayback = true;
        video.setAttribute("disableremoteplayback", "");
        video.preload = "auto";
        video.src = url;
      });
      const header = readIndex(decrypt);
      [info] = await Promise.all([header, opened]);
      if (!Type.isTypeSupported(info.mime)) throw Error("Unsupported stream codec");
      buffer = source.addSourceBuffer(info.mime);
      const init = await decrypt(0,info.chunks[0][0],info.chunks[0][1]);
      try { await append(init); } finally { init.fill(0); }
      source.duration = info.duration;
      initialized = true;
      await pump();
    }
    signal.addEventListener("abort", stop, {once:true});
    for (const name of ["play","timeupdate","waiting"]) video.addEventListener(name,wake,{signal:life});
    video.addEventListener("seeking",seek,{signal:life});
    for (const name of ["loadeddata","playing","seeked"]) video.addEventListener(name,clearFrameTimer,{signal:life});
    for (const name of ["play","waiting","seeked"]) video.addEventListener(name,expectPlayback,{signal:life});
    for (const name of ["pause","ended","seeking"]) video.addEventListener(name,clearPlayTimer,{signal:life});
    video.addEventListener("error",() => fail(Error("Stream playback error")),{signal:life});
    source.addEventListener("startstreaming",wake,{signal:life});
    expectFrame();
    start().catch(fail);
    return true;
  }
  window.albumStream = Object.freeze({attach});
})();
