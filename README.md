# LocalAgents Studio

An autonomous, distributed local-agent IDE built for a multi-PC Ollama cluster with optional Frontier Cloud fallback (xAI Grok, OpenAI, OpenRouter).

---

<img width="1116" height="686" alt="Screenshot 2026-10-29 182925" src="https://github.com/user-attachments/assets/d2920865-2620-4556-8a7a-79b54ec13149" />


## Example Cluster Templates

Default nodes are **examples** — edit URLs and hardware in Hardware Settings to match your machines.

| Node |  Example hardware | Best Fit Role |
| :--- | :--- | :--- |
| **High-End Gaming PC** | 16–24GB VRAM (e.g. RTX 4080 / 4090) · 64GB RAM | Lead Architect & Coder (`@coder`) |
| **Mid-Range PC** | 8–12GB VRAM (e.g. RTX 3060 12GB / 4060) · 32GB RAM | Docs & secondary planning (`@docs`) |
| **Budget Laptop** | ~6GB VRAM (e.g. RTX 3060 Laptop) · 16GB RAM | Fast Reviewer (`@reviewer`) |
| **Frontier API** | Cloud frontier model | Deep reasoning (optional) |

---

## Key Features

### Live Token/Sec Benchmarking
- In **Hardware Settings**, click **Benchmark** next to any installed model.
- Measures generation speed (tok/s), prompt eval speed, and VRAM load latency via a short Ollama `/api/generate` coding prompt (`num_predict: 64`).
- Seeded default speeds show as **(estimate)** until you run a live benchmark; live results drive Conductor routing.

### Hybrid Local + Frontier API Support
- Route routine coding to local GPUs; optionally send work to Grok / OpenAI / OpenRouter.
- Enter an API key in Hardware Settings. Keys are stored in **plaintext** in Electron `userData/settings.json` on this machine (not encrypted).

### Token Economy Tracker
- Header badge tracks free local tokens vs frontier tokens and estimated API cost avoided.

### Hardware Recommender & Model Hub
- Catalog with VRAM fit (full GPU / offload / won't fit) and one-click remote **Pull Model**.

### Autonomous Workspace Tools
- `edit_file` SEARCH/REPLACE preview, `write_file` apply, `run_command` with captured PowerShell output.
- Read-only tools auto-run and continue the agent loop (bounded).
- Agent writes are scoped to the open workspace folder.

### Conductor Swarm
- Decomposes multi-file tasks and assigns distinct files across online GPUs using each node's selected model.

---

## Running the App

```powershell
cd path\to\LocalAgents
.\start.bat
# or
npm start
```

Development:

```powershell
npm install
npm run dev
```

See [HISTORY.md](HISTORY.md) for architecture and evolution notes.
