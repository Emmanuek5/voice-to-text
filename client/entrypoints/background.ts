const LOG_PREFIX = "[Voice-to-Text Background]";
const log = {
  info: (...args: any[]) => console.log(LOG_PREFIX, ...args),
  warn: (...args: any[]) => console.warn(LOG_PREFIX, ...args),
  error: (...args: any[]) => console.error(LOG_PREFIX, ...args),
  debug: (...args: any[]) => console.debug(LOG_PREFIX, ...args),
};

export default defineBackground(() => {
  log.info('Background script initialized', { 
    extensionId: browser.runtime.id,
    manifest: browser.runtime.getManifest().version 
  });
  
  // Listen for extension installation/update
  browser.runtime.onInstalled.addListener((details) => {
    log.info('Extension installed/updated', {
      reason: details.reason,
      previousVersion: details.previousVersion
    });
  });
  
  // Listen for messages from content scripts
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log.debug('Message received from content script', {
      message,
      sender: sender.tab?.url,
      tabId: sender.tab?.id
    });
    return false; // Not handling messages asynchronously
  });
  
  log.debug('Background script setup complete');
});
