import { EndpointNode } from '../types';
import {
  getEnabledModelsForNode,
  getPreferredModelForNode,
  isFrontierNode,
  pickBestModelForComplexity,
  type ConductorFileJob
} from './tools';

export type SwarmComplexity = 'high' | 'medium' | 'low';
export type SwarmPreferredRole = '@coder' | '@docs' | '@reviewer';

export interface SwarmTask {
  filePath: string;
  complexity: SwarmComplexity;
  preferredRole: SwarmPreferredRole;
  requiredExports: string[];
  requiredImports: string[];
  instructions: string;
  /** Display role label for UI */
  role?: string;
}

export interface SwarmManifest {
  contractFile: string;
  contractCode: string;
  tasks: SwarmTask[];
}

export interface SwarmAssignment {
  task: SwarmTask;
  node: EndpointNode;
  model: string;
  usedFrontierBackup?: boolean;
  skippedReason?: string;
}

const COMPLEXITY_WEIGHT: Record<SwarmComplexity, number> = {
  high: 3,
  medium: 2,
  low: 1
};

/** Map swarm complexity → existing Conductor complexity labels. */
export function toConductorComplexity(
  c: SwarmComplexity
): ConductorFileJob['complexity'] {
  if (c === 'high') return 'heavy';
  if (c === 'low') return 'light';
  return 'medium';
}

export function stripThinkBlocks(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Parse Pass-1 Lead Architect JSON (tolerates fences + think blocks).
 */
export function parseSwarmManifest(raw: string, userTask: string): SwarmManifest | null {
  try {
    let cleaned = stripThinkBlocks(raw);
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();
    const startObj = cleaned.indexOf('{');
    const endObj = cleaned.lastIndexOf('}');
    if (startObj === -1 || endObj <= startObj) return null;
    const parsed = JSON.parse(cleaned.slice(startObj, endObj + 1));
    if (!parsed || typeof parsed !== 'object') return null;

    const contractFile = String(parsed.contractFile || 'src/types/swarm-contract.ts')
      .trim()
      .replace(/^[\\/]+/, '')
      .replace(/\.\.[\\/]+/g, '');
    let contractCode = String(parsed.contractCode || '').trim();
    if (!contractCode) return null;
    // Strip accidental fences inside contractCode
    contractCode = contractCode
      .replace(/^\s*```(?:typescript|ts)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '');

    const seen = new Set<string>();
    const tasks: SwarmTask[] = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
      .filter((t: any) => t && typeof t.filePath === 'string' && t.filePath.trim())
      .map((t: any) => {
        const filePath = String(t.filePath)
          .trim()
          .replace(/^[\\/]+/, '')
          .replace(/\.\.[\\/]+/g, '');
        const complexity: SwarmComplexity =
          t.complexity === 'high' || t.complexity === 'low' || t.complexity === 'medium'
            ? t.complexity
            : t.complexity === 'heavy'
              ? 'high'
              : t.complexity === 'light'
                ? 'low'
                : 'medium';
        const preferredRole: SwarmPreferredRole =
          t.preferredRole === '@docs' || t.preferredRole === '@reviewer' ? t.preferredRole : '@coder';
        return {
          filePath,
          complexity,
          preferredRole,
          requiredExports: Array.isArray(t.requiredExports)
            ? t.requiredExports.map(String)
            : [],
          requiredImports: Array.isArray(t.requiredImports)
            ? t.requiredImports.map(String)
            : [],
          instructions:
            String(t.instructions || '').trim() ||
            `Implement ${filePath} for: ${userTask}`,
          role: String(t.role || preferredRole || 'Worker')
        } as SwarmTask;
      })
      .filter((t: SwarmTask) => {
        const key = t.filePath.toLowerCase();
        if (seen.has(key)) return false;
        if (key === contractFile.toLowerCase()) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 6);

    if (!tasks.length) return null;
    return { contractFile, contractCode, tasks };
  } catch {
    return null;
  }
}

/** Deterministic fallback when Pass 1 JSON fails — still produces a usable contract. */
export function fallbackSwarmManifest(userTask: string): SwarmManifest {
  const lower = userTask.toLowerCase();
  const isWeb =
    /\b(web|webpage|website|html|react|ui|dashboard|frontend)\b/.test(lower) ||
    !/\b(python|tkinter|desktop|windows app|cli)\b/.test(lower);

  if (isWeb) {
    return {
      contractFile: 'src/types/swarm-contract.ts',
      contractCode: `/** Shared contract for Conductor Swarm — do not redefine in worker files. */
export interface AppState {
  title: string;
  ready: boolean;
}

export type AppMessage = { type: 'ready' } | { type: 'error'; message: string };

export function createInitialState(): AppState {
  return { title: 'App', ready: false };
}
`,
      tasks: [
        {
          filePath: 'src/app.ts',
          complexity: 'high',
          preferredRole: '@coder',
          requiredExports: ['export function boot(): void'],
          requiredImports: [
            "import type { AppState } from './types/swarm-contract';",
            "import { createInitialState } from './types/swarm-contract';"
          ],
          instructions: `Implement application bootstrap using createInitialState for: ${userTask}`,
          role: 'Core App'
        },
        {
          filePath: 'src/ui.ts',
          complexity: 'medium',
          preferredRole: '@docs',
          requiredExports: ['export function renderApp(root: HTMLElement, state: AppState): void'],
          requiredImports: ["import type { AppState } from './types/swarm-contract';"],
          instructions: `Implement UI rendering helpers for: ${userTask}`,
          role: 'UI'
        },
        {
          filePath: 'index.html',
          complexity: 'low',
          preferredRole: '@reviewer',
          requiredExports: [],
          requiredImports: [],
          instructions: `Create index.html that loads the app entry for: ${userTask}`,
          role: 'HTML Shell'
        }
      ]
    };
  }

  return {
    contractFile: 'src/types/swarm-contract.ts',
    contractCode: `/** Shared contract for Conductor Swarm. */
export interface AppConfig {
  name: string;
  version: string;
}

export function getDefaultConfig(): AppConfig {
  return { name: 'app', version: '0.1.0' };
}
`,
    tasks: [
      {
        filePath: 'src/main.ts',
        complexity: 'high',
        preferredRole: '@coder',
        requiredExports: ['export function main(): void'],
        requiredImports: [
          "import type { AppConfig } from './types/swarm-contract';",
          "import { getDefaultConfig } from './types/swarm-contract';"
        ],
        instructions: `Implement main entry for: ${userTask}`,
        role: 'Main'
      },
      {
        filePath: 'src/services.ts',
        complexity: 'medium',
        preferredRole: '@coder',
        requiredExports: ['export function describeConfig(cfg: AppConfig): string'],
        requiredImports: ["import type { AppConfig } from './types/swarm-contract';"],
        instructions: `Implement service helpers for: ${userTask}`,
        role: 'Services'
      }
    ]
  };
}

export function buildLeadArchitectPrompt(
  userTask: string,
  workspaceOverview: string,
  existingSnippets: string
): string {
  return `You are the Lead Architect (@coder) for LocalAgents Studio's Conductor Swarm.
Your job is to decompose a multi-file coding request into a strict TypeScript contract BEFORE parallel GPU workers write the implementation files.

### WORKSPACE CONTEXT
Existing file tree:
${workspaceOverview || '(empty or unknown)'}

Relevant existing files:
${existingSnippets || '(none loaded)'}

### USER REQUEST
${userTask}

### OUTPUT REQUIREMENTS
Respond ONLY with a valid JSON object matching this exact schema. Do NOT write implementation bodies.
1. \`contractFile\`: Path where shared interfaces/types must be written (or updated). Prefer \`src/types/swarm-contract.ts\`.
2. \`contractCode\`: Complete, valid TypeScript that typechecks alone. Prefer shared \`interface\`/\`type\`/\`enum\`. If the contract exports helpers, include minimal stub bodies (not ambient \`declare\`) so \`tsc --noEmit\` succeeds.
3. \`tasks\`: Array of distinct files to implement in parallel. Each task MUST have a unique \`filePath\` (never the contract file, never duplicates).

Schema:
{
  "contractFile": "src/types/swarm-contract.ts",
  "contractCode": "export interface Example { id: string }\\n",
  "tasks": [
    {
      "filePath": "src/example.ts",
      "complexity": "high",
      "preferredRole": "@coder",
      "requiredExports": ["export function run(): void"],
      "requiredImports": ["import type { Example } from './types/swarm-contract';"],
      "instructions": "Implement run() using the shared contract."
    }
  ]
}

Use complexity "high" | "medium" | "low" and preferredRole "@coder" | "@docs" | "@reviewer".
Prefer 2–4 tasks. Output JSON only.`;
}

export function buildContractRepairPrompt(
  userTask: string,
  previous: SwarmManifest,
  tscError: string
): string {
  return `You previously produced a Swarm TypeScript contract that failed typecheck.

### USER REQUEST
${userTask}

### PREVIOUS MANIFEST (fix contractCode; keep tasks unless a path must change)
${JSON.stringify(previous, null, 2)}

### TSC ERRORS
${tscError}

Return the FULL corrected JSON manifest (same schema). Fix \`contractCode\` so \`tsc --noEmit\` succeeds. JSON only.`;
}

export function buildSwarmWorkerPrompt(opts: {
  task: SwarmTask;
  contractFile: string;
  contractCode: string;
  siblingSummary: string;
  currentFileContent?: string;
  userPrompt: string;
}): string {
  const { task, contractFile, contractCode, siblingSummary, currentFileContent, userPrompt } = opts;
  const imports = task.requiredImports.length
    ? task.requiredImports.map(i => `- ${i}`).join('\n')
    : '- (none specified — import shared types from the contract path as needed)';
  const exports = task.requiredExports.length
    ? task.requiredExports.map(e => `- ${e}`).join('\n')
    : '- (export the public API described in the instructions)';

  return `You are an autonomous GPU Worker in a distributed Conductor Swarm.
You are assigned to implement ONE specific file: \`${task.filePath}\`.
Other GPU nodes are simultaneously writing the sibling files.

### STRICT CONTRACT RULES (DO NOT VIOLATE)
1. You MUST import shared types exactly as specified:
${imports}

2. Here is the exact read-only TypeScript contract (\`${contractFile}\`) already written to disk:
\`\`\`typescript
${contractCode}
\`\`\`

3. Your file MUST export these exact signatures (do not rename parameters, return types, or export names):
${exports}

4. Do NOT redefine interfaces/types that already exist in \`${contractFile}\`.
5. Scope your output strictly to \`${task.filePath}\`.

### SIBLING FILES (written in parallel)
${siblingSummary}

### CURRENT FILE CONTENT
${currentFileContent?.trim()
  ? currentFileContent
  : '(new file — create it from scratch)'}

### TASK INSTRUCTIONS
${task.instructions}

### OVERALL USER REQUEST
${userPrompt}

Output the complete file using:
<write_file path="${task.filePath}">
...complete code...
</write_file>
Do not omit code with placeholders.`;
}

export function buildRepairWorkerPrompt(opts: {
  task: SwarmTask;
  contractFile: string;
  contractCode: string;
  currentFileContent: string;
  tscErrors: string;
}): string {
  return `You own \`${opts.task.filePath}\` in a Conductor Swarm. Workspace typecheck failed for your file.

### CONTRACT (\`${opts.contractFile}\`) — read-only
\`\`\`typescript
${opts.contractCode}
\`\`\`

### REQUIRED EXPORTS
${opts.task.requiredExports.map(e => `- ${e}`).join('\n') || '(see file)'}

### REQUIRED IMPORTS
${opts.task.requiredImports.map(i => `- ${i}`).join('\n') || '(see file)'}

### CURRENT FILE
\`\`\`
${opts.currentFileContent}
\`\`\`

### TSC ERRORS (fix these)
${opts.tscErrors}

Output a corrected full file via:
<write_file path="${opts.task.filePath}">
...fixed code...
</write_file>`;
}

function nodeTokPerSec(n: EndpointNode, model: string): number {
  const bm = n.benchmarks?.[model];
  if (bm?.evalTokPerSec) return Math.max(bm.evalTokPerSec, 5);
  if (isFrontierNode(n)) return 80;
  return Math.max(Math.round((n.hardware?.gpuBandwidthGBs || 300) / 6), 5);
}

function roleMatches(n: EndpointNode, preferred: SwarmPreferredRole): boolean {
  const roles = n.roles || [];
  if (preferred === '@coder') return roles.includes('coder') || roles.includes('planner');
  if (preferred === '@docs') return roles.includes('docs');
  if (preferred === '@reviewer') return roles.includes('reviewer');
  return false;
}

/**
 * Lead Architect node: prefer high-VRAM local (≥16GB) coder, else best local, else frontier.
 */
export function findLeadArchitect(
  nodes: EndpointNode[]
): { node: EndpointNode; model: string; tokPerSec: number; usedFrontierBackup?: boolean } | null {
  const online = nodes.filter(n => n.online && getEnabledModelsForNode(n).length > 0);
  const local = online.filter(n => !isFrontierNode(n));
  const highVram = local.filter(n => (n.hardware?.vramGB || 0) >= 16);

  const scoreNode = (n: EndpointNode) => {
    const model = pickBestModelForComplexity(n, 'heavy');
    const speed = nodeTokPerSec(n, model);
    const vram = n.hardware?.vramGB || 0;
    const roleBonus = roleMatches(n, '@coder') ? 200 : 0;
    return { model, speed, score: vram * 50 + speed + roleBonus };
  };

  const pool = highVram.length > 0 ? highVram : local.length > 0 ? local : online;
  if (!pool.length) return null;

  let best = pool[0];
  let bestMeta = scoreNode(best);
  for (const n of pool) {
    const meta = scoreNode(n);
    if (meta.score > bestMeta.score) {
      best = n;
      bestMeta = meta;
    }
  }

  return {
    node: best,
    model: bestMeta.model,
    tokPerSec: bestMeta.speed,
    usedFrontierBackup: isFrontierNode(best)
  };
}

/**
 * Assign Pass-2 tasks across online GPUs using live tok/s + complexity + role bonus.
 * Local-first: frontier only when no local workers exist.
 */
export function assignSwarmTasksToCluster(
  tasks: SwarmTask[],
  nodes: EndpointNode[]
): SwarmAssignment[] {
  const online = nodes.filter(n => n.online && getEnabledModelsForNode(n).length > 0);
  const local = online.filter(n => !isFrontierNode(n));
  const frontier = online.filter(isFrontierNode);
  const usedFrontierBackup = local.length === 0 && frontier.length > 0;
  const activeNodes = local.length > 0 ? local : frontier;

  const sortedTasks = [...tasks].sort(
    (a, b) => COMPLEXITY_WEIGHT[b.complexity] - COMPLEXITY_WEIGHT[a.complexity]
  );

  if (!activeNodes.length) {
    const any = nodes.filter(n => getEnabledModelsForNode(n).length > 0);
    const pool = any.length ? any : nodes;
    if (!pool.length) return [];
    return sortedTasks.map((task, idx) => {
      const node = pool[idx % pool.length];
      return {
        task,
        node,
        model: pickBestModelForComplexity(node, toConductorComplexity(task.complexity)),
        skippedReason: node.online ? undefined : 'Node offline — assignment may fail',
        usedFrontierBackup: isFrontierNode(node)
      };
    });
  }

  const nodeLoad = new Map<string, number>(activeNodes.map(n => [n.id, 0]));

  return sortedTasks.map(task => {
    let bestNode = activeNodes[0];
    let bestScore = Infinity;

    for (const node of activeNodes) {
      const model = pickBestModelForComplexity(node, toConductorComplexity(task.complexity));
      const speed = nodeTokPerSec(node, model);
      const currentLoad = nodeLoad.get(node.id) ?? 0;
      const estimatedTokens = COMPLEXITY_WEIGHT[task.complexity] * 400;
      const roleBonus = roleMatches(node, task.preferredRole) ? 0.75 : 1.0;
      const estimatedTimeCost = ((currentLoad + estimatedTokens) / speed) * roleBonus;
      if (estimatedTimeCost < bestScore) {
        bestScore = estimatedTimeCost;
        bestNode = node;
      }
    }

    const model = pickBestModelForComplexity(
      bestNode,
      toConductorComplexity(task.complexity)
    );
    nodeLoad.set(
      bestNode.id,
      (nodeLoad.get(bestNode.id) ?? 0) + COMPLEXITY_WEIGHT[task.complexity] * 400
    );

    return {
      task,
      node: bestNode,
      model,
      usedFrontierBackup,
      skippedReason: usedFrontierBackup
        ? 'Frontier backup — no local Ollama nodes online'
        : undefined
    };
  });
}

/** Group tsc stderr lines by relative file path (best-effort). */
export function groupTscErrorsByFile(
  tscOutput: string,
  workspaceRoot: string
): Map<string, string> {
  const map = new Map<string, string>();
  const rootNorm = workspaceRoot.replace(/[\\/]+$/, '').toLowerCase();
  const lines = tscOutput.split(/\r?\n/);
  let currentFile = '';

  for (const line of lines) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error TS\d+:.+)$/i)
      || line.match(/^(.+?):(\d+):(\d+)\s+-\s+(error TS\d+:.+)$/i);
    if (m) {
      let file = m[1].trim().replace(/\\/g, '/');
      const absLower = file.toLowerCase();
      if (absLower.startsWith(rootNorm.replace(/\\/g, '/'))) {
        file = file.slice(workspaceRoot.length).replace(/^[\\/]+/, '');
      }
      // Also handle paths already relative
      file = file.replace(/\\/g, '/');
      currentFile = file;
      const prev = map.get(currentFile) || '';
      map.set(currentFile, prev ? `${prev}\n${line}` : line);
    } else if (currentFile && line.trim()) {
      map.set(currentFile, `${map.get(currentFile)}\n${line}`);
    }
  }
  return map;
}

export function isTypeScriptContractPath(filePath: string): boolean {
  return /\.tsx?$/i.test(filePath);
}
