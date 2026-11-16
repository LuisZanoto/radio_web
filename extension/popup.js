const RADIO_URL = "https://www.melodyfm.com.br/aovivo/audio";
const RADIO_TAB_PATTERN = "https://www.melodyfm.com.br/aovivo/audio*";
const statusElement = document.querySelector("#status");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");

const STATUS_TEXT = {
  buffering: "Aguardando o player iniciar...",
  no_media: "Player de áudio ainda não encontrado.",
  paused: "Player parado; tentando retomar.",
  play_blocked: "O navegador bloqueou o play. Inicie o áudio na página.",
  playing: "Áudio avançando; monitoramento ativo.",
  reconnecting: "Sem avanço por 5 segundos. Reconectando...",
  stopped: "Monitoramento parado.",
  unavailable: "Monitor não respondeu. Recarregue a página da rádio."
};

async function findRadioTabs() {
  return chrome.tabs.query({url: RADIO_TAB_PATTERN});
}

async function refreshStatus() {
  const {monitorEnabled = false} = await chrome.storage.local.get("monitorEnabled");
  const radioTabs = await findRadioTabs();
  let currentStatus = monitorEnabled ? "buffering" : "stopped";

  if (monitorEnabled && radioTabs.length) {
    try {
      const result = await chrome.tabs.sendMessage(radioTabs[0].id, {
        type: "GET_STATUS"
      });
      if (result?.status) currentStatus = result.status;
    } catch {
      currentStatus = "unavailable";
    }
  } else if (monitorEnabled) {
    currentStatus = "buffering";
  }

  statusElement.textContent = STATUS_TEXT[currentStatus] || STATUS_TEXT.buffering;
  startButton.disabled = monitorEnabled && radioTabs.length > 0;
  stopButton.disabled = radioTabs.length === 0;
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  statusElement.textContent = "Iniciando a rádio...";
  await chrome.storage.local.set({monitorEnabled: true});

  const radioTabs = await findRadioTabs();
  if (radioTabs.length) {
    const tab = radioTabs[0];
    await chrome.tabs.update(tab.id, {active: true});
    try {
      await chrome.tabs.sendMessage(tab.id, {type: "START_MONITORING"});
    } catch {
      statusElement.textContent = "Recarregando a rádio para ativar o monitor...";
      await chrome.tabs.reload(tab.id);
    }
  } else {
    await chrome.tabs.create({url: RADIO_URL, active: true});
  }
  await refreshStatus();
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  await chrome.storage.local.set({monitorEnabled: false});
  const radioTabs = await findRadioTabs();
  await Promise.all(radioTabs.map(async tab => {
    try {
      await chrome.tabs.sendMessage(tab.id, {type: "STOP_MONITORING"});
    } catch {
      await chrome.tabs.remove(tab.id);
    }
  }));
  await refreshStatus();
});

refreshStatus();
window.setInterval(refreshStatus, 1000);
