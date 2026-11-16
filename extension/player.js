(() => {
  const API_URL = "https://de1.api.radio-browser.info/json/stations/search";
  const MAX_STATIONS = 20;
  const SIGNAL_THRESHOLD = 0.008;
  const STALL_AFTER_MS = 5000;

  const addressInput = document.querySelector("#stationAddress");
  const addressMode = document.querySelector("#addressMode");
  const playButton = document.querySelector("#playButton");
  const stopButton = document.querySelector("#stopButton");
  const favoriteButton = document.querySelector("#favoriteButton");
  const searchButton = document.querySelector("#searchButton");
  const playerStatus = document.querySelector("#playerStatus");
  const catalogStatus = document.querySelector("#catalogStatus");
  const favoriteStatus = document.querySelector("#favoriteStatus");
  const stationList = document.querySelector("#stationList");
  const favoriteList = document.querySelector("#favoriteList");
  const audioPlayer = document.querySelector("#audioPlayer");
  const siteFrame = document.querySelector("#siteFrame");
  const canvas = document.querySelector("#scope");
  const verticalScale = document.querySelector("#verticalScale");
  const extensionStorage = typeof chrome !== "undefined" ? chrome.storage?.local : null;

  async function storageGet(defaults) {
    if (extensionStorage) return extensionStorage.get(defaults);

    const values = {};
    for (const [key, defaultValue] of Object.entries(defaults)) {
      const savedValue = localStorage.getItem(`radio-web:${key}`);
      values[key] = savedValue === null ? defaultValue : JSON.parse(savedValue);
    }
    return values;
  }

  async function storageSet(values) {
    if (extensionStorage) {
      await extensionStorage.set(values);
      return;
    }
    for (const [key, value] of Object.entries(values)) {
      localStorage.setItem(`radio-web:${key}`, JSON.stringify(value));
    }
  }

  let stations = [];
  let favoriteStations = [];
  let audioContext = null;
  let tabStream = null;
  let tabSource = null;
  let tabCaptureKind = "";
  let analyzer = null;
  let monitoring = false;
  let reconnecting = false;
  let lastSignalAt = 0;
  let scale = Number(verticalScale.value);
  let activeUrl = "";
  let activeMode = "stream";
  let activeFrameUrl = "";

  function setPlayerStatus(message, state) {
    playerStatus.textContent = message;
    playerStatus.dataset.state = state || "stopped";
  }

  function normalizeHttpUrl(value) {
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error("Digite um endereço válido de rádio.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("O endereço precisa começar com http:// ou https://.");
    }
    return url.href;
  }

  function getKnownAudioStream(url) {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsedUrl.pathname.replace(/\/+$/, "").toLowerCase();
    if (hostname === "melodyfm.com.br" && pathname === "/aovivo/audio") {
      return "https://sc4s.cdn.upx.com:8080/stream";
    }
    return null;
  }

  function getYouTubeVideoId(value) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const isYouTube = host === "youtu.be" || host === "youtube.com" ||
      host.endsWith(".youtube.com");
    if (!isYouTube) return null;

    const pathParts = url.pathname.split("/").filter(Boolean);
    const videoId = host === "youtu.be"
      ? pathParts[0]
      : url.searchParams.get("v") ||
        (["embed", "shorts", "live", "v"].includes(pathParts[0]) ? pathParts[1] : null);
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
      throw new Error("Informe o link de um vídeo individual do YouTube.");
    }
    return videoId;
  }

  function getYouTubeEmbedUrl(videoId) {
    const embedUrl = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
    embedUrl.searchParams.set("autoplay", "1");
    embedUrl.searchParams.set("controls", "1");
    embedUrl.searchParams.set("playsinline", "1");
    embedUrl.searchParams.set("origin", location.origin);
    return embedUrl.href;
  }

  function captureCurrentTab() {
    if (typeof chrome === "undefined" || !chrome.tabCapture?.capture) return null;
    return new Promise((resolve, reject) => {
      chrome.tabCapture.capture({audio: true, video: false}, stream => {
        const error = chrome.runtime.lastError;
        if (error || !stream) {
          reject(new Error(error?.message || "O navegador não permitiu captar o áudio desta aba."));
          return;
        }
        resolve(stream);
      });
    });
  }

  function connectCapture(stream, context) {
    const source = context.createMediaStreamSource(stream);
    const nextAnalyzer = context.createAnalyser();
    nextAnalyzer.fftSize = 2048;
    source.connect(nextAnalyzer);
    nextAnalyzer.connect(context.destination);
    tabSource = source;
    analyzer = nextAnalyzer;
    tabStream = stream;
    tabCaptureKind = "tab";
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (monitoring) setPlayerStatus("A captura do áudio foi encerrada pelo navegador.", "error");
      }, {once: true});
    }
  }

  function connectMediaElementCapture(context) {
    if (typeof audioPlayer.captureStream !== "function") return false;
    try {
      const stream = audioPlayer.captureStream();
      if (stream.getAudioTracks().length === 0) return false;
      const source = context.createMediaStreamSource(stream);
      const nextAnalyzer = context.createAnalyser();
      nextAnalyzer.fftSize = 2048;
      source.connect(nextAnalyzer);
      tabSource = source;
      analyzer = nextAnalyzer;
      tabStream = stream;
      tabCaptureKind = "media";
      return true;
    } catch (error) {
      console.error("Radio Web: não foi possível capturar o áudio do stream.", error);
      return false;
    }
  }

  async function saveCurrentStation(url, mode) {
    await storageSet({currentStation: {url, mode}});
  }

  async function playStation() {
    let url;
    let videoId;
    let isKnownAudioPage = false;
    try {
      url = normalizeHttpUrl(addressInput.value);
      videoId = getYouTubeVideoId(url);
      const audioStreamUrl = getKnownAudioStream(url);
      if (audioStreamUrl) {
        isKnownAudioPage = true;
        url = audioStreamUrl;
        addressInput.value = url;
      }
    } catch (error) {
      setPlayerStatus(error.message, "error");
      return;
    }

    const mode = videoId ? "website" : isKnownAudioPage ? "stream" : addressMode.value;
    addressMode.value = mode;
    activeUrl = url;
    activeMode = mode;
    activeFrameUrl = videoId ? getYouTubeEmbedUrl(videoId) : url;
    playButton.disabled = true;
    setPlayerStatus("Conectando ao áudio da aba...", "buffering");
    try {
      if (!audioContext || audioContext.state === "closed") {
        audioContext = new AudioContext();
      }
      const resumePromise = audioContext.resume();
      const tabCaptureAvailable = typeof chrome !== "undefined" && chrome.tabCapture?.capture;
      const hasLiveTabCapture = tabCaptureKind === "tab" && tabStream &&
        tabStream.getAudioTracks().some(track => track.readyState === "live");
      const capturePromise = tabCaptureAvailable
        ? hasLiveTabCapture ? Promise.resolve(tabStream) : captureCurrentTab()
        : null;
      let playbackErrorPromise = Promise.resolve(null);
      if (mode === "stream") {
        siteFrame.style.display = "none";
        siteFrame.src = "about:blank";
        audioPlayer.style.display = "block";
        audioPlayer.src = url;
        playbackErrorPromise = audioPlayer.play().then(
          () => null,
          error => error
        );
      } else {
        audioPlayer.pause();
        audioPlayer.removeAttribute("src");
        audioPlayer.load();
        audioPlayer.style.display = "none";
        siteFrame.style.display = "block";
        siteFrame.src = activeFrameUrl;
      }
      monitoring = false;
      reconnecting = false;
      stopButton.disabled = false;
      let captureResult = null;
      let resumeResult;
      if (capturePromise) {
        [captureResult, resumeResult] = await Promise.allSettled([capturePromise, resumePromise]);
        if (captureResult.status === "rejected") throw captureResult.reason;
      } else {
        [resumeResult] = await Promise.allSettled([resumePromise]);
      }
      if (resumeResult.status === "rejected") {
        for (const track of captureResult?.value.getTracks() || []) track.stop();
        throw resumeResult.reason;
      }

      if (captureResult) {
        if (captureResult.value !== tabStream) connectCapture(captureResult.value, audioContext);
        monitoring = true;
        lastSignalAt = performance.now();
      } else if (mode === "stream") {
        const playbackError = await playbackErrorPromise;
        if (playbackError) throw playbackError;
        const hasLiveMediaCapture = tabCaptureKind === "media" && tabStream &&
          tabStream.getAudioTracks().some(track => track.readyState === "live");
        monitoring = hasLiveMediaCapture || connectMediaElementCapture(audioContext);
        lastSignalAt = performance.now();
      }
      await saveCurrentStation(url, mode);
      if (monitoring) {
        setPlayerStatus(
          videoId
            ? "YouTube oficial incorporado com vídeo visível; aguardando áudio."
            : "Aguardando ondas de áudio...",
          "buffering"
        );
        if (captureResult && mode === "stream") {
          playbackErrorPromise.then(error => {
            if (error && monitoring && activeUrl === url) {
              stopPlayer().then(() => {
                setPlayerStatus(`Falha ao iniciar o stream: ${error.message}`, "error");
              });
            }
          });
        }
      } else {
        setPlayerStatus(
          mode === "stream"
            ? "Rádio tocando; o osciloscópio não está disponível nesta página hospedada. Abra o player pela extensão Chrome/Edge para monitorar as ondas."
            : "Site aberto; a captura do áudio do site requer a extensão Chrome/Edge.",
          "unmonitored"
        );
      }
    } catch (error) {
      const unsupportedAudioSource = audioPlayer.error?.code === 4;
      const message = unsupportedAudioSource
        ? "Este endereço não é um stream de áudio compatível. Para páginas de rádio, selecione “Site da rádio / YouTube”; alguns sites bloqueiam a incorporação."
        : error.message;
      monitoring = false;
      await stopPlayer();
      setPlayerStatus(`Não foi possível iniciar: ${message}`, "error");
    } finally {
      playButton.disabled = false;
    }
  }

  async function stopPlayer() {
    monitoring = false;
    reconnecting = false;
    audioPlayer.pause();
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
    siteFrame.src = "about:blank";
    siteFrame.style.display = "none";
    audioPlayer.style.display = "block";
    activeUrl = "";
    activeFrameUrl = "";
    activeMode = "stream";
    tabCaptureKind = "";

    if (tabSource) {
      tabSource.disconnect();
      tabSource = null;
    }
    analyzer = null;
    if (tabStream) {
      for (const track of tabStream.getTracks()) track.stop();
      tabStream = null;
    }
    let closeError = null;
    if (audioContext && audioContext.state !== "closed") {
      try {
        await audioContext.close();
      } catch (error) {
        closeError = error;
      }
    }
    audioContext = null;
    stopButton.disabled = true;
    setPlayerStatus(
      closeError ? `Falha ao encerrar o áudio: ${closeError.message}` : "Reprodução e monitoramento parados.",
      closeError ? "error" : "stopped"
    );
  }

  function stationScore(station) {
    const tags = String(station.tags || "").toLowerCase();
    const name = String(station.name || "").toLowerCase();
    const description = `${tags},${name}`;
    const hasStyle = /\b(rock|pop|new wave|alternative)\b/.test(description);
    const hasEighties = /\b(80s|80's|80er|1980s|1980|eighties)\b/.test(description);
    const international = String(station.countrycode || "").toUpperCase() !== "BR";
    const english = String(station.language || "").toLowerCase().includes("english");
    return (hasEighties ? 100 : 0) + (hasStyle ? 40 : 0) +
      (english ? 15 : 0) + (international ? 10 : 0) +
      Math.min(Number(station.clickcount) || 0, 100000) / 100000;
  }

  function validStation(station) {
    if (Number(station.lastcheckok) !== 1 || Number(station.hls) === 1) return false;
    const searchable = `${station.name || ""},${station.tags || ""}`.toLowerCase();
    if (!/\b(rock|pop|new wave|alternative)\b/.test(searchable)) return false;
    if (/\b(christmas|xmas|holiday|noel)\b/.test(searchable)) return false;
    try {
      const streamUrl = new URL(station.url_resolved);
      return streamUrl.protocol === "http:" || streamUrl.protocol === "https:";
    } catch {
      return false;
    }
  }

  async function fetchByTag(tag) {
    const query = new URLSearchParams({
      tag,
      limit: "60",
      hidebroken: "true",
      order: "clickcount",
      reverse: "true"
    });
    const response = await fetch(`${API_URL}?${query}`);
    if (!response.ok) throw new Error(`Catálogo respondeu HTTP ${response.status}.`);
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error("O catálogo retornou uma resposta inválida.");
    return result;
  }

  function stationRecord(station) {
    return {
      id: String(station.stationuuid || station.url_resolved),
      name: String(station.name || "Rádio sem nome"),
      streamUrl: String(station.url_resolved),
      homepage: String(station.homepage || ""),
      tags: String(station.tags || ""),
      country: String(station.country || "Internacional"),
      language: String(station.language || ""),
      codec: String(station.codec || ""),
      bitrate: Number(station.bitrate) || 0,
      score: stationScore(station)
    };
  }

  async function searchStations() {
    searchButton.disabled = true;
    catalogStatus.textContent = "Buscando estações de rock, pop e anos 80...";
    try {
      const responses = await Promise.all(["80s", "rock", "pop"].map(fetchByTag));
      const unique = new Map();
      for (const station of responses.flat()) {
        if (!validStation(station)) continue;
        const record = stationRecord(station);
        const key = record.id || record.streamUrl;
        const existing = unique.get(key);
        if (!existing || record.score > existing.score) unique.set(key, record);
      }
      stations = Array.from(unique.values())
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_STATIONS);
      await storageSet({savedStations: stations});
      renderStations();
      catalogStatus.textContent = `Encontradas ${stations.length} estações online. Lista salva neste navegador.`;
    } catch (error) {
      catalogStatus.textContent = `A busca falhou: ${error.message}`;
    } finally {
      searchButton.disabled = false;
    }
  }

  function renderStations() {
    stationList.replaceChildren();
    for (const station of stations) {
      const item = document.createElement("li");
      item.className = "station";
      const info = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = station.name;
      const details = document.createElement("small");
      const format = [station.country, station.codec, station.bitrate ? `${station.bitrate} kbps` : ""]
        .filter(Boolean).join(" · ");
      details.textContent = `${format}${station.tags ? ` · ${station.tags}` : ""}`;
      const url = document.createElement("small");
      url.textContent = station.homepage || station.streamUrl;
      info.append(name, details, url);

      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.textContent = "Ouvir e monitorar";
      selectButton.addEventListener("click", () => {
        addressInput.value = station.streamUrl;
        addressMode.value = "stream";
        playStation();
      });
      item.append(info, selectButton);
      stationList.append(item);
    }
  }

  function renderFavorites() {
    favoriteList.replaceChildren();
    for (const station of favoriteStations) {
      const item = document.createElement("li");
      item.className = "station";
      const info = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = station.name;
      const url = document.createElement("small");
      url.textContent = station.url;
      info.append(name, url);

      const actions = document.createElement("div");
      actions.className = "station-actions";
      const playFavoriteButton = document.createElement("button");
      playFavoriteButton.type = "button";
      playFavoriteButton.textContent = "Ouvir e monitorar";
      playFavoriteButton.addEventListener("click", () => {
        addressInput.value = station.url;
        addressMode.value = station.mode;
        playStation();
      });
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "secondary";
      removeButton.textContent = "Remover";
      removeButton.addEventListener("click", () => removeFavorite(station.id));
      actions.append(playFavoriteButton, removeButton);
      item.append(info, actions);
      favoriteList.append(item);
    }
  }

  async function addFavorite() {
    let url;
    let mode = addressMode.value;
    try {
      url = normalizeHttpUrl(addressInput.value);
      if (getYouTubeVideoId(url)) mode = "website";
    } catch (error) {
      favoriteStatus.textContent = error.message;
      return;
    }

    const alreadySaved = favoriteStations.some(station =>
      station.url === url && station.mode === mode
    );
    if (alreadySaved) {
      favoriteStatus.textContent = "Essa rádio já está nos favoritos.";
      return;
    }

    const favorite = {
      id: `${mode}:${url}`,
      name: new URL(url).hostname,
      url,
      mode
    };
    const updatedFavorites = [...favoriteStations, favorite];
    try {
      await storageSet({favoriteStations: updatedFavorites});
    } catch (error) {
      favoriteStatus.textContent = `Não foi possível salvar o favorito: ${error.message}`;
      return;
    }
    favoriteStations = updatedFavorites;
    renderFavorites();
    favoriteStatus.textContent = `${favorite.name} foi adicionado aos favoritos.`;
  }

  async function removeFavorite(id) {
    const updatedFavorites = favoriteStations.filter(station => station.id !== id);
    try {
      await storageSet({favoriteStations: updatedFavorites});
    } catch (error) {
      favoriteStatus.textContent = `Não foi possível remover o favorito: ${error.message}`;
      return;
    }
    favoriteStations = updatedFavorites;
    renderFavorites();
    favoriteStatus.textContent = "Favorito removido.";
  }

  function drawFrame() {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "#183956";
    context.lineWidth = ratio;
    context.beginPath();
    for (let x = 0; x <= width; x += width / 10) {
      context.moveTo(x, 0);
      context.lineTo(x, height);
    }
    for (let y = 0; y <= height; y += height / 4) {
      context.moveTo(0, y);
      context.lineTo(width, y);
    }
    context.stroke();

    let data = null;
    let rms = 0;
    if (analyzer && monitoring) {
      data = new Float32Array(analyzer.fftSize);
      analyzer.getFloatTimeDomainData(data);
      rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    }

    const now = performance.now();
    if (monitoring && data && rms >= SIGNAL_THRESHOLD) {
      lastSignalAt = now;
      reconnecting = false;
      setPlayerStatus("Sinal de áudio detectado — monitorando.", "playing");
    } else if (monitoring && !reconnecting && now - lastSignalAt >= STALL_AFTER_MS) {
      reconnecting = true;
      lastSignalAt = now;
      setPlayerStatus("Sem ondas por 5 segundos. Reconectando a rádio nesta página...", "buffering");
      if (activeMode === "stream") {
        audioPlayer.pause();
        audioPlayer.src = activeUrl;
        audioPlayer.load();
        audioPlayer.play().catch(error => {
          setPlayerStatus(`Falha ao retomar o stream: ${error.message}`, "error");
        });
      } else {
        siteFrame.src = activeFrameUrl;
      }
      window.setTimeout(() => {
        reconnecting = false;
      }, 1200);
    }

    context.beginPath();
    context.strokeStyle = "#55c8ff";
    context.lineWidth = 2 * ratio;
    context.shadowColor = "#27aaff";
    context.shadowBlur = 8 * ratio;
    if (data) {
      const middle = height / 2;
      for (let x = 0; x < width; x++) {
        const sampleIndex = Math.floor(x / width * data.length);
        const y = middle - data[sampleIndex] * middle * scale;
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
    } else {
      context.moveTo(0, height / 2);
      context.lineTo(width, height / 2);
    }
    context.stroke();
    context.shadowBlur = 0;
    window.requestAnimationFrame(drawFrame);
  }

  playButton.addEventListener("click", playStation);
  stopButton.addEventListener("click", stopPlayer);
  favoriteButton.addEventListener("click", addFavorite);
  searchButton.addEventListener("click", searchStations);
  verticalScale.addEventListener("input", () => {
    scale = Number(verticalScale.value);
  });

  storageGet({
    savedStations: [],
    favoriteStations: [],
    currentStation: null
  }).then(data => {
    stations = Array.isArray(data.savedStations) ? data.savedStations.slice(0, MAX_STATIONS) : [];
    favoriteStations = Array.isArray(data.favoriteStations) ? data.favoriteStations : [];
    renderStations();
    renderFavorites();
    if (data.currentStation?.url) {
      addressInput.value = data.currentStation.url;
      addressMode.value = data.currentStation.mode === "website" ? "website" : "stream";
    }
    if (stations.length) {
      catalogStatus.textContent = `${stations.length} estações salvas.`;
    } else {
      searchStations();
    }
  }).catch(error => {
    catalogStatus.textContent = `Não foi possível carregar as rádios salvas: ${error.message}`;
  });

  drawFrame();
})();
