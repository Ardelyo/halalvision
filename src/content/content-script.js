// Content Script - Main Entry Point
// Injected into all web pages

(async function () {
    'use strict';

    // Configuration
    let settings = null;
    let isInitialized = false;
    let detector = null;
    let observer = null;
    let processedElements = new WeakSet();
    let blurredElements = new Map();

    // Initialize extension
    async function initialize() {
        if (isInitialized) return;

        console.log('🕌 HalalVision: Initializing...');

        // Get settings
        settings = await getSettings();

        if (!settings || !settings.enabled) {
            console.log('🕌 HalalVision: Extension disabled');
            return;
        }

        // Check whitelist
        const isWhitelisted = await checkWhitelist();
        if (isWhitelisted) {
            console.log('🕌 HalalVision: Site is whitelisted');
            return;
        }

        // Load ML detector
        detector = new HalalVisionDetector();
        await detector.initialize();

        // Process existing images with AI
        await processExistingMedia();

        // Start observing DOM changes
        startDOMObserver();

        // Periodic scan for missed elements (every 5 seconds)
        setInterval(processExistingMedia, 5000);

        isInitialized = true;
        console.log('延 HalalVision: Ready - Menjaga pandangan Anda');
    }

    // Get settings from background
    async function getSettings() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
                resolve(response.settings);
            });
        });
    }

    // Check if current site is whitelisted
    async function checkWhitelist() {
        const domain = window.location.hostname;
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: 'isWhitelisted',
                domain
            }, (response) => {
                resolve(response.isWhitelisted);
            });
        });
    }

    // ML Detector Class
    class HalalVisionDetector {
        constructor() {
            this.isLoaded = false;
            // FaceAPI models
            this.modelsLoaded = false;
        }

        async initialize() {
            try {
                console.log('🕌 HalalVision: Initializing Face-API...');

                // Helper to wait for global faceapi if needed
                let retry = 0;
                while (typeof faceapi === 'undefined' && retry < 20) {
                    await new Promise(r => setTimeout(r, 100));
                    retry++;
                }

                if (typeof faceapi === 'undefined') {
                    throw new Error('face-api.js not found');
                }

                // Load models from local extension directory
                const modelPath = chrome.runtime.getURL('libs/models');

                await Promise.all([
                    faceapi.nets.tinyFaceDetector.loadFromUri(modelPath),
                    faceapi.nets.ageGenderNet.loadFromUri(modelPath)
                ]);

                // Also load BodyPix (it uses tf global)
                if (typeof bodyPix !== 'undefined') {
                    this.bodyModel = await bodyPix.load({
                        architecture: 'MobileNetV1',
                        outputStride: 16,
                        multiplier: 0.5, // Keep it fast
                        quantBytes: 2
                    });
                }

                this.isLoaded = true;
                console.log('🕌 HalalVision: AI Models (Face-API + BodyPix) Ready');
            } catch (error) {
                console.error('🕌 HalalVision: Model load failed:', error);
            }
        }

        async analyzeImage(imageElement) {
            const results = {
                faces: [],
                bodySegmentation: null,
                shouldBlur: false,
                isFallback: !this.isLoaded
            };

            if (!this.isLoaded) return results; // Fail safe, don't blur if not ready

            try {
                // 1. Detect Faces & Gender with Face-API
                if (settings.blurFaces || settings.blurMen || settings.blurWomen) {
                    // Detect all faces with gender
                    // useTinyFaceDetectorOptions helps performance
                    const detections = await faceapi.detectAllFaces(
                        imageElement,
                        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 })
                    ).withAgeAndGender();

                    for (const detection of detections) {
                        const { gender, genderProbability } = detection;
                        const box = detection.detection.box;

                        // Strict Gender Logic
                        // Default to safe if probability is low (< 0.6) -> Treat as "Unknown" -> Blur if strict checks enabled
                        let effectiveGender = gender;
                        if (genderProbability < 0.6) effectiveGender = 'unknown';

                        let shouldBlurFace = false;

                        if (settings.blurFaces) {
                            // If "Blur All Faces" is on, we blur regardless of gender
                            shouldBlurFace = true;
                        } else {
                            // Specific gender targeting
                            if (settings.blurMen && effectiveGender === 'male') shouldBlurFace = true;
                            if (settings.blurWomen && effectiveGender === 'female') shouldBlurFace = true;

                            // Safety: If unknown gender, do we blur? 
                            // Current logic: If user wants to blur EITHER men or women, and we are unsure, 
                            // safest bet is to blur. BUT user complained about over-blurring.
                            // So let's be "Innocent until proven guilty" to avoid annoyance, 
                            // UNLESS user enabled "Blur Faces" (checked above).
                            // So here we only blur if confident.
                        }

                        if (shouldBlurFace) {
                            // Convert FaceAPI box to our format
                            results.faces.push({
                                topLeft: [box.x, box.y],
                                bottomRight: [box.x + box.width, box.y + box.height]
                            });
                        }
                    }
                }

                // 2. Body Detection (BodyPix)
                // Only run if we need to blur bodies
                if (settings.blurBodies) {
                    // Logic: If we found faces that needed blurring, we likely want to blur the body too.
                    // If we found faces that were SAFE (e.g. valid gender), we might NOT want to blur the body.

                    // Complex Case: A mixed photo (User wants to blur Women, photo has Man + Woman).
                    // Face-API handles faces fine. BodyPix segments *everyone* as one mask usually (or id map).
                    // BodyPix "person segmentation" doesn't distinguish gender.

                    // Strategy: 
                    // If ANY face was flagged to be blurred, we blur the body for safety.
                    // If NO faces were detected at all (e.g. back shot), we blur the body if blurBodies is ON.
                    // If FACES were detected but ALL were determined SAFE (e.g. Men only, and blurMen is OFF),
                    // then we skip body blur to avoid blurring the "good" subjects.

                    let runBodyPix = false;

                    if (results.faces.length > 0) {
                        // We found bad faces, so we definitely need to blur their bodies if possible
                        runBodyPix = true;
                    } else {
                        // No bad faces found. 
                        // Did we find ANY faces? 
                        const allFaces = await faceapi.detectAllFaces(
                            imageElement,
                            new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.3 })
                        );

                        if (allFaces.length === 0) {
                            // No faces at all. Could be a headless body shot.
                            // Blur if blurBodies is ON.
                            runBodyPix = true;
                        } else {
                            // We found faces, but none were added to results.faces
                            // This means they were all "Safe" genders.
                            // So we DO NOT blur the body.
                            runBodyPix = false;
                        }
                    }

                    if (runBodyPix) {
                        results.bodySegmentation = await this.segmentBody(imageElement);
                    }
                }

                results.shouldBlur = results.faces.length > 0 ||
                    (results.bodySegmentation && this.hasPersonInSegmentation(results.bodySegmentation));

            } catch (err) {
                // console.warn('Detection skipped:', err); // Suppress noise
            }

            return results;
        }

        async segmentBody(imageElement) {
            if (!this.bodyModel) return null;
            try {
                return await this.bodyModel.segmentPerson(imageElement, {
                    internalResolution: 'medium',
                    segmentationThreshold: 0.7,
                    scoreThreshold: 0.5
                });
            } catch (e) { return null; }
        }

        hasPersonInSegmentation(segmentation) {
            if (!segmentation || !segmentation.data) return false;
            const personPixelCount = segmentation.data.filter(val => val > 0).length;
            const threshold = segmentation.data.length * 0.005; // 0.5% coverage
            return personPixelCount > threshold;
        }

        // Removed old methods: detectFaces, classifyGender (replaced by face-api)
    }

    // Blur Engine Class
    class BlurEngine {
        constructor() {
            this.canvas = document.createElement('canvas');
            this.ctx = this.canvas.getContext('2d');
        }

        async applyBlur(element, detectionResults) {
            if (detectionResults.isFallback) {
                // Apply a simple full CSS blur if AI isn't ready or failed
                this.applyCSSBlur(element);
                return;
            }

            if (element.tagName === 'IMG') {
                await this.blurImage(element, detectionResults);
            } else if (element.tagName === 'VIDEO') {
                await this.blurVideo(element, detectionResults);
            }
        }

        applyCSSBlur(element) {
            if (blurredElements.has(element)) return;

            // Just apply a heavy blur to everything if AI is down
            element.style.filter = `blur(${settings.blurIntensity}px)`;
            element.style.transition = 'filter 0.3s ease';

            // Add a badge to show it's protected
            this.applyBlurredOverlay(element, null, true);
        }

        async blurImage(img, results) {
            // Create overlay canvas
            const overlay = document.createElement('canvas');
            // Use client width/height for display accuracy if natural isn't ready
            overlay.width = img.naturalWidth || img.width || 300;
            overlay.height = img.naturalHeight || img.height || 300;
            const overlayCtx = overlay.getContext('2d');

            try {
                // Draw original image
                overlayCtx.drawImage(img, 0, 0, overlay.width, overlay.height);

                // Apply blur based on detection results
                if (settings.blurFaces && results.faces.length > 0) {
                    for (const face of results.faces) {
                        this.blurRegion(overlayCtx, face.topLeft, face.bottomRight);
                    }
                }

                if (settings.blurBodies && results.bodySegmentation) {
                    await this.blurBodyRegions(overlayCtx, results.bodySegmentation, overlay.width, overlay.height);
                }

                // Apply blurred image
                this.applyBlurredOverlay(img, overlay);
            } catch (err) {
                console.log('CORS block on canvas, falling back to CSS blur');
                this.applyCSSBlur(img);
            }
        }

        blurRegion(ctx, topLeft, bottomRight) {
            const x = topLeft[0];
            const y = topLeft[1];
            const width = bottomRight[0] - topLeft[0];
            const height = bottomRight[1] - topLeft[1];

            // Expand region slightly
            const padding = Math.max(width, height) * 0.2;
            const expandedX = Math.max(0, x - padding);
            const expandedY = Math.max(0, y - padding);
            const expandedWidth = width + padding * 2;
            const expandedHeight = height + padding * 2;

            // Get image data for the region
            const imageData = ctx.getImageData(expandedX, expandedY, expandedWidth, expandedHeight);

            // Apply blur using stack blur algorithm
            this.stackBlur(imageData.data, expandedWidth, expandedHeight, settings.blurIntensity);

            // Put blurred data back
            ctx.putImageData(imageData, expandedX, expandedY);
        }

        async blurBodyRegions(ctx, segmentation, width, height) {
            // Create mask from segmentation
            const mask = this.createMaskFromSegmentation(segmentation, width, height);

            // Get full image data
            const imageData = ctx.getImageData(0, 0, width, height);

            // Create blurred version
            const blurredData = new Uint8ClampedArray(imageData.data);
            this.stackBlur(blurredData, width, height, settings.blurIntensity);

            // Apply mask - blur only where person is detected
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] > 0) {
                    const idx = i * 4;
                    imageData.data[idx] = blurredData[idx];
                    imageData.data[idx + 1] = blurredData[idx + 1];
                    imageData.data[idx + 2] = blurredData[idx + 2];
                }
            }

            ctx.putImageData(imageData, 0, 0);
        }

        createMaskFromSegmentation(segmentation, width, height) {
            const mask = new Uint8Array(width * height);

            if (segmentation.data) {
                for (let i = 0; i < segmentation.data.length; i++) {
                    mask[i] = segmentation.data[i] > 0 ? 255 : 0;
                }
            }

            return mask;
        }

        stackBlur(pixels, width, height, radius) {
            // Fast stack blur implementation
            radius = Math.floor(radius);
            if (radius < 1) return;

            const wm = width - 1;
            const hm = height - 1;
            const wh = width * height;
            const div = radius + radius + 1;

            const r = new Uint8ClampedArray(wh);
            const g = new Uint8ClampedArray(wh);
            const b = new Uint8ClampedArray(wh);

            let rsum, gsum, bsum, x, y, i, p, yp, yi, yw;
            const vmin = new Uint32Array(Math.max(width, height));
            const vmax = new Uint32Array(Math.max(width, height));

            const divsum = (div + 1) >> 1;
            divsum *= divsum;

            // Horizontal blur
            yw = yi = 0;
            for (y = 0; y < height; y++) {
                rsum = gsum = bsum = 0;

                for (i = -radius; i <= radius; i++) {
                    p = (yi + Math.min(wm, Math.max(i, 0))) * 4;
                    rsum += pixels[p];
                    gsum += pixels[p + 1];
                    bsum += pixels[p + 2];
                }

                for (x = 0; x < width; x++) {
                    r[yi] = Math.round(rsum / div);
                    g[yi] = Math.round(gsum / div);
                    b[yi] = Math.round(bsum / div);

                    if (y === 0) {
                        vmin[x] = Math.min(x + radius + 1, wm);
                        vmax[x] = Math.max(x - radius, 0);
                    }

                    p = (yw + vmin[x]) * 4;
                    const p2 = (yw + vmax[x]) * 4;

                    rsum += pixels[p] - pixels[p2];
                    gsum += pixels[p + 1] - pixels[p2 + 1];
                    bsum += pixels[p + 2] - pixels[p2 + 2];

                    yi++;
                }
                yw += width;
            }

            // Vertical blur
            for (x = 0; x < width; x++) {
                rsum = gsum = bsum = 0;
                yp = -radius * width;

                for (i = -radius; i <= radius; i++) {
                    yi = Math.max(0, yp) + x;
                    rsum += r[yi];
                    gsum += g[yi];
                    bsum += b[yi];
                    yp += width;
                }

                yi = x;
                for (y = 0; y < height; y++) {
                    pixels[yi * 4] = Math.round(rsum / div);
                    pixels[yi * 4 + 1] = Math.round(gsum / div);
                    pixels[yi * 4 + 2] = Math.round(bsum / div);

                    if (x === 0) {
                        vmin[y] = Math.min(y + radius + 1, hm) * width;
                        vmax[y] = Math.max(y - radius, 0) * width;
                    }

                    const p1 = x + vmin[y];
                    const p2 = x + vmax[y];

                    rsum += r[p1] - r[p2];
                    gsum += g[p1] - g[p2];
                    bsum += b[p1] - b[p2];

                    yi += width;
                }
            }
        }

        applyBlurredOverlay(originalImg, blurredCanvas, isCSSOnly = false) {
            if (blurredElements.has(originalImg)) return;

            // Create wrapper if not exists
            let wrapper = originalImg.parentElement;
            if (!wrapper || !wrapper.classList.contains('halal-vision-wrapper')) {
                wrapper = document.createElement('div');
                wrapper.classList.add('halal-vision-wrapper');

                // Match original image layout
                const style = window.getComputedStyle(originalImg);
                wrapper.style.display = style.display === 'block' ? 'block' : 'inline-block';
                wrapper.style.position = 'relative';
                wrapper.style.width = style.width;
                wrapper.style.height = style.height;
                wrapper.style.margin = style.margin;
                wrapper.style.padding = style.padding;
                wrapper.style.float = style.float;

                originalImg.parentNode.insertBefore(wrapper, originalImg);
                wrapper.appendChild(originalImg);
            }

            let overlay = null;
            if (!isCSSOnly && blurredCanvas) {
                // Create canvas overlay for selective blur
                overlay = document.createElement('div');
                overlay.classList.add('halal-vision-overlay');
                overlay.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-image: url(${blurredCanvas.toDataURL()});
                    background-size: cover;
                    pointer-events: none;
                    z-index: 1000;
                `;
                wrapper.appendChild(overlay);
            } else {
                // CSS Fallback - blur the original image directly
                originalImg.style.filter = `blur(${settings.blurIntensity}px)`;
            }

            // Add indicator badge
            const badge = document.createElement('div');
            badge.classList.add('halal-vision-badge');
            badge.innerHTML = '🕌';
            badge.title = 'Dilindungi HalalVision';

            // Toggle blur on badge click
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                if (overlay) {
                    overlay.style.display = overlay.style.display === 'none' ? 'block' : 'none';
                } else {
                    originalImg.style.filter = originalImg.style.filter ? '' : `blur(${settings.blurIntensity}px)`;
                }
            });

            wrapper.appendChild(badge);

            // Store reference
            blurredElements.set(originalImg, { wrapper, overlay, badge });
        }
    }

    // Video Processor Class
    class VideoProcessor {
        constructor(detector, blurEngine) {
            this.detector = detector;
            this.blurEngine = blurEngine;
            this.processingVideos = new Map();
        }

        async processVideo(video) {
            if (this.processingVideos.has(video)) return;

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            const process = async () => {
                if (video.paused || video.ended || !settings.enabled) {
                    return;
                }

                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0);

                try {
                    const results = await this.detector.analyzeImage(canvas);

                    if (results.shouldBlur) {
                        await this.applyVideoBlur(video, results, canvas);
                    }
                } catch (error) {
                    console.error('Video processing error:', error);
                }

                // Continue processing
                requestAnimationFrame(process);
            };

            this.processingVideos.set(video, true);

            video.addEventListener('play', () => {
                requestAnimationFrame(process);
            });

            if (!video.paused) {
                requestAnimationFrame(process);
            }
        }

        async applyVideoBlur(video, results, canvas) {
            // Apply CSS blur filter for performance
            let overlay = video.parentElement.querySelector('.halal-vision-video-overlay');

            if (!overlay) {
                overlay = document.createElement('div');
                overlay.classList.add('halal-vision-video-overlay');
                overlay.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    backdrop-filter: blur(${settings.blurIntensity}px);
                    -webkit-backdrop-filter: blur(${settings.blurIntensity}px);
                    pointer-events: none;
                    z-index: 1000;
                `;

                // Wrap video if needed
                if (!video.parentElement.classList.contains('halal-vision-video-wrapper')) {
                    const wrapper = document.createElement('div');
                    wrapper.classList.add('halal-vision-video-wrapper');
                    wrapper.style.cssText = 'position: relative; display: inline-block;';
                    video.parentNode.insertBefore(wrapper, video);
                    wrapper.appendChild(video);
                }

                video.parentElement.appendChild(overlay);
            }
        }
    }

    // Process existing media on page
    async function processExistingMedia() {
        const blurEngine = new BlurEngine();
        const videoProcessor = new VideoProcessor(detector, blurEngine);

        // Process images
        if (settings.processImages) {
            const images = document.querySelectorAll('img');
            for (const img of images) {
                if (!isImageValid(img)) continue;

                // If already processed and NOT blurred, we might want to skip.
                // But we should allow re-scans if the image src changed.
                if (processedElements.has(img) && !blurredElements.has(img)) continue;

                if (window.hvWatchMedia) {
                    // Start observing for viewport entries
                    window.hvWatchMedia();

                    // Do not apply permanent blur immediately, wait for scan in viewport
                    // But if it's already in viewport, trigger it
                    const rect = img.getBoundingClientRect();
                    if (rect.top < window.innerHeight && rect.bottom > 0) {
                        processImage(img, blurEngine);
                    }
                } else {
                    processedElements.add(img);
                    if (!img.complete) {
                        img.addEventListener('load', () => processImage(img, blurEngine), { once: true });
                    } else {
                        await processImage(img, blurEngine);
                    }
                }
            }
        }

        // Process videos
        if (settings.processVideos) {
            const videos = document.querySelectorAll('video');
            for (const video of videos) {
                if (processedElements.has(video)) continue;
                processedElements.add(video);
                await videoProcessor.processVideo(video);
            }
        }
    }

    // Check if image is valid for processing
    function isImageValid(img) {
        // Skip tiny images (icons, etc.)
        if (img.width < 50 || img.height < 50) return false;

        // Skip data URIs that are too small
        if (img.src.startsWith('data:') && img.src.length < 1000) return false;

        // Skip SVGs
        if (img.src.endsWith('.svg')) return false;

        return true;
    }

    // Process single image
    async function processImage(img, blurEngine) {
        if (processedElements.has(img) && blurredElements.has(img)) {
            // Already processed and blurred, maybe re-check if settings changed
        }

        try {
            // Create temp canvas for analysis
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // Wait for image load if dimensions are 0
            if (img.naturalWidth === 0) {
                await new Promise((r) => img.addEventListener('load', r, { once: true }));
            }

            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;

            // Simple check for canvas support and image validity
            if (canvas.width === 0 || canvas.height === 0) return;

            // Draw and analyze
            ctx.drawImage(img, 0, 0);
            const results = await detector.analyzeImage(img);

            if (results.shouldBlur) {
                await blurEngine.applyBlur(img, results);
                updateStats('image');
            } else {
                // If AI says it's safe, remove any pre-existing blur
                blurEngine.removeBlur(img);
            }

            processedElements.add(img);
        } catch (error) {
            console.log('Process error:', error);
            // Fallback for CORS or complexity
            if (detector.isLoaded) {
                // If model is loaded but we had a technical error, 
                // we might want to blur just in case if safe mode is high.
                // For now, let's keep it clean to avoid over-blurring.
            }
        }
    }

    // Update statistics
    function updateStats(type) {
        chrome.runtime.sendMessage({ action: 'getStats' }, (response) => {
            const stats = response.stats || { imagesProcessed: 0, videosProcessed: 0 };

            if (type === 'image') {
                stats.imagesProcessed++;
            } else if (type === 'video') {
                stats.videosProcessed++;
            }

            chrome.runtime.sendMessage({ action: 'updateStats', stats });
        });
    }

    // Start DOM Observer for dynamic content
    function startDOMObserver() {
        const blurEngine = new BlurEngine();
        const videoProcessor = new VideoProcessor(detector, blurEngine);

        // Configuration for the observer:
        // monitor for added nodes AND attribute changes (like src changes in SPAs)
        const observerConfig = {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'srcset']
        };

        observer = new MutationObserver(async (mutations) => {
            let needsProcessing = false;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.tagName === 'IMG' || node.tagName === 'VIDEO' || node.querySelector('img, video')) {
                                needsProcessing = true;
                                break;
                            }
                        }
                    }
                } else if (mutation.type === 'attributes') {
                    const node = mutation.target;
                    if (node.tagName === 'IMG' || node.tagName === 'VIDEO') {
                        // If src/srcset changed, re-process it
                        processedElements.delete(node);
                        needsProcessing = true;
                    }
                }
                if (needsProcessing) break;
            }

            if (needsProcessing) {
                // Debounce slightly to handle burst updates on scroll
                clearTimeout(window.hvProcessTimeout);
                window.hvProcessTimeout = setTimeout(() => {
                    processExistingMedia();
                }, 100);
            }
        });

        observer.observe(document.body, observerConfig);

        // Setup IntersectionObserver to process things as they enter viewport
        // This is more efficient for heavy pages
        const viewportObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const el = entry.target;
                    if (!processedElements.has(el)) {
                        if (el.tagName === 'IMG') {
                            processImage(el, blurEngine);
                        } else if (el.tagName === 'VIDEO') {
                            videoProcessor.processVideo(el);
                        }
                        processedElements.add(el);
                    }
                }
            });
        }, { threshold: 0.1 });

        // Helper to watch all media
        window.hvWatchMedia = () => {
            document.querySelectorAll('img, video').forEach(el => {
                viewportObserver.observe(el);
            });
        };

        window.hvWatchMedia();
    }

    // Listen for messages from background/popup
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.action) {
            case 'settingsUpdated':
                settings = message.settings;
                if (!settings.enabled) {
                    removeAllBlurs();
                } else {
                    processExistingMedia();
                }
                break;

            case 'siteWhitelisted':
                removeAllBlurs();
                break;

            case 'blurSpecificImage':
                // Handle specific image blur
                break;

            case 'unblurSpecificImage':
                // Handle specific image unblur
                break;
        }
        sendResponse({ success: true });
    });

    // Remove all blurs
    function removeAllBlurs() {
        document.querySelectorAll('.halal-vision-wrapper').forEach(wrapper => {
            const img = wrapper.querySelector('img');
            if (img) {
                wrapper.parentNode.insertBefore(img, wrapper);
                wrapper.remove();
            }
        });

        document.querySelectorAll('.halal-vision-video-wrapper').forEach(wrapper => {
            const video = wrapper.querySelector('video');
            if (video) {
                wrapper.parentNode.insertBefore(video, wrapper);
                wrapper.remove();
            }
        });

        blurredElements.clear();
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

})();
