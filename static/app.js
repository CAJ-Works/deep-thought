// Deep Thought Frontend Engine
let currentPIN = "";
let currentUser = "";
let activeThoughts = [];
let dbCategories = new Set();

// Media Recording variables
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyserNode = null;
let animationFrameId = null;
let recordingStartTime = null;
let recordingInterval = null;

// Graph Visualization variables
let graphData = { nodes: [], edges: [] };
let selectedNode = null;
let isDraggingNode = false;
let canvasScale = 1.0;
let canvasOffset = { x: 0, y: 0 };
let canvasTextColor = "#f1f3f9";
let canvasEdgeColor = "rgba(108, 92, 231, 0.25)";

// Geolocation state
let userCoordinates = null;
let isLocationActive = false;
let processingPollInterval = null;

// ----------------------------------------------------
// Page Initialization & Auth Checks
// ----------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
    // Apply cached theme immediately on load
    const cachedTheme = localStorage.getItem("deep_thought_theme") || "default";
    applyTheme(cachedTheme);

    detectSubdomain();
    checkAuthStatus();
    setupAuthKeypad();
    setupCaptureEvents();
    setupFilterEvents();
    setupModalEvents();
    setupGraphEvents();
    setupSettingsEvents();
});

function detectSubdomain() {
    const host = window.location.host;
    const parts = host.split(":")[0].split(".");
    let subdomain = "chris";
    
    // Check if accessing via an IP address to avoid setting subdomain to "127"
    const isIP = parts.length === 4 && parts.every(part => /^\d+$/.test(part));
    
    if (parts.length >= 3 && !isIP) {
        const prefix = parts[0].toLowerCase();
        if (prefix !== "www" && prefix !== "api" && prefix !== "app") {
            subdomain = prefix;
        }
    }
    currentUser = subdomain;
    const wsName = document.getElementById("workspace-name");
    if (wsName) wsName.textContent = subdomain;
    const userBadge = document.getElementById("user-badge");
    if (userBadge) userBadge.textContent = subdomain;
}

async function checkAuthStatus() {
    try {
        const response = await fetch("/api/auth/me");
        if (response.ok) {
            const data = await response.json();
            showWorkspace(data.username, data.theme, data.location_enabled);
        } else {
            showAuthScreen();
        }
    } catch (e) {
        showAuthScreen();
    }
}

function showAuthScreen() {
    document.getElementById("auth-screen").style.display = "flex";
    document.getElementById("app-workspace").style.display = "none";
    if (processingPollInterval) {
        clearInterval(processingPollInterval);
        processingPollInterval = null;
    }
}

function showWorkspace(username, theme, location_enabled) {
    document.getElementById("auth-screen").style.display = "none";
    document.getElementById("app-workspace").style.display = "";
    document.getElementById("user-badge").textContent = username;
    applyTheme(theme || "default");
    
    if (location_enabled !== undefined) {
        localStorage.setItem("deep_thought_location_enabled", location_enabled);
    }
    applyLocationPreference();
    
    loadDashboard();
}

function applyLocationPreference() {
    const enabled = localStorage.getItem("deep_thought_location_enabled") === "true";
    const locToggle = document.getElementById("location-toggle");
    
    if (enabled) {
        if ("geolocation" in navigator) {
            document.getElementById("location-status").textContent = "Location ⏳";
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    userCoordinates = {
                        lat: position.coords.latitude,
                        lon: position.coords.longitude
                    };
                    isLocationActive = true;
                    if (locToggle) locToggle.classList.add("active");
                    document.getElementById("location-status").textContent = "Location ✅";
                },
                (error) => {
                    isLocationActive = false;
                    if (locToggle) locToggle.classList.remove("active");
                    document.getElementById("location-status").textContent = "Location ❌";
                }
            );
        } else {
            document.getElementById("location-status").textContent = "Location ❌";
        }
    } else {
        userCoordinates = null;
        isLocationActive = false;
        if (locToggle) {
            locToggle.classList.remove("active");
            document.getElementById("location-status").textContent = "Location ❌";
        }
    }
}

// ----------------------------------------------------
// Keypad Login Handlers
// ----------------------------------------------------

function setupAuthKeypad() {
    const dots = document.querySelectorAll(".pin-dot");
    const errorMsg = document.getElementById("auth-error-msg");
    
    // Keypad numeric clicks
    document.querySelectorAll(".keypad-grid .key-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            errorMsg.textContent = "";
            dots.forEach(d => d.classList.remove("error"));
            
            if (btn.id === "key-clear") {
                currentPIN = "";
            } else if (btn.id === "key-back") {
                currentPIN = currentPIN.slice(0, -1);
            } else {
                const val = btn.getAttribute("data-val");
                if (val && currentPIN.length < 4) {
                    currentPIN += val;
                }
            }
            updatePinDots();
        });
    });
    
    document.getElementById("auth-submit").addEventListener("click", submitPinLogin);
}

function updatePinDots() {
    const dots = document.querySelectorAll(".pin-dot");
    dots.forEach((dot, idx) => {
        if (idx < currentPIN.length) {
            dot.classList.add("active");
        } else {
            dot.classList.remove("active");
        }
    });
}

async function submitPinLogin() {
    if (currentPIN.length < 4) {
        showAuthError("Please enter a 4-digit PIN.");
        return;
    }
    
    const remember = document.getElementById("remember-device").checked;
    const errorMsg = document.getElementById("auth-error-msg");
    
    try {
        const response = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: currentPIN, remember: remember })
        });
        
        if (response.ok) {
            const data = await response.json();
            currentPIN = "";
            updatePinDots();
            showWorkspace(data.username, data.theme, data.location_enabled);
        } else {
            const data = await response.json();
            currentPIN = "";
            updatePinDots();
            showAuthError(data.detail || "Authentication failed.");
            
            // If locked, trigger countdown or visual errors
            if (response.status === 423) {
                disableKeypadTemp(90);
            }
        }
    } catch (e) {
        showAuthError("Network error. Failed to reach Mac Mini.");
    }
}

function showAuthError(msg) {
    const errorMsg = document.getElementById("auth-error-msg");
    errorMsg.textContent = msg;
    document.querySelectorAll(".pin-dot").forEach(d => {
        d.classList.remove("active");
        d.classList.add("error");
    });
}

function disableKeypadTemp(seconds) {
    const submitBtn = document.getElementById("auth-submit");
    submitBtn.disabled = true;
    let time = seconds;
    const interval = setInterval(() => {
        time--;
        submitBtn.textContent = `Locked (${time}s)`;
        if (time <= 0) {
            clearInterval(interval);
            submitBtn.disabled = false;
            submitBtn.textContent = "Unlock Console";
            document.getElementById("auth-error-msg").textContent = "";
            document.querySelectorAll(".pin-dot").forEach(d => d.classList.remove("error"));
        }
    }, 1000);
}

// Logout handler
document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    showAuthScreen();
});

// ----------------------------------------------------
// Geolocation Support
// ----------------------------------------------------

function setupCaptureEvents() {
    const locToggle = document.getElementById("location-toggle");
    
    locToggle.addEventListener("click", () => {
        if (!isLocationActive) {
            // Activate location tagging
            if ("geolocation" in navigator) {
                document.getElementById("location-status").textContent = "Location ⏳";
                navigator.geolocation.getCurrentPosition(
                    (position) => {
                        userCoordinates = {
                            lat: position.coords.latitude,
                            lon: position.coords.longitude
                        };
                        isLocationActive = true;
                        locToggle.classList.add("active");
                        document.getElementById("location-status").textContent = "Location ✅";
                    },
                    (error) => {
                        isLocationActive = false;
                        locToggle.classList.remove("active");
                        document.getElementById("location-status").textContent = "Location ❌";
                        logger.warning("GPS access error: " + error.message);
                    }
                );
            } else {
                document.getElementById("location-status").textContent = "Location ❌";
            }
        } else {
            // Turn off location tagging
            userCoordinates = null;
            isLocationActive = false;
            locToggle.classList.remove("active");
            document.getElementById("location-status").textContent = "Location ❌";
        }
    });

    // Capture thought submit
    document.getElementById("submit-btn").addEventListener("click", submitTextThought);
    
    // Voice Capture toggle
    document.getElementById("voice-btn").addEventListener("click", toggleVoiceRecording);
}

// ----------------------------------------------------
// UI Form Submissions (Text & Audio)
// ----------------------------------------------------

async function submitTextThought() {
    const textarea = document.getElementById("thought-input");
    const content = textarea.value.strip ? textarea.value.strip() : textarea.value.trim();
    if (!content) return;
    
    const payload = {
        content: content,
        latitude: userCoordinates ? userCoordinates.lat : null,
        longitude: userCoordinates ? userCoordinates.lon : null,
        location_name: userCoordinates ? "Captured coordinates" : null
    };
    
    try {
        const response = await fetch("/api/thoughts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            textarea.value = "";
            loadDashboard();
        }
    } catch (e) {
        alert("Failed to submit thought entry.");
    }
}

async function toggleVoiceRecording() {
    const voiceBtn = document.getElementById("voice-btn");
    const voiceText = document.getElementById("voice-btn-text");
    
    if (mediaRecorder && mediaRecorder.state === "recording") {
        // Stop recording
        mediaRecorder.stop();
        voiceBtn.classList.remove("recording");
        if (voiceText) voiceText.textContent = "Voice Note";
        stopWaveformVisualizer();
        return;
    }
    
    // Start Recording
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        mediaRecorder = new MediaRecorder(stream);
        
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };
        
        mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(track => track.stop());
            document.getElementById("waveform-container").classList.remove("active");
            
            const audioBlob = new Blob(audioChunks, { type: "audio/wav" });
            if (audioBlob.size > 1000) {
                await uploadVoiceThought(audioBlob);
            }
        };
        
        mediaRecorder.start();
        voiceBtn.classList.add("recording");
        if (voiceText) voiceText.textContent = "Recording...";
        document.getElementById("waveform-container").classList.add("active");
        
        startWaveformVisualizer(stream);
    } catch (e) {
        alert("Failed to access microphone. Permission might be denied.");
    }
}

async function uploadVoiceThought(audioBlob) {
    const formData = new FormData();
    formData.append("file", audioBlob, "voice_thought.wav");
    
    if (userCoordinates) {
        formData.append("latitude", userCoordinates.lat);
        formData.append("longitude", userCoordinates.lon);
        formData.append("location_name", "Captured coordinates");
    }
    
    // Display visual loading spinner
    const timeline = document.getElementById("timeline-list");
    timeline.innerHTML = `<div class="loading-spinner">Transcribing voice thought via Gemini...</div>`;
    
    try {
        const response = await fetch("/api/thoughts/voice", {
            method: "POST",
            body: formData
        });
        
        if (response.ok) {
            loadDashboard();
        } else {
            const data = await response.json();
            alert(data.detail || "Transcription error.");
            loadDashboard();
        }
    } catch (e) {
        alert("Failed to upload audio file.");
        loadDashboard();
    }
}

// ----------------------------------------------------
// Recording Waveform Canvas Visualizer
// ----------------------------------------------------

function startWaveformVisualizer(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 128;
    source.connect(analyserNode);
    
    const canvas = document.getElementById("waveform-canvas");
    const ctx = canvas.getContext("2d");
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    recordingStartTime = Date.now();
    recordingInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');
        document.getElementById("recording-timer").textContent = `${mins}:${secs}`;
    }, 1000);
    
    function draw() {
        animationFrameId = requestAnimationFrame(draw);
        analyserNode.getByteFrequencyData(dataArray);
        
        ctx.fillStyle = "#07090e";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        const barWidth = (canvas.width / bufferLength) * 1.5;
        let barHeight;
        let x = 0;
        
        for (let i = 0; i < bufferLength; i++) {
            barHeight = dataArray[i] / 2.5;
            
            // Draw gradient bars
            ctx.fillStyle = `rgb(108, 92, ${dataArray[i] + 100})`;
            ctx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);
            
            x += barWidth;
        }
    }
    
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    draw();
}

function stopWaveformVisualizer() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (recordingInterval) clearInterval(recordingInterval);
    if (audioContext) audioContext.close();
    
    document.getElementById("recording-timer").textContent = "00:00";
    mediaRecorder = null;
}

// ----------------------------------------------------
// Fetch & Render Timeline Feed
// ----------------------------------------------------

async function loadDashboard() {
    await fetchThoughts();
    await fetchGraphData();
}

async function fetchThoughts() {
    const search = document.getElementById("search-input").value;
    const category = document.getElementById("category-filter").value;
    
    let url = "/api/thoughts?";
    if (search) url += `search=${encodeURIComponent(search)}&`;
    if (category) url += `category=${encodeURIComponent(category)}&`;
    
    try {
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            activeThoughts = data;
            renderTimeline();
            populateCategoryFilter();
        }
    } catch (e) {
        console.error("Failed to load thoughts list.");
    }
}

function renderTimeline() {
    const list = document.getElementById("timeline-list");
    let unprocessedCount = 0;
    
    if (activeThoughts.length === 0) {
        list.innerHTML = `<div class="loading-spinner">No thought entries matches the criteria.</div>`;
        document.getElementById("unprocessed-count").textContent = "0";
        return;
    }
    
    list.innerHTML = "";
    activeThoughts.forEach(t => {
        if (!t.processed) unprocessedCount++;
        
        const dateStr = new Date(t.created_at).toLocaleString();
        const card = document.createElement("div");
        card.className = "thought-card";
        card.innerHTML = `
            <div class="thought-card-header">
                <span class="thought-date">${dateStr}</span>
                <div class="badges-row">
                    ${t.category ? `<span class="badge badge-category">${t.category}</span>` : ""}
                    ${t.processed ? `<span class="badge badge-success">Enriched</span>` : `<span class="badge badge-pending">Processing</span>`}
                    ${t.web_references && t.web_references.length > 0 ? `<span class="badge badge-updates">${t.web_references.length} Links</span>` : ""}
                </div>
            </div>
            <p class="thought-content">${t.content}</p>
            <div class="thought-card-footer">
                <span class="location-tag">
                    <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    </svg>
                    ${t.latitude && t.longitude ? `<a href="https://www.google.com/maps/search/?api=1&query=${t.latitude},${t.longitude}" target="_blank" class="location-link" title="Open in Google Maps">${t.location_name || "Captured Location"}</a>` : (t.location_name || "Self-hosted Mini")}
                </span>
                <div class="card-actions">
                    <span class="action-link reprocess-action" data-id="${t.id}" title="Re-run enrichment">Reprocess</span>
                    <span class="action-link delete-action" data-id="${t.id}" title="Delete thought">Delete</span>
                </div>
            </div>
        `;
        
        // Modal trigger on card click (except click on delete/reprocess/location actions)
        card.addEventListener("click", (e) => {
            if (e.target.classList.contains("action-link") || e.target.classList.contains("location-link") || e.target.closest(".location-link")) return;
            openThoughtDetails(t.id);
        });
        
        // Attach actions click listeners
        card.querySelector(".delete-action").addEventListener("click", async (e) => {
            e.stopPropagation();
            if (confirm("Delete this thought permanently?")) {
                await fetch(`/api/thoughts/${t.id}`, { method: "DELETE" });
                loadDashboard();
            }
        });
        
        card.querySelector(".reprocess-action").addEventListener("click", async (e) => {
            e.stopPropagation();
            await fetch(`/api/thoughts/${t.id}/process`, { method: "POST" });
            loadDashboard();
        });
        
        list.appendChild(card);
    });
    
    document.getElementById("unprocessed-count").textContent = unprocessedCount;
    
    // Auto-polling for processing/enrichment background tasks
    if (unprocessedCount > 0) {
        if (!processingPollInterval) {
            processingPollInterval = setInterval(async () => {
                await fetchThoughts();
                await fetchGraphData();
            }, 3000); // Check status every 3 seconds
        }
    } else {
        if (processingPollInterval) {
            clearInterval(processingPollInterval);
            processingPollInterval = null;
        }
    }
}

function populateCategoryFilter() {
    const filter = document.getElementById("category-filter");
    const currentVal = filter.value;
    
    // Extract unique categories
    const categories = new Set();
    activeThoughts.forEach(t => {
        if (t.category) categories.add(t.category);
    });
    
    filter.innerHTML = `<option value="">All Categories</option>`;
    categories.forEach(cat => {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        if (cat === currentVal) opt.selected = true;
        filter.appendChild(opt);
    });
}

function setupFilterEvents() {
    document.getElementById("search-input").addEventListener("input", fetchThoughts);
    document.getElementById("category-filter").addEventListener("change", fetchThoughts);
}

// ----------------------------------------------------
// Detailed Thought Modal Views
// ----------------------------------------------------

function setupModalEvents() {
    document.getElementById("close-modal").addEventListener("click", closeModal);
    document.getElementById("details-modal").addEventListener("click", (e) => {
        if (e.target.id === "details-modal") closeModal();
    });
}

function closeModal() {
    document.getElementById("details-modal").classList.remove("active");
}

async function openThoughtDetails(thought_id) {
    try {
        const response = await fetch(`/api/thoughts/${thought_id}`);
        if (!response.ok) return;
        
        const data = await response.json();
        const modal = document.getElementById("details-modal");
        const body = document.getElementById("modal-body");
        
        document.getElementById("modal-title").textContent = `Thought Details — ${new Date(data.created_at).toLocaleString()}`;
        
        // Assemble modal HTML content
        let webRefsHtml = "";
        if (data.web_references && data.web_references.length > 0) {
            webRefsHtml = `
                <div class="detail-section">
                    <h4>Web Context References</h4>
                    <div class="web-ref-list">
                        ${data.web_references.map(ref => `
                            <div class="web-ref-item">
                                <a href="${ref.url}" target="_blank">${ref.title || ref.url}</a>
                                <p>${ref.snippet || "No preview text available."}</p>
                            </div>
                        `).join("")}
                    </div>
                </div>
            `;
        }
        
        let linksHtml = "";
        if (data.links && data.links.length > 0) {
            linksHtml = `
                <div class="detail-section">
                    <h4>Thematic Connection Mappings</h4>
                    <div class="thematic-links-list">
                        ${data.links.map(l => {
                            const otherId = l.source_id === data.id ? l.target_id : l.source_id;
                            const otherThought = activeThoughts.find(at => at.id === otherId);
                            const otherLabel = otherThought ? otherThought.content.substring(0, 30) + "..." : `Thought #${otherId}`;
                            return `
                                <div class="thematic-link-item">
                                    <span>Connected to: <strong>${otherLabel}</strong></span>
                                    <span class="badge badge-updates">Sim: ${l.similarity_score}</span>
                                </div>
                            `;
                        }).join("")}
                    </div>
                </div>
            `;
        }
        
        let locationHtml = "";
        if (data.location_name || (data.latitude && data.longitude)) {
            const displayLoc = data.location_name || "Self-hosted Mini";
            const mapsLink = data.latitude && data.longitude ? 
                ` (<a href="https://www.google.com/maps/search/?api=1&query=${data.latitude},${data.longitude}" target="_blank" class="location-link">Open in Google Maps</a>)` : "";
            const coordsStr = data.latitude && data.longitude ? 
                `<br><span style="font-size: 0.8rem; color: var(--text-muted);">Coordinates: ${data.latitude.toFixed(6)}, ${data.longitude.toFixed(6)}</span>` : "";
                
            locationHtml = `
                <div class="detail-section">
                    <h4>Captured Location</h4>
                    <p class="detail-text" style="font-size: 0.9rem;">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" style="vertical-align: middle; margin-right: 4px;">
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                            <circle cx="12" cy="10" r="3"></circle>
                        </svg>
                        <span>${displayLoc}</span>${mapsLink}${coordsStr}
                    </p>
                </div>
            `;
        }
        
        body.innerHTML = `
            <div class="detail-section">
                <h4>Raw Captured Thought</h4>
                <p class="detail-text">${data.content}</p>
            </div>
            
            ${locationHtml}
            
            <div class="detail-section">
                <h4>AI Structured Summary</h4>
                <div class="detail-summary">
                    ${data.enrichment_summary ? data.enrichment_summary : "AI model deep enrichment currently in progress. It runs nightly or when triggered manually."}
                </div>
            </div>
            
            ${webRefsHtml}
            ${linksHtml}
        `;
        
        modal.classList.add("active");
    } catch (e) {
        console.error("Failed to load details modal: " + e);
    }
}

// ----------------------------------------------------
// Force-Directed Graph Layout Visualizer
// ----------------------------------------------------

async function fetchGraphData() {
    try {
        const response = await fetch("/api/graph");
        if (response.ok) {
            const data = await response.json();
            graphData = data;
            initGraph();
        }
    } catch (e) {
        console.error("Failed to fetch graph details.");
    }
}

function initGraph() {
    const canvas = document.getElementById("network-canvas");
    const ctx = canvas.getContext("2d");
    
    // Scale canvas to match pixel ratio
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);
    
    // Assign random initial positions to nodes if they don't have them
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    
    graphData.nodes.forEach(node => {
        if (node.x === undefined) {
            node.x = Math.random() * (width - 100) + 50;
            node.y = Math.random() * (height - 100) + 50;
            node.vx = 0;
            node.vy = 0;
        }
    });
    
    // Custom force loop script
    function updatePhysics() {
        const k = 0.04; // Spring strength
        const rep = 800; // Repulsion strength
        const gravity = 0.01;
        
        // 1. Repulsion between all nodes
        for (let i = 0; i < graphData.nodes.length; i++) {
            let n1 = graphData.nodes[i];
            for (let j = i + 1; j < graphData.nodes.length; j++) {
                let n2 = graphData.nodes[j];
                let dx = n2.x - n1.x;
                let dy = n2.y - n1.y;
                let dist = Math.sqrt(dx*dx + dy*dy) || 1;
                
                if (dist < 250) {
                    let force = rep / (dist * dist);
                    let fx = (dx / dist) * force;
                    let fy = (dy / dist) * force;
                    
                    n1.vx -= fx;
                    n1.vy -= fy;
                    n2.vx += fx;
                    n2.vy += fy;
                }
            }
        }
        
        // 2. Attraction of links
        graphData.edges.forEach(edge => {
            let n1 = graphData.nodes.find(n => n.id === edge.source);
            let n2 = graphData.nodes.find(n => n.id === edge.target);
            if (!n1 || !n2) return;
            
            let dx = n2.x - n1.x;
            let dy = n2.y - n1.y;
            let dist = Math.sqrt(dx*dx + dy*dy) || 1;
            
            // Hooke's Law: F = -k * x
            let force = k * (dist - 100);
            let fx = (dx / dist) * force;
            let fy = (dy / dist) * force;
            
            n1.vx += fx;
            n1.vy += fy;
            n2.vx -= fx;
            n2.vy -= fy;
        });
        
        // 3. Gravity pulling to center and updating positions
        const cx = width / 2;
        const cy = height / 2;
        
        graphData.nodes.forEach(node => {
            if (node === selectedNode && isDraggingNode) return;
            
            // Gravity
            node.vx += (cx - node.x) * gravity;
            node.vy += (cy - node.y) * gravity;
            
            // Apply velocities with friction
            node.vx *= 0.85;
            node.vy *= 0.85;
            node.x += node.vx;
            node.y += node.vy;
            
            // Containment
            node.x = Math.max(15, Math.min(width - 15, node.x));
            node.y = Math.max(15, Math.min(height - 15, node.y));
        });
    }
    
    function drawGraph() {
        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(canvasOffset.x, canvasOffset.y);
        ctx.scale(canvasScale, canvasScale);
        
        // Draw links
        graphData.edges.forEach(edge => {
            let n1 = graphData.nodes.find(n => n.id === edge.source);
            let n2 = graphData.nodes.find(n => n.id === edge.target);
            if (!n1 || !n2) return;
            
            ctx.beginPath();
            ctx.moveTo(n1.x, n1.y);
            ctx.lineTo(n2.x, n2.y);
            ctx.strokeStyle = canvasEdgeColor;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });
        
        // Draw nodes
        graphData.nodes.forEach(node => {
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.size, 0, 2 * Math.PI);
            
            // Node color by category
            let color = "#a55eea"; // General
            if (node.category.toLowerCase().includes("research")) color = "#00cec9";
            else if (node.category.toLowerCase().includes("idea")) color = "#fd9644";
            else if (node.category.toLowerCase().includes("todo")) color = "#fc5c65";
            
            ctx.fillStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = 6;
            ctx.fill();
            ctx.shadowBlur = 0; // Reset
            
            // Label
            ctx.fillStyle = canvasTextColor;
            ctx.font = "10px Plus Jakarta Sans";
            ctx.textAlign = "center";
            ctx.fillText(node.label, node.x, node.y - node.size - 4);
        });
        
        ctx.restore();
    }
    
    function animate() {
        if (graphData.nodes.length === 0) return;
        updatePhysics();
        drawGraph();
        requestAnimationFrame(animate);
    }
    
    animate();
}

function setupGraphEvents() {
    const canvas = document.getElementById("network-canvas");
    
    canvas.addEventListener("mousedown", (e) => {
        const rect = canvas.getBoundingClientRect();
        const mouseX = (e.clientX - rect.left - canvasOffset.x) / canvasScale;
        const mouseY = (e.clientY - rect.top - canvasOffset.y) / canvasScale;
        
        // Check if clicked a node
        selectedNode = graphData.nodes.find(node => {
            let dist = Math.sqrt((node.x - mouseX)**2 + (node.y - mouseY)**2);
            return dist <= node.size + 5;
        });
        
        if (selectedNode) {
            isDraggingNode = true;
        }
    });
    
    canvas.addEventListener("mousemove", (e) => {
        if (isDraggingNode && selectedNode) {
            const rect = canvas.getBoundingClientRect();
            selectedNode.x = (e.clientX - rect.left - canvasOffset.x) / canvasScale;
            selectedNode.y = (e.clientY - rect.top - canvasOffset.y) / canvasScale;
        }
    });
    
    window.addEventListener("mouseup", (e) => {
        if (isDraggingNode && selectedNode) {
            // Click trigger if drag was negligible
            isDraggingNode = false;
            openThoughtDetails(selectedNode.id);
            selectedNode = null;
        }
    });
    
    document.getElementById("reset-graph-btn").addEventListener("click", () => {
        canvasScale = 1.0;
        canvasOffset = { x: 0, y: 0 };
        graphData.nodes.forEach(n => {
            n.x = undefined; // Force physics reset
        });
        fetchGraphData();
    });
}

function applyTheme(themeName) {
    if (themeName && themeName !== "default") {
        document.body.setAttribute("data-theme", themeName);
    } else {
        document.body.removeAttribute("data-theme");
    }
    localStorage.setItem("deep_thought_theme", themeName || "default");
    
    document.querySelectorAll(".theme-option").forEach(opt => {
        if (opt.getAttribute("data-theme") === (themeName || "default")) {
            opt.classList.add("active");
        } else {
            opt.classList.remove("active");
        }
    });

    // Update dynamic canvas theme-derived colors after styles are applied
    setTimeout(() => {
        const bodyStyles = getComputedStyle(document.body);
        canvasTextColor = bodyStyles.getPropertyValue("--text-primary").trim() || "#f1f3f9";
        canvasEdgeColor = bodyStyles.getPropertyValue("--border-color-hover").trim() || "rgba(108, 92, 231, 0.25)";
    }, 50);
}

function setupSettingsEvents() {
    const settingsBtn = document.getElementById("settings-btn");
    const settingsModal = document.getElementById("settings-modal");
    const closeSettingsBtn = document.getElementById("close-settings");
    const saveSettingsBtn = document.getElementById("save-settings-btn");
    
    const newPinInput = document.getElementById("new-pin-input");
    const confirmPinInput = document.getElementById("confirm-pin-input");
    const pinError = document.getElementById("settings-pin-error");
    
    if (settingsBtn) {
        settingsBtn.addEventListener("click", () => {
            newPinInput.value = "";
            confirmPinInput.value = "";
            pinError.textContent = "";
            
            const currentTheme = localStorage.getItem("deep_thought_theme") || "default";
            applyTheme(currentTheme);
            
            // Sync location preference checkbox
            const locCheckbox = document.getElementById("settings-location-enabled");
            if (locCheckbox) {
                locCheckbox.checked = localStorage.getItem("deep_thought_location_enabled") === "true";
            }
            
            settingsModal.classList.add("active");
        });
    }
    
    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener("click", () => {
            settingsModal.classList.remove("active");
        });
    }
    
    document.querySelectorAll(".theme-option").forEach(opt => {
        opt.addEventListener("click", () => {
            const selectedTheme = opt.getAttribute("data-theme");
            applyTheme(selectedTheme);
        });
    });
    
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener("click", async () => {
            pinError.textContent = "";
            const newPin = newPinInput.value.trim();
            const confirmPin = confirmPinInput.value.trim();
            const selectedTheme = localStorage.getItem("deep_thought_theme") || "default";
            
            // Read default location preference checkbox status
            const locCheckbox = document.getElementById("settings-location-enabled");
            const locationEnabled = locCheckbox ? locCheckbox.checked : false;
            
            const payload = { 
                theme: selectedTheme,
                location_enabled: locationEnabled
            };
            
            if (newPin || confirmPin) {
                if (newPin !== confirmPin) {
                    pinError.textContent = "PINs do not match.";
                    return;
                }
                if (newPin.length !== 4 || !/^\d{4}$/.test(newPin)) {
                    pinError.textContent = "PIN must be exactly 4 digits.";
                    return;
                }
                payload.pin = newPin;
            }
            
            try {
                const response = await fetch("/api/user/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                
                if (response.ok) {
                    alert("Settings updated successfully!");
                    localStorage.setItem("deep_thought_location_enabled", locationEnabled);
                    applyLocationPreference();
                    settingsModal.classList.remove("active");
                } else {
                    const data = await response.json();
                    pinError.textContent = data.detail || "Failed to save settings.";
                }
            } catch (e) {
                pinError.textContent = "Network error. Failed to save settings.";
            }
        });
    }
}
