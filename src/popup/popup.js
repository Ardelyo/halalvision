// Popup Script
document.addEventListener('DOMContentLoaded', async () => {
    // Elements
    const mainToggle = document.getElementById('mainToggle');
    const toggleLabel = document.getElementById('toggleLabel');
    const statusText = document.getElementById('statusText');
    const blurFaces = document.getElementById('blurFaces');
    const blurBodies = document.getElementById('blurBodies');
    const processVideos = document.getElementById('processVideos');
    const blurIntensity = document.getElementById('blurIntensity');
    const blurValue = document.getElementById('blurValue');
    const imagesBlurred = document.getElementById('imagesBlurred');
    const videosBlurred = document.getElementById('videosBlurred');
    const currentDomain = document.getElementById('currentDomain');
    const siteStatus = document.getElementById('siteStatus');
    const whitelistBtn = document.getElementById('whitelistBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const settingsBtn = document.getElementById('settingsBtn');

    let settings = null;
    let currentTab = null;

    // Load initial data
    async function initialize() {
        // Get current tab
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        currentTab = tabs[0];

        if (currentTab && currentTab.url) {
            try {
                const url = new URL(currentTab.url);
                currentDomain.textContent = url.hostname;
            } catch {
                currentDomain.textContent = 'N/A';
            }
        }

        // Get settings
        const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
        settings = response.settings;

        // Update UI
        updateUI();

        // Get stats
        const statsResponse = await chrome.runtime.sendMessage({ action: 'getStats' });
        updateStats(statsResponse.stats);

        // Check if site is whitelisted
        await checkWhitelistStatus();
    }

    function updateUI() {
        mainToggle.checked = settings.enabled;
        toggleLabel.textContent = settings.enabled ? 'Aktif' : 'Nonaktif';
        statusText.textContent = settings.enabled
            ? 'Extension sedang aktif melindungi pandangan Anda'
            : 'Extension sedang nonaktif';

        if (!settings.enabled) {
            document.body.classList.add('disabled');
        } else {
            document.body.classList.remove('disabled');
        }

        blurFaces.checked = settings.blurFaces;
        blurBodies.checked = settings.blurBodies;
        processVideos.checked = settings.processVideos;
        blurIntensity.value = settings.blurIntensity;
        blurValue.textContent = settings.blurIntensity;
    }

    function updateStats(stats) {
        if (stats) {
            imagesBlurred.textContent = stats.imagesProcessed || 0;
            videosBlurred.textContent = stats.videosProcessed || 0;
        }
    }

    async function checkWhitelistStatus() {
        if (currentTab && currentTab.url) {
            try {
                const url = new URL(currentTab.url);
                const isWhitelisted = settings.whitelist?.includes(url.hostname);

                if (isWhitelisted) {
                    siteStatus.textContent = 'Whitelist';
                    siteStatus.classList.add('whitelisted');
                    whitelistBtn.innerHTML = '<span>➖</span> Hapus';
                } else {
                    siteStatus.textContent = 'Diproses';
                    siteStatus.classList.remove('whitelisted');
                    whitelistBtn.innerHTML = '<span>➕</span> Whitelist';
                }
            } catch {
                // Invalid URL
            }
        }
    }

    async function saveSettings() {
        await chrome.runtime.sendMessage({
            action: 'updateSettings',
            settings
        });

        // Notify content script
        if (currentTab) {
            try {
                await chrome.tabs.sendMessage(currentTab.id, {
                    action: 'settingsUpdated',
                    settings
                });
            } catch {
                // Content script might not be ready
            }
        }
    }

    // Event Listeners
    mainToggle.addEventListener('change', async () => {
        settings.enabled = mainToggle.checked;
        await saveSettings();
        updateUI();
    });

    blurFaces.addEventListener('change', async () => {
        settings.blurFaces = blurFaces.checked;
        await saveSettings();
    });

    blurBodies.addEventListener('change', async () => {
        settings.blurBodies = blurBodies.checked;
        await saveSettings();
    });

    processVideos.addEventListener('change', async () => {
        settings.processVideos = processVideos.checked;
        await saveSettings();
    });

    blurIntensity.addEventListener('input', () => {
        blurValue.textContent = blurIntensity.value;
    });

    blurIntensity.addEventListener('change', async () => {
        settings.blurIntensity = parseInt(blurIntensity.value);
        await saveSettings();
    });

    whitelistBtn.addEventListener('click', async () => {
        if (currentTab && currentTab.url) {
            try {
                const url = new URL(currentTab.url);
                const domain = url.hostname;
                const index = settings.whitelist?.indexOf(domain) ?? -1;

                if (index > -1) {
                    // Remove from whitelist
                    settings.whitelist.splice(index, 1);
                } else {
                    // Add to whitelist
                    if (!settings.whitelist) settings.whitelist = [];
                    settings.whitelist.push(domain);
                }

                await saveSettings();
                await checkWhitelistStatus();

                // Refresh page to apply changes
                chrome.tabs.reload(currentTab.id);
            } catch {
                // Invalid URL
            }
        }
    });

    refreshBtn.addEventListener('click', () => {
        if (currentTab) {
            chrome.tabs.reload(currentTab.id);
            window.close();
        }
    });

    settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // Initialize
    initialize();
});
