// Options Page Script
document.addEventListener('DOMContentLoaded', async () => {
    let settings = null;

    // Get all elements
    const elements = {
        enabled: document.getElementById('enabled'),
        autoEnableOnStart: document.getElementById('autoEnableOnStart'),
        showNotifications: document.getElementById('showNotifications'),
        blurFaces: document.getElementById('blurFaces'),
        blurBodies: document.getElementById('blurBodies'),
        processImages: document.getElementById('processImages'),
        processVideos: document.getElementById('processVideos'),
        detectionSensitivity: document.getElementById('detectionSensitivity'),
        sensitivityValue: document.getElementById('sensitivityValue'),
        blurIntensity: document.getElementById('blurIntensity'),
        blurIntensityValue: document.getElementById('blurIntensityValue'),
        blurPreview: document.getElementById('blurPreview'),
        newSite: document.getElementById('newSite'),
        addSiteBtn: document.getElementById('addSiteBtn'),
        whitelistItems: document.getElementById('whitelistItems'),
        performanceMode: document.getElementById('performanceMode'),
        resetBtn: document.getElementById('resetBtn'),
        exportBtn: document.getElementById('exportBtn'),
        importBtn: document.getElementById('importBtn')
    };

    // Navigation
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.settings-section');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const sectionId = item.dataset.section;

            // Update nav
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            // Update sections
            sections.forEach(section => {
                section.classList.remove('active');
                if (section.id === sectionId) {
                    section.classList.add('active');
                }
            });
        });
    });

    // Load settings
    async function loadSettings() {
        const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
        settings = response.settings;
        updateUI();
    }

    function updateUI() {
        if (!settings) return;

        elements.enabled.checked = settings.enabled;
        elements.autoEnableOnStart.checked = settings.autoEnableOnStart;
        elements.showNotifications.checked = settings.showNotifications;
        elements.blurFaces.checked = settings.blurFaces;
        elements.blurBodies.checked = settings.blurBodies;
        elements.processImages.checked = settings.processImages;
        elements.processVideos.checked = settings.processVideos;
        elements.detectionSensitivity.value = settings.detectionSensitivity;
        elements.sensitivityValue.textContent = settings.detectionSensitivity;
        elements.blurIntensity.value = settings.blurIntensity;
        elements.blurIntensityValue.textContent = settings.blurIntensity;
        elements.performanceMode.value = settings.performanceMode;

        updateBlurPreview();
        renderWhitelist();
    }

    async function saveSettings() {
        await chrome.runtime.sendMessage({
            action: 'updateSettings',
            settings
        });
    }

    function updateBlurPreview() {
        elements.blurPreview.style.filter = `blur(${settings.blurIntensity}px)`;
    }

    function renderWhitelist() {
        elements.whitelistItems.innerHTML = '';

        if (!settings.whitelist || settings.whitelist.length === 0) {
            elements.whitelistItems.innerHTML = '<li style="padding: 24px; color: #666; text-align: center;">Belum ada situs di whitelist</li>';
            return;
        }

        settings.whitelist.forEach((site, index) => {
            const li = document.createElement('li');
            li.className = 'site-item';
            li.innerHTML = `
                <span class="site-name">${site}</span>
                <button class="remove-btn" data-index="${index}">✕</button>
            `;
            elements.whitelistItems.appendChild(li);
        });

        // Add remove handlers
        document.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const index = parseInt(btn.dataset.index);
                settings.whitelist.splice(index, 1);
                await saveSettings();
                renderWhitelist();
            });
        });
    }

    // Event Listeners
    const toggles = ['enabled', 'autoEnableOnStart', 'showNotifications',
        'blurFaces', 'blurBodies', 'processImages', 'processVideos'];

    toggles.forEach(id => {
        elements[id].addEventListener('change', async () => {
            settings[id] = elements[id].checked;
            await saveSettings();
        });
    });

    elements.detectionSensitivity.addEventListener('input', () => {
        elements.sensitivityValue.textContent = elements.detectionSensitivity.value;
    });

    elements.detectionSensitivity.addEventListener('change', async () => {
        settings.detectionSensitivity = parseFloat(elements.detectionSensitivity.value);
        await saveSettings();
    });

    elements.blurIntensity.addEventListener('input', () => {
        elements.blurIntensityValue.textContent = elements.blurIntensity.value;
        settings.blurIntensity = parseInt(elements.blurIntensity.value);
        updateBlurPreview();
    });

    elements.blurIntensity.addEventListener('change', async () => {
        await saveSettings();
    });

    elements.performanceMode.addEventListener('change', async () => {
        settings.performanceMode = elements.performanceMode.value;
        await saveSettings();
    });

    elements.addSiteBtn.addEventListener('click', async () => {
        const site = elements.newSite.value.trim().toLowerCase();

        if (site && !settings.whitelist.includes(site)) {
            if (!settings.whitelist) settings.whitelist = [];
            settings.whitelist.push(site);
            await saveSettings();
            renderWhitelist();
            elements.newSite.value = '';
        }
    });

    elements.newSite.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            elements.addSiteBtn.click();
        }
    });

    elements.resetBtn.addEventListener('click', async () => {
        if (confirm('Apakah Anda yakin ingin mengembalikan semua pengaturan ke default?')) {
            await chrome.storage.sync.clear();
            location.reload();
        }
    });

    elements.exportBtn.addEventListener('click', () => {
        const data = JSON.stringify(settings, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'halalvision-settings.json';
        a.click();
        URL.revokeObjectURL(url);
    });

    elements.importBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = async (event) => {
                    try {
                        const imported = JSON.parse(event.target.result);
                        settings = { ...settings, ...imported };
                        await saveSettings();
                        updateUI();
                        alert('Pengaturan berhasil diimport!');
                    } catch (error) {
                        alert('File tidak valid!');
                    }
                };
                reader.readAsText(file);
            }
        });

        input.click();
    });

    // Initialize
    loadSettings();
});
