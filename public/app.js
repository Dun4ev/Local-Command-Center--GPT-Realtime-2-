const statusEl = document.querySelector("#status");
const logEl = document.querySelector("#log");
const connectBtn = document.querySelector("#connectBtn");
const muteBtn = document.querySelector("#muteBtn");
const disconnectBtn = document.querySelector("#disconnectBtn");
const clearLogBtn = document.querySelector("#clearLogBtn");

let pc;
let dc;
let localStream;
let muted = false;

function setStatus(text, mode = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${mode}`.trim();
}

function log(tag, message, kind = "") {
  const entry = document.createElement("div");
  entry.className = `entry ${kind}`.trim();
  entry.innerHTML = `<span class="tag">${tag}</span>${escapeHtml(message)}`;
  logEl.append(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function summarizeEvent(event) {
  if (event.type === "session.created") return "Session created.";
  if (event.type === "session.updated") return "Session updated.";
  if (event.type === "input_audio_buffer.speech_started") return "User started speaking.";
  if (event.type === "input_audio_buffer.speech_stopped") return "User stopped speaking.";
  if (event.type === "response.created") return "Assistant is preparing a response.";
  if (event.type === "response.output_audio_transcript.delta") return event.delta;
  if (event.type === "response.output_audio_transcript.done") return `Answer: ${event.transcript || ""}`;
  if (event.type === "error") return JSON.stringify(event.error || event, null, 2);
  return "";
}

async function connect() {
  try {
    setStatus("connecting");
    connectBtn.disabled = true;
    log("system", "Requesting microphone access and creating a Realtime session.");

    pc = new RTCPeerConnection();
    dc = pc.createDataChannel("oai-events");

    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
    };

    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc.addTrack(localStream.getAudioTracks()[0]);

    dc.addEventListener("open", () => {
      setStatus("listening", "live");
      muteBtn.disabled = false;
      disconnectBtn.disabled = false;
      log("system", "Ready. You can speak now.");
    });

    dc.addEventListener("message", async (message) => {
      const event = JSON.parse(message.data);
      await handleServerEvent(event);
    });

    dc.addEventListener("close", () => {
      setStatus("offline");
      log("system", "Event channel closed.");
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });

    if (!sdpResponse.ok) {
      const errorText = await sdpResponse.text();
      throw new Error(errorText);
    }

    const answer = {
      type: "answer",
      sdp: await sdpResponse.text(),
    };

    await pc.setRemoteDescription(answer);
  } catch (error) {
    setStatus("error", "error");
    connectBtn.disabled = false;
    log("error", error.message || String(error), "error");
    disconnect();
  }
}

async function handleServerEvent(event) {
  const summary = summarizeEvent(event);
  if (summary) {
    const kind = event.type === "error" ? "error" : "";
    log(event.type, summary, kind);
  }

  if (event.type === "response.done") {
    const calls = event.response?.output?.filter((item) => item.type === "function_call") || [];
    for (const call of calls) {
      await runToolCall(call);
    }
  }
}

async function runToolCall(call) {
  const args = call.arguments ? JSON.parse(call.arguments) : {};
  log("tool call", `${call.name} ${JSON.stringify(args)}`, "tool");

  const response = await fetch("/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: call.name,
      arguments: args,
    }),
  });

  const result = await response.json();
  log("tool result", JSON.stringify(result, null, 2), result.ok ? "tool" : "error");

  dc.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      },
    })
  );

  if (call.name === "wait_for_user") return;

  dc.send(JSON.stringify({ type: "response.create" }));
}

function toggleMute() {
  muted = !muted;
  for (const track of localStream?.getAudioTracks() || []) {
    track.enabled = !muted;
  }
  muteBtn.textContent = muted ? "Microphone off" : "Microphone on";
  setStatus(muted ? "muted" : "listening", muted ? "" : "live");
}

function disconnect() {
  for (const track of localStream?.getTracks() || []) track.stop();
  localStream = null;
  dc?.close();
  pc?.close();
  dc = null;
  pc = null;
  muted = false;
  connectBtn.disabled = false;
  muteBtn.disabled = true;
  disconnectBtn.disabled = true;
  muteBtn.textContent = "Microphone on";
  if (!statusEl.classList.contains("error")) setStatus("offline");
}

connectBtn.addEventListener("click", connect);
muteBtn.addEventListener("click", toggleMute);
disconnectBtn.addEventListener("click", disconnect);
clearLogBtn.addEventListener("click", () => {
  logEl.innerHTML = "";
});

setStatus("offline");
