import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(process.env.WORKSPACE_ROOT || process.cwd());
const PUBLIC_DIR = path.join(process.cwd(), "public");
const NOTES_DIR = path.join(process.cwd(), "notes");

const pendingActions = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fsSync.existsSync(envPath)) return;

  const lines = fsSync.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function getApiKey() {
  loadDotEnv();
  return process.env.OPENAI_API_KEY;
}

const SYSTEM_PROMPT = `
# Role and Objective
You are an English-speaking voice assistant for local computer control.
Help the user run only approved safe actions.

# Language
Always speak English, briefly and naturally.

# Reasoning
- For simple commands, respond quickly.
- For file actions, note creation, or ambiguous commands, ask a brief clarification first.
- Do not reason out loud or reveal hidden reasoning.

# Preambles
- Before a noticeable tool action, briefly say what you are doing.
- Avoid long introductions.

# Tools
Use only the tools in the current tool list. Do not invent tools, and do not say an action is complete until the tool has returned success.

Allowed actions:
- open an application from the approved list;
- open the current workspace folder;
- list files;
- find a file by name;
- preview note creation;
- confirm a previously prepared action.

Forbidden:
- run arbitrary commands;
- delete, move, or bulk rename files;
- change system settings;
- perform any write action without explicit user confirmation.

For write actions:
1. First call preview_create_note.
2. Give the user a short summary and the action_id.
3. Call confirm_action only if the user explicitly confirms.

# Unclear Audio
- If the audio is unclear, noisy, cut off, or you are unsure of the words, ask the user to repeat.
- Do not guess commands from unclear audio.

# Exact Entity Capture
- Read back filenames, action_id values, and other exact values before risky actions.
- If a value is ambiguous, ask one short question.

# Handling Silence and Background Noise
If you hear silence, background noise, or speech not addressed to you, call wait_for_user and do not speak.

# Verbosity
- Normal response: 1-2 short phrases.
- After a tool call: give the result first, then the next useful step.
`;

const tools = [
  {
    type: "function",
    name: "open_app",
    description: "Open one allowed Windows application. Use only when the user clearly asks to open it.",
    parameters: {
      type: "object",
      properties: {
        app: {
          type: "string",
          enum: ["notepad", "calculator", "explorer", "vscode", "powershell"],
          description: "Allowed application to open.",
        },
      },
      required: ["app"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "open_workspace",
    description: "Open the current workspace folder in Windows Explorer.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_files",
    description: "List files and folders in the current workspace root. This is read-only.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "find_file",
    description: "Search for files and folders by name inside the workspace. This is read-only.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Part of the filename to search for.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "preview_create_note",
    description: "Prepare creating a Markdown note, but do not write it yet. Returns an action_id for later confirmation.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short note title.",
        },
        content: {
          type: "string",
          description: "Note body.",
        },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "confirm_action",
    description: "Execute a pending write action only after explicit user confirmation.",
    parameters: {
      type: "object",
      properties: {
        action_id: {
          type: "string",
          description: "The pending action ID returned by a preview tool.",
        },
      },
      required: ["action_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "wait_for_user",
    description: "Call this when the latest audio is silence, background noise, or speech not addressed to the assistant.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function isInsideRoot(candidate) {
  const resolved = path.resolve(candidate);
  return resolved === ROOT || resolved.startsWith(ROOT + path.sep);
}

function safeNoteName(title) {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${cleaned || "note"}-${new Date().toISOString().slice(0, 10)}.md`;
}

function startDetached(command, args = []) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

async function listRootFiles() {
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith("."))
    .slice(0, 80)
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "folder" : "file",
    }));
}

async function findByName(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const results = [];
  const skip = new Set(["node_modules", ".git", ".next", "dist", "build"]);

  async function walk(dir) {
    if (results.length >= 30) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= 30) return;
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (!isInsideRoot(full)) continue;
      if (entry.name.toLowerCase().includes(needle)) {
        results.push({
          name: entry.name,
          type: entry.isDirectory() ? "folder" : "file",
          path: path.relative(ROOT, full) || ".",
        });
      }
      if (entry.isDirectory()) await walk(full);
    }
  }

  await walk(ROOT);
  return results;
}

async function handleTool(name, args) {
  switch (name) {
    case "open_app": {
      const commands = {
        notepad: ["notepad.exe", []],
        calculator: ["calc.exe", []],
        explorer: ["explorer.exe", []],
        vscode: ["cmd.exe", ["/c", "code", ROOT]],
        powershell: ["powershell.exe", ["-NoExit", "-Command", `Set-Location -LiteralPath '${ROOT.replace(/'/g, "''")}'`]],
      };
      const selected = commands[args.app];
      if (!selected) return { ok: false, message: "This application is not in the approved list." };
      startDetached(selected[0], selected[1]);
      return { ok: true, message: `Opening ${args.app}.` };
    }

    case "open_workspace": {
      startDetached("explorer.exe", [ROOT]);
      return { ok: true, message: "Opening the current workspace folder.", root: ROOT };
    }

    case "list_files": {
      const files = await listRootFiles();
      return { ok: true, root: ROOT, files };
    }

    case "find_file": {
      const results = await findByName(String(args.query || ""));
      return { ok: true, query: args.query, results };
    }

    case "preview_create_note": {
      const actionId = crypto.randomUUID().slice(0, 8);
      const filename = safeNoteName(String(args.title || "note"));
      const filePath = path.join(NOTES_DIR, filename);
      pendingActions.set(actionId, {
        type: "create_note",
        title: String(args.title || "Note").trim(),
        content: String(args.content || "").trim(),
        filePath,
      });
      return {
        ok: true,
        action_id: actionId,
        message: "The note is prepared but has not been created yet.",
        file: path.relative(process.cwd(), filePath),
      };
    }

    case "confirm_action": {
      const actionId = String(args.action_id || "").trim();
      const action = pendingActions.get(actionId);
      if (!action) return { ok: false, message: "No pending action found for this ID." };

      if (action.type === "create_note") {
        await fs.mkdir(NOTES_DIR, { recursive: true });
        const body = `# ${action.title}\n\n${action.content}\n`;
        await fs.writeFile(action.filePath, body, "utf8");
        pendingActions.delete(actionId);
        return {
          ok: true,
          message: "Note created.",
          file: path.relative(process.cwd(), action.filePath),
        };
      }

      return { ok: false, message: "Unsupported action type." };
    }

    case "wait_for_user":
      return { ok: true, message: "Waiting for the user." };

    default:
      return { ok: false, message: "This tool is not available." };
  }
}

async function createRealtimeSession(req, res) {
  const apiKey = getApiKey();
  if (!apiKey) {
    json(res, 500, { error: "OPENAI_API_KEY is not set. Create a .env file or set the environment variable." });
    return;
  }

  const sdp = await readBody(req);
  const fd = new FormData();
  fd.set("sdp", sdp);
  fd.set(
    "session",
    JSON.stringify({
      type: "realtime",
      model: "gpt-realtime-2",
      instructions: SYSTEM_PROMPT,
      output_modalities: ["audio"],
      reasoning: { effort: "low" },
      audio: {
        input: {
          turn_detection: {
            type: "semantic_vad",
          },
        },
        output: {
          voice: "marin",
        },
      },
      tools,
      tool_choice: "auto",
    })
  );

  const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Safety-Identifier": "local-demo-user",
    },
    body: fd,
  });

  const text = await upstream.text();
  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/sdp" });
  res.end(text);
}

async function route(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/session") {
      await createRealtimeSession(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/tool") {
      const body = JSON.parse(await readBody(req) || "{}");
      const result = await handleTool(body.name, body.arguments || {});
      json(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, root: ROOT, has_api_key: Boolean(getApiKey()) });
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(PUBLIC_DIR, decodeURIComponent(requested));
    if (!filePath.startsWith(PUBLIC_DIR) || !fsSync.existsSync(filePath)) {
      json(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fsSync.createReadStream(filePath).pipe(res);
  } catch (error) {
    json(res, 500, { error: error.message || "Internal server error" });
  }
}

http.createServer(route).listen(PORT, () => {
  console.log(`Local command center: http://localhost:${PORT}`);
  console.log(`Workspace root: ${ROOT}`);
});
