// BADSEED SOIL - Gateway Controller

document.addEventListener('DOMContentLoaded', () => {
    const cards = document.querySelectorAll('.card');
    const videoOverlay = document.getElementById('video-overlay');
    const transitionVideo = document.getElementById('transition-video');
    const loadingScreen = document.getElementById('loading-screen');
    const energyCanvas = document.getElementById('energy-canvas');
    const ctx = energyCanvas ? energyCanvas.getContext('2d') : null;

    let isTransitioning = false;
    let energyAnimationId = null;
    let particles = [];
    let tendrils = [];

    // Track iframe ready states
    const iframeReadyState = {
        voice: false,
        value: false,
        agent: false
    };

    // Current hover state for sync
    let currentHoveredCard = null;

    // ========== ANALYTICS SYSTEM ==========

    const ANALYTICS_ENDPOINT = '/.netlify/functions/analytics-track';

    // Generate or retrieve session ID
    const sessionId = (() => {
        let sid = sessionStorage.getItem('soil_session');
        if (!sid) {
            sid = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
            sessionStorage.setItem('soil_session', sid);
        }
        return sid;
    })();

    // Session start time for duration tracking
    const sessionStartTime = Date.now();

    // Track hover durations
    const hoverStartTimes = {};

    // Send analytics event
    function trackEvent(event, card = null, data = {}) {
        const payload = {
            event,
            page: 'gateway',
            card,
            data,
            sessionId,
            timestamp: Date.now()
        };

        // Use sendBeacon for reliability, especially on page exit
        if (navigator.sendBeacon) {
            navigator.sendBeacon(ANALYTICS_ENDPOINT, JSON.stringify(payload));
        } else {
            fetch(ANALYTICS_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true
            }).catch(() => {});
        }
    }

    // Track page view on load
    trackEvent('page_view');
    trackEvent('session_start');

    // Track page exit
    window.addEventListener('beforeunload', () => {
        const sessionDuration = Date.now() - sessionStartTime;
        trackEvent('page_exit', null, { duration: sessionDuration });
        trackEvent('session_end', null, { duration: sessionDuration });
    });

    // Track visibility changes (tab switches)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            trackEvent('page_hidden');
        } else {
            trackEvent('page_visible');
        }
    });

    // Load iframe content lazily
    cards.forEach(card => {
        const iframe = card.querySelector('iframe');
        const src = iframe.dataset.src;
        if (src) {
            iframe.src = src;
        }
    });

    // ========== IFRAME COMMUNICATION SYSTEM ==========

    // Listen for messages from iframes
    window.addEventListener('message', (event) => {
        // Validate message structure
        if (!event.data || !event.data.type) return;

        const { type, node, data } = event.data;

        switch (type) {
            case 'IFRAME_READY':
                // Mark iframe as loaded
                if (node && iframeReadyState.hasOwnProperty(node)) {
                    iframeReadyState[node] = true;
                    const card = document.querySelector(`[data-destination="${node}"]`);
                    if (card) {
                        card.classList.add('iframe-ready');
                    }
                    // Track iframe ready event
                    trackEvent('iframe_ready', node);
                    console.log(`[SOIL] ${node} iframe ready`);
                }
                break;

            case 'IFRAME_HOVER':
                // Iframe content is being hovered - pulse the seed glow
                if (data && data.hovering) {
                    pulseSeedGlow(true);
                    trackEvent('iframe_hover_start', node);
                } else {
                    pulseSeedGlow(false);
                    trackEvent('iframe_hover_end', node);
                }
                break;

            case 'IFRAME_PULSE':
                // Iframe requests a seed pulse effect
                triggerSeedPulse();
                break;
        }
    });

    // Send message to specific iframe
    function sendToIframe(destination, message) {
        const card = document.querySelector(`[data-destination="${destination}"]`);
        if (card) {
            const iframe = card.querySelector('iframe');
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage(message, '*');
            }
        }
    }

    // Send message to all iframes
    function broadcastToIframes(message) {
        cards.forEach(card => {
            const iframe = card.querySelector('iframe');
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage(message, '*');
            }
        });
    }

    // Seed glow pulse effect triggered by iframe hover
    const seedGlow = document.querySelector('.seed-glow');
    let glowPulseActive = false;

    function pulseSeedGlow(active) {
        if (!seedGlow) return;
        glowPulseActive = active;
        if (active) {
            seedGlow.classList.add('iframe-hover-pulse');
        } else {
            seedGlow.classList.remove('iframe-hover-pulse');
        }
    }

    function triggerSeedPulse() {
        if (!seedGlow) return;
        seedGlow.classList.add('iframe-trigger-pulse');
        setTimeout(() => {
            seedGlow.classList.remove('iframe-trigger-pulse');
        }, 600);
    }

    // Card hover events - notify iframes and track analytics
    cards.forEach(card => {
        const destination = card.dataset.destination;

        card.addEventListener('mouseenter', () => {
            currentHoveredCard = destination;
            hoverStartTimes[destination] = Date.now();

            // Track hover start
            trackEvent('card_hover_start', destination);

            // Notify the hovered iframe
            sendToIframe(destination, { type: 'PARENT_HOVER', hovering: true });
            // Notify all iframes which card is hovered
            broadcastToIframes({ type: 'CARD_HOVER', card: destination, hovering: true });
        });

        card.addEventListener('mouseleave', () => {
            // Calculate hover duration
            const hoverDuration = hoverStartTimes[destination]
                ? Date.now() - hoverStartTimes[destination]
                : 0;

            // Track hover end with duration
            trackEvent('card_hover_end', destination, { duration: hoverDuration });

            currentHoveredCard = null;
            delete hoverStartTimes[destination];

            sendToIframe(destination, { type: 'PARENT_HOVER', hovering: false });
            broadcastToIframes({ type: 'CARD_HOVER', card: destination, hovering: false });
        });
    });

    // Card click handler
    cards.forEach(card => {
        card.addEventListener('click', () => {
            if (isTransitioning) return;
            isTransitioning = true;

            const destination = card.dataset.destination;
            const videoSrc = card.dataset.video;
            const redirectUrl = card.dataset.url;

            // Track card click
            trackEvent('card_click', destination, { targetUrl: redirectUrl });

            startTransition(videoSrc, redirectUrl);
        });
    });

    // Transition sequence
    function startTransition(videoSrc, redirectUrl) {
        transitionVideo.src = '';

        transitionVideo.onloadeddata = null;
        transitionVideo.oncanplaythrough = null;
        transitionVideo.onended = null;
        transitionVideo.onerror = null;

        transitionVideo.oncanplaythrough = () => {
            transitionVideo.oncanplaythrough = null;
            videoOverlay.classList.remove('hidden');
            transitionVideo.play().catch(() => {
                videoOverlay.classList.add('hidden');
                showLoadingScreen(redirectUrl);
            });
        };

        transitionVideo.onended = () => {
            videoOverlay.classList.add('hidden');
            showLoadingScreen(redirectUrl);
        };

        transitionVideo.onerror = () => {
            videoOverlay.classList.add('hidden');
            showLoadingScreen(redirectUrl);
        };

        transitionVideo.src = videoSrc;
        transitionVideo.load();
    }

    // Show loading screen and redirect
    function showLoadingScreen(redirectUrl) {
        if (!loadingScreen.classList.contains('hidden')) return;

        loadingScreen.classList.remove('hidden');
        startEnergyEffect();

        // Start fade out 500ms before redirect
        setTimeout(() => {
            loadingScreen.classList.add('fading');
        }, 4000);

        setTimeout(() => {
            stopEnergyEffect();
            window.location.href = redirectUrl;
        }, 4500);
    }

    // ========== COSMIC ENERGY EFFECT ==========

    function resizeCanvas() {
        if (!energyCanvas) return;
        energyCanvas.width = window.innerWidth;
        energyCanvas.height = window.innerHeight;
    }

    // Particle class - glowing orbs that leave trails
    class Particle {
        constructor() {
            this.reset();
        }

        reset() {
            const centerX = window.innerWidth / 2;
            const centerY = window.innerHeight / 2;

            this.x = centerX;
            this.y = centerY;

            // Random direction
            const angle = Math.random() * Math.PI * 2;
            const speed = 2 + Math.random() * 6;
            this.vx = Math.cos(angle) * speed;
            this.vy = Math.sin(angle) * speed;

            // Properties
            this.size = 1 + Math.random() * 3;
            this.life = 1;
            this.decay = 0.003 + Math.random() * 0.008;
            this.trail = [];
            this.maxTrail = 30 + Math.floor(Math.random() * 40);
            this.hue = 0; // Silver/white
            this.brightness = 0.7 + Math.random() * 0.3;
        }

        update() {
            // Store trail position
            this.trail.push({ x: this.x, y: this.y, life: this.life });
            if (this.trail.length > this.maxTrail) {
                this.trail.shift();
            }

            // Slight curve/drift
            this.vx += (Math.random() - 0.5) * 0.1;
            this.vy += (Math.random() - 0.5) * 0.1;

            // Move
            this.x += this.vx;
            this.y += this.vy;

            // Fade out
            this.life -= this.decay;

            if (this.life <= 0) {
                this.reset();
            }
        }

        draw(ctx) {
            // Draw trail with gradient fade
            if (this.trail.length > 1) {
                for (let i = 1; i < this.trail.length; i++) {
                    const t = this.trail[i];
                    const prev = this.trail[i - 1];
                    const alpha = (i / this.trail.length) * t.life * this.brightness * 0.6;

                    ctx.beginPath();
                    ctx.moveTo(prev.x, prev.y);
                    ctx.lineTo(t.x, t.y);
                    ctx.strokeStyle = `rgba(192, 192, 192, ${alpha})`;
                    ctx.lineWidth = this.size * (i / this.trail.length);
                    ctx.lineCap = 'round';
                    ctx.stroke();
                }
            }

            // Draw particle head with glow
            const alpha = this.life * this.brightness;
            const gradient = ctx.createRadialGradient(
                this.x, this.y, 0,
                this.x, this.y, this.size * 4
            );
            gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
            gradient.addColorStop(0.3, `rgba(192, 192, 192, ${alpha * 0.6})`);
            gradient.addColorStop(1, 'rgba(192, 192, 192, 0)');

            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size * 4, 0, Math.PI * 2);
            ctx.fillStyle = gradient;
            ctx.fill();
        }
    }

    // Tendril class - organic flowing energy lines
    class Tendril {
        constructor() {
            this.reset();
        }

        reset() {
            const centerX = window.innerWidth / 2;
            const centerY = window.innerHeight / 2;

            this.points = [];
            this.angle = Math.random() * Math.PI * 2;
            this.length = 80 + Math.random() * 200;
            this.segments = 20 + Math.floor(Math.random() * 20);
            this.speed = 0.5 + Math.random() * 1.5;
            this.wave = Math.random() * Math.PI * 2;
            this.waveSpeed = 0.02 + Math.random() * 0.04;
            this.waveAmp = 10 + Math.random() * 30;
            this.life = 1;
            this.decay = 0.005 + Math.random() * 0.01;
            this.thickness = 1 + Math.random() * 2;
            this.distance = 0;
            this.maxDistance = Math.max(window.innerWidth, window.innerHeight) * 0.7;

            // Generate initial points from center
            for (let i = 0; i < this.segments; i++) {
                const t = i / this.segments;
                const dist = t * this.length;
                const waveOffset = Math.sin(this.wave + t * 4) * this.waveAmp * t;
                const perpAngle = this.angle + Math.PI / 2;

                this.points.push({
                    x: centerX + Math.cos(this.angle) * dist + Math.cos(perpAngle) * waveOffset,
                    y: centerY + Math.sin(this.angle) * dist + Math.sin(perpAngle) * waveOffset
                });
            }
        }

        update() {
            const centerX = window.innerWidth / 2;
            const centerY = window.innerHeight / 2;

            this.wave += this.waveSpeed;
            this.distance += this.speed;

            // Update points - flow outward with wave motion
            for (let i = 0; i < this.segments; i++) {
                const t = i / this.segments;
                const dist = this.distance + t * this.length;
                const waveOffset = Math.sin(this.wave + t * 4 + this.distance * 0.01) * this.waveAmp * t;
                const perpAngle = this.angle + Math.PI / 2;

                this.points[i] = {
                    x: centerX + Math.cos(this.angle) * dist + Math.cos(perpAngle) * waveOffset,
                    y: centerY + Math.sin(this.angle) * dist + Math.sin(perpAngle) * waveOffset
                };
            }

            // Fade as it reaches edge
            if (this.distance > this.maxDistance * 0.5) {
                this.life -= this.decay * 2;
            }

            if (this.life <= 0 || this.distance > this.maxDistance) {
                this.reset();
            }
        }

        draw(ctx) {
            if (this.points.length < 2) return;

            // Draw with gradient along length
            ctx.beginPath();
            ctx.moveTo(this.points[0].x, this.points[0].y);

            // Smooth curve through points
            for (let i = 1; i < this.points.length - 1; i++) {
                const xc = (this.points[i].x + this.points[i + 1].x) / 2;
                const yc = (this.points[i].y + this.points[i + 1].y) / 2;
                ctx.quadraticCurveTo(this.points[i].x, this.points[i].y, xc, yc);
            }

            // Draw with fading stroke
            const gradient = ctx.createLinearGradient(
                this.points[0].x, this.points[0].y,
                this.points[this.points.length - 1].x, this.points[this.points.length - 1].y
            );
            gradient.addColorStop(0, `rgba(192, 192, 192, ${this.life * 0.8})`);
            gradient.addColorStop(0.7, `rgba(192, 192, 192, ${this.life * 0.3})`);
            gradient.addColorStop(1, 'rgba(192, 192, 192, 0)');

            ctx.strokeStyle = gradient;
            ctx.lineWidth = this.thickness;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();

            // Glow effect
            ctx.shadowColor = 'rgba(192, 192, 192, 0.5)';
            ctx.shadowBlur = 10;
            ctx.stroke();
            ctx.shadowBlur = 0;
        }
    }

    // Burst class - explosive radial energy
    class Burst {
        constructor() {
            this.rays = [];
            this.life = 1;
            this.decay = 0.015;
            this.init();
        }

        init() {
            const centerX = window.innerWidth / 2;
            const centerY = window.innerHeight / 2;
            const numRays = 12 + Math.floor(Math.random() * 12);
            const maxLen = Math.max(window.innerWidth, window.innerHeight) * 0.6;

            for (let i = 0; i < numRays; i++) {
                const angle = (i / numRays) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
                const length = maxLen * (0.3 + Math.random() * 0.7);
                const speed = 3 + Math.random() * 5;

                this.rays.push({
                    angle,
                    length,
                    currentLen: 0,
                    speed,
                    thickness: 1 + Math.random() * 2,
                    centerX,
                    centerY
                });
            }
        }

        update() {
            this.life -= this.decay;

            for (const ray of this.rays) {
                if (ray.currentLen < ray.length) {
                    ray.currentLen += ray.speed * 3;
                }
            }

            return this.life > 0;
        }

        draw(ctx) {
            for (const ray of this.rays) {
                const endX = ray.centerX + Math.cos(ray.angle) * ray.currentLen;
                const endY = ray.centerY + Math.sin(ray.angle) * ray.currentLen;

                const gradient = ctx.createLinearGradient(
                    ray.centerX, ray.centerY, endX, endY
                );
                gradient.addColorStop(0, `rgba(255, 255, 255, ${this.life * 0.9})`);
                gradient.addColorStop(0.3, `rgba(192, 192, 192, ${this.life * 0.6})`);
                gradient.addColorStop(1, 'rgba(192, 192, 192, 0)');

                ctx.beginPath();
                ctx.moveTo(ray.centerX, ray.centerY);
                ctx.lineTo(endX, endY);
                ctx.strokeStyle = gradient;
                ctx.lineWidth = ray.thickness * this.life;
                ctx.lineCap = 'round';
                ctx.stroke();
            }
        }
    }

    let bursts = [];
    let burstTimer = 0;

    function startEnergyEffect() {
        if (!ctx) return;

        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        particles = [];
        tendrils = [];
        bursts = [];
        burstTimer = 0;

        // Create initial particles
        for (let i = 0; i < 40; i++) {
            particles.push(new Particle());
        }

        // Create initial tendrils
        for (let i = 0; i < 10; i++) {
            tendrils.push(new Tendril());
        }

        // Initial burst
        bursts.push(new Burst());

        lastFrameTime = performance.now();
        animateEnergy(lastFrameTime);
    }

    function stopEnergyEffect() {
        if (energyAnimationId) {
            cancelAnimationFrame(energyAnimationId);
            energyAnimationId = null;
        }
        window.removeEventListener('resize', resizeCanvas);
        particles = [];
        tendrils = [];
        bursts = [];
    }

    let lastFrameTime = 0;
    const targetFPS = 60;
    const frameInterval = 1000 / targetFPS;

    function animateEnergy(currentTime) {
        if (!ctx) return;

        energyAnimationId = requestAnimationFrame(animateEnergy);

        // Throttle to target FPS for smoother animation
        const deltaTime = currentTime - lastFrameTime;
        if (deltaTime < frameInterval) return;
        lastFrameTime = currentTime - (deltaTime % frameInterval);

        // Fade effect - creates trails (slightly faster fade for cleaner look)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
        ctx.fillRect(0, 0, energyCanvas.width, energyCanvas.height);

        // Occasional bursts
        burstTimer++;
        if (burstTimer > 90 && Math.random() < 0.015) {
            bursts.push(new Burst());
            burstTimer = 0;
        }

        // Update and draw bursts
        bursts = bursts.filter(burst => {
            burst.update();
            burst.draw(ctx);
            return burst.life > 0;
        });

        // Update and draw tendrils
        for (const tendril of tendrils) {
            tendril.update();
            tendril.draw(ctx);
        }

        // Update and draw particles
        for (const particle of particles) {
            particle.update();
            particle.draw(ctx);
        }

        // Add subtle center glow
        const centerX = energyCanvas.width / 2;
        const centerY = energyCanvas.height / 2;
        const glowGradient = ctx.createRadialGradient(
            centerX, centerY, 0,
            centerX, centerY, 100
        );
        glowGradient.addColorStop(0, 'rgba(192, 192, 192, 0.12)');
        glowGradient.addColorStop(0.5, 'rgba(192, 192, 192, 0.04)');
        glowGradient.addColorStop(1, 'rgba(192, 192, 192, 0)');

        ctx.beginPath();
        ctx.arc(centerX, centerY, 100, 0, Math.PI * 2);
        ctx.fillStyle = glowGradient;
        ctx.fill();
    }

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        const focusedCard = document.activeElement;
        if (focusedCard && focusedCard.classList.contains('card')) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                focusedCard.click();
            }
        }
    });

    // Make cards focusable
    cards.forEach(card => {
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'button');
    });
});
