// Deep Thought Frontend Engine
window.addEventListener("error", (e) => {
    const errorMsg = `JS Error: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`;
    console.error(errorMsg);
    fetch(`/api/log_error?msg=${encodeURIComponent(errorMsg)}`).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
    const errorMsg = `JS Unhandled Promise Rejection: ${e.reason}`;
    console.error(errorMsg);
    fetch(`/api/log_error?msg=${encodeURIComponent(errorMsg)}`).catch(() => {});
});

let currentPIN = "";
let currentUser = "";
let activeThoughts = [];
let dbCategories = new Set();

// Speech Recognition variables
let recognition = null;
let isRecordingSpeech = false;
let visualizerStream = null;
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

// Map state variables
let thoughtMap = null;
let mapMarkers = [];

// Calendar state variables
let currentCalendarDate = new Date();
let selectedCalendarDate = null;

// Geolocation state
let userCoordinates = null;
let isLocationActive = false;
let processingPollInterval = null;

// Markdown formatter utility
function formatMarkdown(text) {
    if (!text) return "";
    let escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
        
    // Convert bold **text**
    escaped = escaped.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    
    // Convert markdown links [label](url)
    escaped = escaped.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" style="color: var(--primary-color); text-decoration: underline;">$1</a>');
    
    // Convert bullet points starting with - or *
    escaped = escaped.replace(/^(?:[-*]|\d+\.)\s+(.*?)$/gm, "<li>$1</li>");
    
    // Wrap lists in <ul> tags (using [\s\S] instead of dotAll /s flag for universal browser compatibility)
    escaped = escaped.replace(/(?:<li>([\s\S]*?)<\/li>\s*)+/g, (match) => `<ul style="margin-left: 20px; margin-bottom: 8px;">${match}</ul>`);
    
    // Convert newlines to breaks where not inside list containers
    escaped = escaped.replace(/\n/g, "<br>");
    
    return escaped;
}

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
    setupMapEvents();
    setupCalendarEvents();
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
    // If we are currently recording voice, stop it first!
    if (isRecordingSpeech) {
        toggleVoiceRecording();
    }

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

let speechBaseContent = "";

function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        const voiceBtn = document.getElementById("voice-btn");
        if (voiceBtn) voiceBtn.style.display = "none";
        return;
    }
    
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    
    recognition.onstart = () => {
        isRecordingSpeech = true;
        const voiceBtn = document.getElementById("voice-btn");
        if (voiceBtn) voiceBtn.classList.add("recording");
        const textarea = document.getElementById("thought-input");
        if (textarea) {
            speechBaseContent = textarea.value;
            textarea.placeholder = "[Listening to your voice... Speak now]";
        }
        document.getElementById("waveform-container").classList.add("active");
        
        try {
            navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
                visualizerStream = stream;
                startWaveformVisualizer(stream);
            }).catch(e => console.log("Visualizer microphone stream error:", e));
        } catch (e) {
            console.log("Could not start visualizer stream:", e);
        }
    };
    
    recognition.onresult = (event) => {
        let interimTranscript = "";
        let finalTranscript = "";
        
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        
        const textarea = document.getElementById("thought-input");
        if (textarea) {
            const separator = speechBaseContent && !speechBaseContent.endsWith(" ") ? " " : "";
            textarea.value = speechBaseContent + separator + finalTranscript + interimTranscript;
            textarea.scrollTop = textarea.scrollHeight;
        }
    };
    
    recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        if (event.error === "not-allowed") {
            alert("Speech recognition permission denied.");
            if (isRecordingSpeech) {
                recognition.stop();
            }
        }
    };
    
    recognition.onend = () => {
        isRecordingSpeech = false;
        const voiceBtn = document.getElementById("voice-btn");
        if (voiceBtn) voiceBtn.classList.remove("recording");
        const textarea = document.getElementById("thought-input");
        if (textarea) {
            textarea.placeholder = "Enter a thought, project concept, or research link...";
        }
        document.getElementById("waveform-container").classList.remove("active");
        
        if (visualizerStream) {
            visualizerStream.getTracks().forEach(track => track.stop());
            visualizerStream = null;
        }
        stopWaveformVisualizer();
    };
}

function toggleVoiceRecording() {
    if (!recognition) {
        initSpeechRecognition();
    }
    
    if (!recognition) return;
    
    if (isRecordingSpeech) {
        recognition.stop();
    } else {
        try {
            recognition.start();
        } catch (e) {
            console.error("Failed to start speech recognition:", e);
        }
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
        
        const locationLink = (data.latitude && data.longitude) ? 
            `<a href="https://www.google.com/maps/search/?api=1&query=${data.latitude},${data.longitude}" target="_blank" class="location-link" style="color: var(--primary-color); text-decoration: none; font-weight: 600;">Open in Google Maps</a>` : 
            `<span style="color: var(--error-color);">❌</span>`;
        
        const locationHtml = `
            <div class="detail-section" style="margin-bottom: 16px;">
                <h4 style="display: inline-block; margin-right: 8px; margin-bottom: 0;">Captured Location:</h4>
                ${locationLink}
            </div>
        `;
        
        const hasNextSteps = data.next_steps && !data.next_steps.startsWith("[LLM generation failed");
        
        let nextStepsHtml = `
            <div class="detail-section">
                <h4>Next Steps</h4>
                <div class="detail-summary" id="next-steps-container" style="line-height: 1.5; font-size: 0.88rem;">
                    ${hasNextSteps ? formatMarkdown(data.next_steps) : (data.processed ? `<span style="opacity: 0.6; font-style: italic;">Generating next steps...</span>` : `<span style="opacity: 0.6; font-style: italic;">AI model deep enrichment in progress...</span>`)}
                </div>
            </div>
        `;
        
        body.innerHTML = `
            <div class="detail-section" id="raw-thought-section" style="margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <h4 style="margin: 0;">Raw Captured Thought</h4>
                    <button class="btn btn-secondary" id="edit-thought-btn" style="padding: 2px 8px; font-size: 0.75rem; border-radius: 6px;">Edit</button>
                </div>
                <p class="detail-text" id="raw-thought-text" style="white-space: pre-wrap; word-break: break-word; margin: 0; line-height: 1.5;">${data.content}</p>
            </div>
            
            ${locationHtml}
            
            <div class="detail-section">
                <h4>AI Structured Summary</h4>
                <div class="detail-summary" style="line-height: 1.5;">
                    ${data.enrichment_summary ? formatMarkdown(data.enrichment_summary) : "AI model deep enrichment currently in progress. It runs nightly or when triggered manually."}
                </div>
            </div>
            
            ${nextStepsHtml}
            ${webRefsHtml}
            ${linksHtml}
        `;
        
        modal.classList.add("active");
        
        // Asynchronously fetch next steps if not already present or previously failed, only if thought is processed
        if (!hasNextSteps && data.processed) {
            fetch(`/api/thoughts/${data.id}/next_steps`)
                .then(res => {
                    if (!res.ok) throw new Error("HTTP " + res.status);
                    return res.json();
                })
                .then(nsData => {
                    const container = document.getElementById("next-steps-container");
                    if (container) {
                        container.innerHTML = nsData.next_steps ? formatMarkdown(nsData.next_steps) : "No next steps available.";
                    }
                })
                .catch(err => {
                    console.error("Failed to load next steps dynamically:", err);
                    const container = document.getElementById("next-steps-container");
                    if (container) {
                        container.innerHTML = `<span style="color: var(--error-color);">Failed to load next steps: ${err.message}. Close and reopen to retry.</span>`;
                    }
                });
        }
        
        const editBtn = document.getElementById("edit-thought-btn");
        if (editBtn) {
            editBtn.addEventListener("click", () => {
                const rawSection = document.getElementById("raw-thought-section");
                const rawText = document.getElementById("raw-thought-text").textContent;
                
                rawSection.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <h4 style="margin: 0;">Raw Captured Thought</h4>
                        <div>
                            <button class="btn btn-secondary" id="cancel-edit-btn" style="padding: 2px 8px; font-size: 0.75rem; margin-right: 6px; border-radius: 6px;">Cancel</button>
                            <button class="btn btn-primary" id="save-thought-btn" style="padding: 2px 8px; font-size: 0.75rem; border-radius: 6px;">Save & Re-process</button>
                        </div>
                    </div>
                    <textarea id="edit-thought-textarea" class="form-control" style="width: 100%; min-height: 100px; font-family: inherit; font-size: 0.9rem; padding: 10px; background: rgba(0,0,0,0.3); color: white; border: 1px solid var(--border-color); border-radius: 6px; resize: vertical; margin-top: 6px;">${rawText}</textarea>
                `;
                
                document.getElementById("cancel-edit-btn").addEventListener("click", () => {
                    openThoughtDetails(data.id);
                });
                
                document.getElementById("save-thought-btn").addEventListener("click", async () => {
                    const newContent = document.getElementById("edit-thought-textarea").value.trim();
                    if (!newContent) return;
                    
                    rawSection.innerHTML = `
                        <div style="text-align: center; padding: 20px;">
                            <span style="font-size: 0.9rem; color: var(--text-muted);">Saving changes and starting re-enrichment...</span>
                        </div>
                    `;
                    
                    try {
                        const putResponse = await fetch(`/api/thoughts/${data.id}`, {
                            method: "PUT",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ content: newContent })
                        });
                        
                        if (putResponse.ok) {
                            openThoughtDetails(data.id);
                            if (typeof fetchThoughts === "function") {
                                fetchThoughts();
                            }
                        } else {
                            alert("Failed to update thought.");
                            openThoughtDetails(data.id);
                        }
                    } catch (err) {
                        console.error(err);
                        alert("Error updating thought.");
                        openThoughtDetails(data.id);
                    }
                });
            });
        }
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

function setupMapEvents() {
    const mapBtn = document.getElementById("map-view-btn");
    const mapModal = document.getElementById("map-modal");
    const closeMapBtn = document.getElementById("close-map");
    
    if (mapBtn) {
        mapBtn.addEventListener("click", () => {
            if (mapModal) {
                mapModal.classList.add("active");
                setTimeout(() => {
                    initThoughtMap();
                }, 100);
            }
        });
    }
    
    if (closeMapBtn) {
        closeMapBtn.addEventListener("click", () => {
            if (mapModal) mapModal.classList.remove("active");
        });
    }
    
    if (mapModal) {
        mapModal.addEventListener("click", (e) => {
            if (e.target.id === "map-modal") {
                mapModal.classList.remove("active");
            }
        });
    }

    // Handle clicking a thought detail link inside leaflet map popups
    document.addEventListener("click", (e) => {
        const btn = e.target.closest(".view-thought-details-btn");
        if (btn) {
            e.preventDefault();
            const thoughtId = btn.getAttribute("data-id");
            if (mapModal) mapModal.classList.remove("active");
            openThoughtDetails(thoughtId);
        }
    });
}

function initThoughtMap() {
    const mapDiv = document.getElementById("map-canvas");
    if (!mapDiv || typeof L === 'undefined') return;
    
    const theme = localStorage.getItem("deep_thought_theme") || "default";
    const isDark = ["default", "cyberpunk", "royal", "tokyo"].includes(theme);
    const tileUrl = isDark ? 
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" : 
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
    const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
    
    // Filter thoughts that have location coordinates
    const mapThoughts = activeThoughts.filter(t => t.latitude && t.longitude);
    
    if (!thoughtMap) {
        // Initialize map centered on the first thought with coordinates, or default center (0,0)
        let center = [0, 0];
        let zoom = 2;
        if (mapThoughts.length > 0) {
            center = [mapThoughts[0].latitude, mapThoughts[0].longitude];
            zoom = 12;
        }
        
        thoughtMap = L.map('map-canvas').setView(center, zoom);
        L.tileLayer(tileUrl, {
            maxZoom: 19,
            attribution: attribution
        }).addTo(thoughtMap);
    } else {
        // Update tiles layer to match the active theme
        thoughtMap.eachLayer((layer) => {
            if (layer instanceof L.TileLayer) {
                thoughtMap.removeLayer(layer);
            }
        });
        L.tileLayer(tileUrl, {
            maxZoom: 19,
            attribution: attribution
        }).addTo(thoughtMap);
        
        thoughtMap.invalidateSize();
    }
    
    // Clear existing markers
    mapMarkers.forEach(m => thoughtMap.removeLayer(m));
    mapMarkers = [];
    
    // Add markers for all thoughts with coordinates
    if (mapThoughts.length > 0) {
        // Group thoughts by proximity (within ~50 meters / 0.0005 degrees)
        const grouped = [];
        const THRESHOLD = 0.0005;
        
        mapThoughts.forEach(t => {
            const lat = Number(t.latitude);
            const lon = Number(t.longitude);
            
            const group = grouped.find(g => {
                return Math.abs(g.latitude - lat) < THRESHOLD && Math.abs(g.longitude - lon) < THRESHOLD;
            });
            
            if (group) {
                group.thoughts.push(t);
            } else {
                grouped.push({
                    latitude: lat,
                    longitude: lon,
                    thoughts: [t]
                });
            }
        });

        const latLngs = [];
        
        grouped.forEach(group => {
            // Sort thoughts newest to oldest
            group.thoughts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            
            // Marker color is based on the newest thought in the group
            const newestThought = group.thoughts[0];
            const markerColor = getMarkerColorForCategory(newestThought.category);
            
            // Custom divIcon matching application segment brand colors
            const customIcon = L.divIcon({
                html: `<div style="background-color: ${markerColor}; width: 14px; height: 14px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 8px rgba(0,0,0,0.5);"></div>`,
                className: 'custom-map-pin',
                iconSize: [14, 14],
                iconAnchor: [7, 7]
            });
            
            // Build popup html containing the timeline list
            let popupHtml = `<div class="popup-timeline" style="max-height: 250px; overflow-y: auto; padding-right: 6px; font-family: var(--font-body); min-width: 220px; color: var(--text-primary);">`;
            
            if (group.thoughts.length > 1) {
                popupHtml += `<h4 style="margin: 0 0 8px 0; font-size: 0.85rem; font-weight: 600; border-bottom: 1px solid var(--border-color); padding-bottom: 4px; color: var(--text-primary);">${group.thoughts.length} Thoughts Here</h4>`;
            }
            
            group.thoughts.forEach((t, idx) => {
                const dateStr = new Date(t.created_at).toLocaleString();
                const categoryBadge = t.category ? `<span class="badge badge-category" style="margin-left:0; margin-bottom:4px; display:inline-block; font-size: 0.65rem; padding: 2px 6px;">${t.category}</span>` : "";
                const snippet = t.content.length > 120 ? t.content.substring(0, 120) + "..." : t.content;
                
                const isLast = idx === group.thoughts.length - 1;
                const itemStyle = isLast ? "" : "border-bottom: 1px solid var(--border-color-hover); margin-bottom: 8px; padding-bottom: 8px;";
                
                popupHtml += `
                    <div class="popup-thought-item" style="${itemStyle}">
                        <span style="font-size: 0.7rem; color: var(--text-secondary); display:block; margin-bottom:2px;">${dateStr}</span>
                        ${categoryBadge}
                        <p style="font-size: 0.8rem; margin: 4px 0 6px 0; color: var(--text-primary); line-height: 1.4; word-break: break-word;">${snippet}</p>
                        <a href="#" class="view-thought-details-btn" data-id="${t.id}" style="font-size:0.75rem; font-weight:600; color:var(--primary-color); text-decoration:none; display:inline-block;">View Details &rarr;</a>
                    </div>
                `;
            });
            
            popupHtml += `</div>`;
            
            const marker = L.marker([group.latitude, group.longitude], { icon: customIcon })
                .bindPopup(popupHtml)
                .addTo(thoughtMap);
            
            mapMarkers.push(marker);
            latLngs.push([group.latitude, group.longitude]);
        });
        
        // Fit map bounds to view all markers automatically
        if (latLngs.length > 1) {
            thoughtMap.fitBounds(latLngs, { padding: [30, 30] });
        } else if (latLngs.length === 1) {
            thoughtMap.setView(latLngs[0], 13);
        }
    }
}

function getMarkerColorForCategory(category) {
    if (!category) return "#a55eea"; // General segment
    const cat = category.toLowerCase();
    if (cat.includes("research")) return "#00cec9"; // Research segment
    if (cat.includes("idea")) return "#fd9644"; // Idea segment
    if (cat.includes("todo")) return "#fc5c65"; // To-Do segment
    return "#a55eea";
}

function setupCalendarEvents() {
    const calendarBtn = document.getElementById("calendar-view-btn");
    const calendarModal = document.getElementById("calendar-modal");
    const closeCalendarBtn = document.getElementById("close-calendar");
    
    const prevMonthBtn = document.getElementById("prev-month-btn");
    const nextMonthBtn = document.getElementById("next-month-btn");
    
    if (calendarBtn) {
        calendarBtn.addEventListener("click", () => {
            if (calendarModal) {
                calendarModal.classList.add("active");
                currentCalendarDate = new Date();
                selectedCalendarDate = null;
                renderCalendar();
            }
        });
    }
    
    if (closeCalendarBtn) {
        closeCalendarBtn.addEventListener("click", () => {
            if (calendarModal) calendarModal.classList.remove("active");
        });
    }
    
    if (calendarModal) {
        calendarModal.addEventListener("click", (e) => {
            if (e.target.id === "calendar-modal") {
                calendarModal.classList.remove("active");
            }
        });
    }
    
    if (prevMonthBtn) {
        prevMonthBtn.addEventListener("click", () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
            renderCalendar();
        });
    }
    
    if (nextMonthBtn) {
        nextMonthBtn.addEventListener("click", () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
            renderCalendar();
        });
    }

    // Intercept clicks on view details links inside the calendar list (closes calendar and opens details)
    document.addEventListener("click", (e) => {
        const btn = e.target.closest(".calendar-details-panel .view-thought-details-btn");
        if (btn) {
            e.preventDefault();
            const thoughtId = btn.getAttribute("data-id");
            if (calendarModal) calendarModal.classList.remove("active");
            openThoughtDetails(thoughtId);
        }
    });
}

function renderCalendar() {
    const monthYearLabel = document.getElementById("calendar-month-year");
    const grid = document.getElementById("calendar-grid");
    const thoughtsContainer = document.getElementById("calendar-day-thoughts");
    const detailsHeader = document.getElementById("calendar-details-header");
    
    if (!grid) return;
    grid.innerHTML = "";
    
    // Reset thoughts details panel on redraw
    if (thoughtsContainer) {
        thoughtsContainer.innerHTML = `<div style="opacity: 0.5; font-size: 0.85rem; font-style: italic; text-align: center; margin-top: 40px;">Select a day to view thoughts.</div>`;
    }
    if (detailsHeader) {
        detailsHeader.textContent = "Select a day to view thoughts";
    }
    
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    
    // Update month year label text (e.g. "June 2026")
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if (monthYearLabel) {
        monthYearLabel.textContent = `${monthNames[month]} ${year}`;
    }
    
    // Group thoughts by local date string YYYY-MM-DD
    const thoughtsByDate = {};
    activeThoughts.forEach(t => {
        const dateObj = new Date(t.created_at);
        const y = dateObj.getFullYear();
        const m = String(dateObj.getMonth() + 1).padStart(2, "0");
        const d = String(dateObj.getDate()).padStart(2, "0");
        const dateKey = `${y}-${m}-${d}`;
        if (!thoughtsByDate[dateKey]) {
            thoughtsByDate[dateKey] = [];
        }
        thoughtsByDate[dateKey].push(t);
    });
    
    // Get first day of month and total days
    const firstDay = new Date(year, month, 1).getDay(); // weekday index (0-6)
    const totalDays = new Date(year, month + 1, 0).getDate(); // last day date
    
    // Render padding cells for days from the previous month
    for (let i = 0; i < firstDay; i++) {
        const padCell = document.createElement("div");
        padCell.className = "calendar-day-cell inactive";
        grid.appendChild(padCell);
    }
    
    // Render active month days
    for (let day = 1; day <= totalDays; day++) {
        const dayCell = document.createElement("div");
        dayCell.className = "calendar-day-cell";
        dayCell.textContent = day;
        
        const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const dayThoughts = thoughtsByDate[dateKey] || [];
        
        if (dayThoughts.length > 0) {
            dayCell.classList.add("has-thoughts");
            const badge = document.createElement("span");
            badge.className = "day-count-badge";
            badge.textContent = dayThoughts.length;
            dayCell.appendChild(badge);
        }
        
        if (selectedCalendarDate === dateKey) {
            dayCell.classList.add("selected");
            renderCalendarDayThoughts(dateKey, dayThoughts);
        }
        
        dayCell.addEventListener("click", () => {
            // Remove selection highlight from previously selected cells
            const selectedCell = grid.querySelector(".calendar-day-cell.selected");
            if (selectedCell) selectedCell.classList.remove("selected");
            
            dayCell.classList.add("selected");
            selectedCalendarDate = dateKey;
            
            renderCalendarDayThoughts(dateKey, dayThoughts);
        });
        
        grid.appendChild(dayCell);
    }
}

function renderCalendarDayThoughts(dateKey, thoughts) {
    const thoughtsContainer = document.getElementById("calendar-day-thoughts");
    const detailsHeader = document.getElementById("calendar-details-header");
    
    // Parse date label (e.g. "June 14, 2026")
    const [y, m, d] = dateKey.split("-").map(Number);
    const dateLabel = new Date(y, m - 1, d).toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric"
    });
    
    if (detailsHeader) {
        detailsHeader.textContent = `Thoughts on ${dateLabel}`;
    }
    
    if (!thoughtsContainer) return;
    
    if (thoughts.length === 0) {
        thoughtsContainer.innerHTML = `<div style="opacity: 0.5; font-size: 0.85rem; font-style: italic; text-align: center; margin-top: 40px;">No thoughts captured on this day.</div>`;
        return;
    }
    
    // Sort thoughts chronologically newest to oldest
    const sortedThoughts = [...thoughts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    thoughtsContainer.innerHTML = "";
    sortedThoughts.forEach(t => {
        const dateStr = new Date(t.created_at).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit"
        });
        
        const category = t.category || "General";
        const categoryLower = category.toLowerCase();
        let borderClass = "cat-border-general";
        if (categoryLower.includes("research")) borderClass = "cat-border-research";
        else if (categoryLower.includes("idea")) borderClass = "cat-border-idea";
        else if (categoryLower.includes("todo")) borderClass = "cat-border-todo";
        
        const categoryBadge = t.category ? `<span class="badge badge-category" style="margin-left:0; margin-bottom:4px; display:inline-block; font-size: 0.65rem; padding: 2px 6px;">${t.category}</span>` : "";
        const snippet = t.content;
        
        const item = document.createElement("div");
        item.className = `calendar-thought-item ${borderClass}`;
        item.innerHTML = `
            <span style="font-size: 0.7rem; color: var(--text-secondary); display:block; margin-bottom:2px;">${dateStr}</span>
            ${categoryBadge}
            <p style="font-size: 0.8rem; margin: 4px 0 6px 0; color: var(--text-primary); line-height: 1.4; word-break: break-word;">${snippet}</p>
            <a href="#" class="view-thought-details-btn" data-id="${t.id}" style="font-size:0.75rem; font-weight:600; color:var(--primary-color); text-decoration:none; display:inline-block;">View Details &rarr;</a>
        `;
        
        thoughtsContainer.appendChild(item);
    });
}
