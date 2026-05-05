// Voice AI embeddable widget.
// Usage:
//   <script src="https://your-server/widget.js" data-widget-key="wk_live_…"></script>
//
// Optional attributes:
//   data-label   — button text (default "Call us")
//   data-color   — accent color (default "#2563eb")
//   data-position — "br" | "bl" | "tr" | "tl" (default "br")

(function () {
  const script = document.currentScript;
  if (!script) {
    console.error("[voice-ai] widget.js must be loaded with a <script> tag.");
    return;
  }

  const widgetKey = script.getAttribute("data-widget-key");
  if (!widgetKey) {
    console.error("[voice-ai] missing data-widget-key on script tag.");
    return;
  }

  const serverUrl = new URL(script.src).origin;
  const label = script.getAttribute("data-label") || "Call us";
  const color = script.getAttribute("data-color") || "#2563eb";
  const position = script.getAttribute("data-position") || "br";

  // ---- DOM + style isolation via shadow root --------------------------------
  const host = document.createElement("div");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  const offset = "20px";
  if (position.includes("b")) host.style.bottom = offset;
  else host.style.top = offset;
  if (position.includes("r")) host.style.right = offset;
  else host.style.left = offset;
  document.body.appendChild(host);

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .btn {
        display: inline-flex; align-items: center; gap: 8px;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        font-size: 15px; font-weight: 600; color: white;
        background: ${color};
        border: none; border-radius: 999px;
        padding: 12px 18px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.18);
        cursor: pointer;
        transition: transform 0.1s ease, box-shadow 0.1s ease;
      }
      .btn:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(0,0,0,0.22); }
      .btn:disabled { opacity: 0.7; cursor: progress; }
      .btn.calling { background: #16a34a; }
      .btn.error { background: #dc2626; }
      .dot {
        width: 8px; height: 8px; border-radius: 50%; background: white;
        opacity: 0.85;
      }
      .btn.calling .dot { animation: pulse 1.2s ease-in-out infinite; }
      @keyframes pulse {
        0%, 100% { opacity: 0.4; transform: scale(0.8); }
        50%      { opacity: 1.0; transform: scale(1.2); }
      }
      .icon { width: 16px; height: 16px; fill: currentColor; }
      audio { display: none; }
    </style>
    <button class="btn" type="button" id="btn">
      <svg class="icon" viewBox="0 0 24 24"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.05-.24c1.16.39 2.41.6 3.7.6a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.29.21 2.54.6 3.7a1 1 0 0 1-.24 1.05l-2.24 2.04Z"/></svg>
      <span id="lbl">${label}</span>
      <span class="dot" id="dot" style="display:none"></span>
    </button>
    <audio id="remote" autoplay playsinline></audio>
  `;

  const btn = root.getElementById("btn");
  const lbl = root.getElementById("lbl");
  const dot = root.getElementById("dot");
  const remote = root.getElementById("remote");

  let pc = null;
  let localStream = null;
  let state = "idle";

  function setState(next, text) {
    state = next;
    btn.classList.remove("calling", "error");
    dot.style.display = "none";
    btn.disabled = false;
    if (next === "connecting") {
      btn.disabled = true;
      lbl.textContent = text || "Connecting…";
    } else if (next === "calling") {
      btn.classList.add("calling");
      dot.style.display = "inline-block";
      lbl.textContent = text || "End call";
    } else if (next === "error") {
      btn.classList.add("error");
      lbl.textContent = text || "Failed";
      setTimeout(() => { if (state === "error") setState("idle"); }, 4000);
    } else {
      lbl.textContent = label;
    }
  }

  async function startCall() {
    setState("connecting", "Requesting access…");

    let token, iceServers;
    try {
      const r = await fetch(serverUrl + "/web-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ widget_key: widgetKey }),
      });
      if (!r.ok) {
        const detail = await r.text();
        console.error("[voice-ai] /web-session", r.status, detail);
        return setState("error", r.status === 403 ? "Not allowed here" :
                                  r.status === 429 ? "Too many tries" : "Unavailable");
      }
      const sessionData = await r.json();
      token = sessionData.token;
      iceServers = sessionData.ice_servers || [{ urls: "stun:stun.cloudflare.com:3478" }];
    } catch (e) {
      console.error("[voice-ai] session error", e);
      return setState("error", "Network error");
    }

    setState("connecting", "Mic permission…");
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error("[voice-ai] mic denied", e);
      return setState("error", "Mic denied");
    }

    setState("connecting", "Connecting…");
    pc = new RTCPeerConnection({ iceServers });
    pc.ontrack = (ev) => { remote.srcObject = ev.streams[0]; };
    pc.onconnectionstatechange = () => {
      const s = pc && pc.connectionState;
      if (s === "connected") setState("calling");
      else if (s === "failed" || s === "disconnected" || s === "closed") {
        if (state !== "idle") cleanup();
      }
    };
    pc.addTransceiver("audio", { direction: "sendrecv" });
    for (const t of localStream.getAudioTracks()) pc.addTrack(t, localStream);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Wait for ICE gathering, but cap it — usable host/srflx candidates
    // arrive within ~200ms, TURN relay candidates can take 1-2s longer.
    // Sending the offer with whatever we have keeps connect time low.
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const done = () => {
        pc.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === "complete") done(); };
      pc.addEventListener("icegatheringstatechange", check);
      const timer = setTimeout(done, 800);
    });

    let answer;
    try {
      const r = await fetch(serverUrl + "/web-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          sdp: pc.localDescription.sdp,
          type: pc.localDescription.type,
        }),
      });
      if (!r.ok) {
        console.error("[voice-ai] /web-call", r.status, await r.text());
        cleanup();
        return setState("error", "Call failed");
      }
      answer = await r.json();
    } catch (e) {
      console.error("[voice-ai] call error", e);
      cleanup();
      return setState("error", "Network error");
    }

    await pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
  }

  function cleanup() {
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    remote.srcObject = null;
    setState("idle");
  }

  btn.addEventListener("click", () => {
    if (state === "idle") startCall();
    else if (state === "calling") cleanup();
  });

  setState("idle");
})();
