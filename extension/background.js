chrome.action.onClicked.addListener(async currentTab => {
  const playerUrl = chrome.runtime.getURL("index.html");
  const query = currentTab?.windowId
    ? {url: playerUrl, windowId: currentTab.windowId}
    : {url: playerUrl};
  const [playerTab] = await chrome.tabs.query(query);

  if (playerTab?.id !== undefined) {
    await chrome.tabs.update(playerTab.id, {active: true});
    return;
  }

  const options = {url: playerUrl, active: true};
  if (currentTab?.windowId !== undefined) options.windowId = currentTab.windowId;
  await chrome.tabs.create(options);
});
