// Service Worker - Background Script
// Handles extension lifecycle and cross-tab communication

// Default settings
const DEFAULT_SETTINGS = {
    enabled: true,
    blurIntensity: 25,
    blurFaces: true,
    blurBodies: true,
    blurMen: true,
    blurWomen: true,
    processVideos: true,
    processImages: true,
    whitelist: [],
    blacklist: [],
    performanceMode: 'balanced', // 'fast', 'balanced', 'accurate'
    showNotifications: true,
    detectionSensitivity: 0.7,
    autoEnableOnStart: true
};

// Initialize extension on install
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('HalalVision installed:', details.reason);

    if (details.reason === 'install') {
        // Set default settings
        await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });

        // Open welcome/setup page
        chrome.tabs.create({
            url: 'src/options/options.html?welcome=true'
        });
    }

    // Create context menu
    createContextMenus();
});

// Create right-click context menus
function createContextMenus() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: 'toggleHalalVision',
            title: 'Toggle HalalVision',
            contexts: ['all']
        });

        chrome.contextMenus.create({
            id: 'addToWhitelist',
            title: 'Tambah ke Whitelist',
            contexts: ['all']
        });

        chrome.contextMenus.create({
            id: 'blurThisImage',
            title: 'Blur Gambar Ini',
            contexts: ['image']
        });

        chrome.contextMenus.create({
            id: 'unblurThisImage',
            title: 'Unblur Gambar Ini',
            contexts: ['image']
        });
    });
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    switch (info.menuItemId) {
        case 'toggleHalalVision':
            await toggleExtension();
            break;
        case 'addToWhitelist':
            await addCurrentSiteToWhitelist(tab);
            break;
        case 'blurSpecificImage':
            await sendMessageToTab(tab.id, {
                action: 'blurSpecificImage',
                imageUrl: info.srcUrl
            });
            break;
        case 'unblurSpecificImage':
            await sendMessageToTab(tab.id, {
                action: 'unblurSpecificImage',
                imageUrl: info.srcUrl
            });
            break;
    }
});

// Toggle extension on/off
async function toggleExtension() {
    const { settings } = await chrome.storage.sync.get('settings');
    settings.enabled = !settings.enabled;
    await chrome.storage.sync.set({ settings });

    // Notify all tabs
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        try {
            await sendMessageToTab(tab.id, {
                action: 'settingsUpdated',
                settings
            });
        } catch (e) {
            // Tab might not have content script
        }
    }

    // Update badge
    updateBadge(settings.enabled);
}

// Add current site to whitelist
async function addCurrentSiteToWhitelist(tab) {
    const url = new URL(tab.url);
    const domain = url.hostname;

    const { settings } = await chrome.storage.sync.get('settings');
    if (!settings.whitelist.includes(domain)) {
        settings.whitelist.push(domain);
        await chrome.storage.sync.set({ settings });

        // Notify tab
        await sendMessageToTab(tab.id, {
            action: 'siteWhitelisted',
            domain
        });
    }
}

// Update extension badge
function updateBadge(enabled) {
    chrome.action.setBadgeText({
        text: enabled ? 'ON' : 'OFF'
    });
    chrome.action.setBadgeBackgroundColor({
        color: enabled ? '#10B981' : '#EF4444'
    });
}

// Send message to specific tab
async function sendMessageToTab(tabId, message) {
    try {
        await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
        console.log('Could not send message to tab:', tabId);
    }
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender, sendResponse);
    return true; // Async response
});

async function handleMessage(message, sender, sendResponse) {
    switch (message.action) {
        case 'getSettings':
            const { settings } = await chrome.storage.sync.get('settings');
            sendResponse({ settings: settings || DEFAULT_SETTINGS });
            break;

        case 'updateSettings':
            await chrome.storage.sync.set({ settings: message.settings });
            updateBadge(message.settings.enabled);
            sendResponse({ success: true });
            break;

        case 'getStats':
            const { stats } = await chrome.storage.local.get('stats');
            sendResponse({ stats: stats || { imagesProcessed: 0, videosProcessed: 0 } });
            break;

        case 'updateStats':
            await chrome.storage.local.set({ stats: message.stats });
            sendResponse({ success: true });
            break;

        case 'isWhitelisted':
            const result = await chrome.storage.sync.get('settings');
            const isWhitelisted = result.settings?.whitelist?.includes(message.domain) || false;
            sendResponse({ isWhitelisted });
            break;

        default:
            sendResponse({ error: 'Unknown action' });
    }
}

// Initialize badge on startup
chrome.runtime.onStartup.addListener(async () => {
    const { settings } = await chrome.storage.sync.get('settings');
    if (settings) {
        updateBadge(settings.enabled);
    }
});
