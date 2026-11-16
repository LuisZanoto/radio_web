(() => {
  const CHECK_INTERVAL_MS = 250;
  const STALL_AFTER_MS = 5000;
  const PROGRESS_DELTA_SECONDS = 0.05;

  let enabled = false;
  let status = "stopped";
  let lastProgressAt = performance.now();
  let previousTimes = new WeakMap();
  let timerId = null;
  let reloading = false;

  function getMediaElements() {
    return Array.from(document.querySelectorAll("audio, video"));
  }

  function setStatus(nextStatus) {
    status = nextStatus;
  }

  function requestPlayback() {
    for (const media of getMediaElements()) {
      if (media.paused || media.ended) {
        media.play().catch(() => {
          if (enabled) setStatus("play_blocked");
        });
      }
    }
  }

  function stopMonitoring() {
    enabled = false;
    reloading = false;
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    for (const media of getMediaElements()) {
      media.pause();
    }
    setStatus("stopped");
  }

  function checkPlayback() {
    if (!enabled || reloading) return;

    const now = performance.now();
    const mediaElements = getMediaElements();
    let progressed = false;

    for (const media of mediaElements) {
      const currentTime = Number(media.currentTime);
      const previousTime = previousTimes.get(media);

      if (
        Number.isFinite(currentTime) &&
        previousTime !== undefined &&
        currentTime > previousTime + PROGRESS_DELTA_SECONDS
      ) {
        progressed = true;
      }
      if (Number.isFinite(currentTime)) previousTimes.set(media, currentTime);
    }

    if (progressed) lastProgressAt = now;

    if (now - lastProgressAt >= STALL_AFTER_MS) {
      reloading = true;
      setStatus("reconnecting");
      window.location.reload();
      return;
    }

    if (mediaElements.length === 0) {
      setStatus("no_media");
    } else if (progressed || now - lastProgressAt < CHECK_INTERVAL_MS * 2) {
      setStatus("playing");
    } else if (mediaElements.every(media => media.paused || media.ended || media.error)) {
      setStatus("paused");
    } else {
      setStatus("buffering");
    }
  }

  function startMonitoring() {
    if (enabled) return;
    enabled = true;
    reloading = false;
    lastProgressAt = performance.now();
    previousTimes = new WeakMap();
    setStatus("buffering");
    requestPlayback();
    checkPlayback();
    timerId = window.setInterval(checkPlayback, CHECK_INTERVAL_MS);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "START_MONITORING") {
      startMonitoring();
    } else if (message?.type === "STOP_MONITORING") {
      stopMonitoring();
    } else if (message?.type === "GET_STATUS") {
      sendResponse({
        enabled,
        status,
        mediaCount: getMediaElements().length
      });
    }
    return false;
  });

  chrome.storage.local.get({monitorEnabled: false}, ({monitorEnabled}) => {
    if (monitorEnabled) startMonitoring();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.monitorEnabled) return;
    if (changes.monitorEnabled.newValue) {
      startMonitoring();
    } else {
      stopMonitoring();
    }
  });
})();
