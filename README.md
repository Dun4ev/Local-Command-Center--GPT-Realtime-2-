# GPT Realtime 2 Local Command Center

Small local demo for testing `gpt-realtime-2` as an English voice assistant that can control a computer through a safe allow-list of tools.

## Run

1. Copy `.env.example` to `.env` or set `OPENAI_API_KEY` in your terminal.
2. Start the app:

```powershell
npm start
```

3. Open `http://localhost:3000`.
4. Click `Start`, allow microphone access, and speak in English.

## Test phrases

- "Open Notepad."
- "Show files in the current folder."
- "Find the README file."
- "Open the current folder."
- "Prepare a note titled test with the text this is the first check."
- "Yes, confirm it."

## Safety model

The assistant cannot run arbitrary commands. It can only call the tools defined in `server.js`.
Write actions use preview plus explicit confirmation.
