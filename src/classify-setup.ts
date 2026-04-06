import { execFileSync } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin as processStdin, stdout as processStdout } from 'node:process';
import { geminiEnvLocalPath, loadEnv, writeGeminiApiKeyToEnvLocal } from './config.js';
import type { Engine } from './types.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const WHITE = '\x1b[97m';
const RED = '\x1b[38;5;196m';
const RED_SOFT = '\x1b[38;5;203m';
const GREEN = '\x1b[32m';
const GOLD = '\x1b[33m';

export interface ClassifySetupInput {
  engine?: Engine;
  model?: string;
  batchSize?: number;
  concurrency?: number;
  limit?: number;
  defaultGeminiModel: string;
  defaultBatchSize: number;
  defaultConcurrency: number;
}

export interface ClassifySetupResult {
  engine: Engine;
  model?: string;
  batchSize: number;
  concurrency: number;
  limit?: number;
  profileLabel: string;
  keySource?: 'env';
}

interface EngineChoice {
  engine: Engine;
  label: string;
  description: string;
  available: boolean;
  recommended?: boolean;
  needsSetup?: boolean;
}

interface ClassifyProfile {
  label: string;
  description: string;
  model: string;
  batchSize: number;
  concurrency: number;
  recommended?: boolean;
}

const PROFILE_FOOTER = `${DIM}Tip:${RESET} pass ${BOLD}--engine${RESET}, ${BOLD}--model${RESET}, ${BOLD}--batch-size${RESET}, or ${BOLD}--concurrency${RESET} to skip the guided setup.`;

function isInteractiveTerminal(): boolean {
  return Boolean(processStdin.isTTY && processStdout.isTTY);
}

function commandExists(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getGeminiApiKey(): string | null {
  loadEnv();
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null;
}

function buildProfiles(defaultGeminiModel: string): ClassifyProfile[] {
  return [
    {
      label: 'Rocket',
      description: 'YouTube-redline speed. Best for large archives and fast broad labeling.',
      model: defaultGeminiModel,
      batchSize: 50,
      concurrency: 10,
      recommended: true,
    },
    {
      label: 'Balanced',
      description: 'Same model, gentler burst rate. Better if you want steadier throughput.',
      model: defaultGeminiModel,
      batchSize: 50,
      concurrency: 6,
    },
    {
      label: 'Careful',
      description: 'Smaller batches and fewer workers for the quietest run.',
      model: defaultGeminiModel,
      batchSize: 25,
      concurrency: 3,
    },
  ];
}

function resolveRecommendedEngine(): Engine | null {
  if (getGeminiApiKey()) return 'gemini';
  if (commandExists('claude')) return 'claude';
  if (commandExists('codex')) return 'codex';
  return null;
}

function buildEngineChoices(): EngineChoice[] {
  const geminiAvailable = Boolean(getGeminiApiKey());
  const claudeAvailable = commandExists('claude');
  const codexAvailable = commandExists('codex');
  const recommended = resolveRecommendedEngine();

  return [
    {
      engine: 'gemini',
      label: geminiAvailable ? 'Gemini API' : 'Gemini API (set up key)',
      description: 'Fastest path. Uses your own Gemini API key and supports concurrent batches.',
      available: geminiAvailable,
      recommended: recommended === 'gemini',
      needsSetup: !geminiAvailable,
    },
    {
      engine: 'claude',
      label: 'Claude CLI',
      description: 'Uses your local Claude Code login through the Claude CLI.',
      available: claudeAvailable,
      recommended: recommended === 'claude',
    },
    {
      engine: 'codex',
      label: 'Codex CLI',
      description: 'Uses your local Codex login through the Codex CLI.',
      available: codexAvailable,
      recommended: recommended === 'codex',
    },
  ];
}

async function promptForSecretInput(label: string): Promise<string | null> {
  if (!isInteractiveTerminal() || typeof processStdin.setRawMode !== 'function') {
    const rl = createInterface({ input: processStdin, output: processStdout });
    try {
      const value = (await rl.question(`${label}: `)).trim();
      return value || null;
    } finally {
      rl.close();
    }
  }

  emitKeypressEvents(processStdin);
  processStdin.resume();
  processStdin.setRawMode(true);

  return new Promise<string | null>((resolve) => {
    let value = '';

    const render = () => {
      const masked = value.length === 0
        ? ''
        : `${'•'.repeat(Math.min(value.length, 24))}${value.length > 24 ? ` (${value.length} chars)` : ''}`;
      processStdout.write(`\r\x1b[2K${label}: ${masked}`);
    };

    const cleanup = (result: string | null) => {
      processStdin.off('keypress', onKeypress);
      processStdin.setRawMode(false);
      processStdout.write('\r\x1b[2K');
      resolve(result);
    };

    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key?.name === 'return' || key?.name === 'enter') {
        processStdout.write('\n');
        cleanup(value.trim() || null);
        return;
      }

      if (key?.name === 'escape' || (key?.ctrl && key?.name === 'c')) {
        processStdout.write('\n');
        cleanup(null);
        return;
      }

      if (key?.name === 'backspace') {
        value = value.slice(0, -1);
        render();
        return;
      }

      if (typeof str === 'string' && str.length > 0 && !key?.ctrl && !key?.meta) {
        value += str;
        render();
      }
    };

    processStdin.on('keypress', onKeypress);
    render();
  });
}

async function maybePromptForGeminiKey(): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    return false;
  }

  processStdout.write(`\n${BOLD}${WHITE}Gemini API setup${RESET}\n`);
  processStdout.write(`${RED_SOFT}Paste${RESET} your ${BOLD}GEMINI_API_KEY${RESET} and press Enter.\n`);
  processStdout.write(`It will be saved to ${geminiEnvLocalPath()}.\n`);
  processStdout.write('Press Esc or submit an empty value to cancel.\n\n');

  const apiKey = await promptForSecretInput('GEMINI_API_KEY');
  if (!apiKey) {
    processStdout.write('Setup cancelled.\n');
    return false;
  }

  const envPath = writeGeminiApiKeyToEnvLocal(apiKey);
  process.env.GEMINI_API_KEY = apiKey;
  processStdout.write(`${GREEN}Gemini ready.${RESET} Saved key to ${envPath}\n`);
  return true;
}

function renderEngineMenu(choices: EngineChoice[], selectedIndex: number, linesRendered: number): number {
  const lines: string[] = [
    '',
    `${BOLD}${WHITE}Choose a classify engine${RESET}`,
    `${RED_SOFT}Gemini${RESET} is fastest. ${WHITE}Claude${RESET} and ${WHITE}Codex${RESET} reuse the CLIs you already log into.`,
    'Use Up/Down or j/k, then press Enter. Press Esc to cancel.',
    '',
  ];

  for (const [index, choice] of choices.entries()) {
    const selected = index === selectedIndex;
    const marker = selected ? `${RED}>${RESET}` : ' ';
    const label = selected ? `${RED}${choice.label}${RESET}` : choice.label;
    const tags = [
      choice.recommended ? `${GOLD}recommended${RESET}` : null,
      !choice.available && choice.engine !== 'gemini' ? `${DIM}not installed${RESET}` : null,
      choice.needsSetup ? `${DIM}setup required${RESET}` : null,
    ].filter(Boolean).join(` ${DIM}•${RESET} `);
    lines.push(` ${marker} ${label}${tags ? `  ${tags}` : ''}`);
    lines.push(`   ${choice.description}`);
    lines.push('');
  }

  const output = `${lines.join('\n')}\n`;
  if (linesRendered > 0) {
    processStdout.write(`\x1b[${linesRendered}A`);
  }
  processStdout.write('\x1b[J');
  processStdout.write(output);
  return lines.length + 1;
}

async function maybePromptForEngineChoice(): Promise<EngineChoice | null> {
  const choices = buildEngineChoices().filter((choice) => choice.available || choice.engine === 'gemini');
  if (!isInteractiveTerminal() || choices.length === 0) {
    return null;
  }

  if (typeof processStdin.setRawMode !== 'function') {
    return choices.find((choice) => choice.recommended) ?? choices[0] ?? null;
  }

  let selectedIndex = Math.max(0, choices.findIndex((choice) => choice.recommended));
  let linesRendered = 0;

  emitKeypressEvents(processStdin);
  processStdin.resume();
  processStdout.write('\x1b[?25l');
  processStdin.setRawMode(true);

  return new Promise<EngineChoice | null>((resolve) => {
    const cleanup = (result: EngineChoice | null, summary?: string) => {
      processStdin.off('keypress', onKeypress);
      processStdin.setRawMode(false);
      processStdout.write('\x1b[?25h');
      if (linesRendered > 0) {
        processStdout.write(`\x1b[${linesRendered}A`);
      }
      processStdout.write('\x1b[J');
      if (summary) {
        processStdout.write(`${summary}\n`);
      }
      resolve(result);
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key?.name === 'up' || key?.name === 'k') {
        selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
        linesRendered = renderEngineMenu(choices, selectedIndex, linesRendered);
        return;
      }

      if (key?.name === 'down' || key?.name === 'j') {
        selectedIndex = (selectedIndex + 1) % choices.length;
        linesRendered = renderEngineMenu(choices, selectedIndex, linesRendered);
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        const choice = choices[selectedIndex];
        cleanup(choice, `Selected engine: ${choice.label}`);
        return;
      }

      if (key?.name === 'escape' || (key?.ctrl && key?.name === 'c')) {
        cleanup(null, 'Classification setup cancelled.');
      }
    };

    processStdin.on('keypress', onKeypress);
    linesRendered = renderEngineMenu(choices, selectedIndex, linesRendered);
  });
}

function renderProfileMenu(profiles: ClassifyProfile[], selectedIndex: number, linesRendered: number): number {
  const lines: string[] = [
    '',
    `${BOLD}${WHITE}Choose a Gemini launch profile${RESET}`,
    `${RED_SOFT}YouTube-tuned defaults${RESET} for big archives and noisy real-world metadata.`,
    'Use Up/Down or j/k, then press Enter. Press Esc to cancel.',
    '',
  ];

  for (const [index, profile] of profiles.entries()) {
    const selected = index === selectedIndex;
    const marker = selected ? `${RED}>${RESET}` : ' ';
    const label = selected ? `${RED}${profile.label}${RESET}` : profile.label;
    const meta = `${DIM}${profile.model}${RESET}  ${DIM}•${RESET}  ${profile.batchSize} batch  ${DIM}•${RESET}  ${profile.concurrency} workers`;
    lines.push(` ${marker} ${label}${profile.recommended ? `  ${GOLD}recommended${RESET}` : ''}`);
    lines.push(`   ${profile.description}`);
    lines.push(`   ${meta}`);
    lines.push('');
  }
  lines.push(PROFILE_FOOTER);

  const output = `${lines.join('\n')}\n`;
  if (linesRendered > 0) {
    processStdout.write(`\x1b[${linesRendered}A`);
  }
  processStdout.write('\x1b[J');
  processStdout.write(output);
  return lines.length + 1;
}

async function maybePromptForProfile(profiles: ClassifyProfile[]): Promise<ClassifyProfile | null> {
  if (!isInteractiveTerminal()) {
    return null;
  }

  if (typeof processStdin.setRawMode !== 'function') {
    return profiles.find((profile) => profile.recommended) ?? profiles[0] ?? null;
  }

  let selectedIndex = Math.max(0, profiles.findIndex((profile) => profile.recommended));
  let linesRendered = 0;

  emitKeypressEvents(processStdin);
  processStdin.resume();
  processStdout.write('\x1b[?25l');
  processStdin.setRawMode(true);

  return new Promise<ClassifyProfile | null>((resolve) => {
    const cleanup = (result: ClassifyProfile | null, summary?: string) => {
      processStdin.off('keypress', onKeypress);
      processStdin.setRawMode(false);
      processStdout.write('\x1b[?25h');
      if (linesRendered > 0) {
        processStdout.write(`\x1b[${linesRendered}A`);
      }
      processStdout.write('\x1b[J');
      if (summary) {
        processStdout.write(`${summary}\n`);
      }
      resolve(result);
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key?.name === 'up' || key?.name === 'k') {
        selectedIndex = (selectedIndex - 1 + profiles.length) % profiles.length;
        linesRendered = renderProfileMenu(profiles, selectedIndex, linesRendered);
        return;
      }

      if (key?.name === 'down' || key?.name === 'j') {
        selectedIndex = (selectedIndex + 1) % profiles.length;
        linesRendered = renderProfileMenu(profiles, selectedIndex, linesRendered);
        return;
      }

      if (key?.name === 'return' || key?.name === 'enter') {
        const selected = profiles[selectedIndex];
        cleanup(selected, `Selected profile: ${selected.label}`);
        return;
      }

      if (key?.name === 'escape' || (key?.ctrl && key?.name === 'c')) {
        cleanup(null, 'Classification setup cancelled.');
      }
    };

    processStdin.on('keypress', onKeypress);
    linesRendered = renderProfileMenu(profiles, selectedIndex, linesRendered);
  });
}

function resolveEngine(preferredEngine?: Engine): Engine | null {
  if (preferredEngine === 'gemini') return getGeminiApiKey() ? 'gemini' : null;
  if (preferredEngine === 'claude') return commandExists('claude') ? 'claude' : null;
  if (preferredEngine === 'codex') return commandExists('codex') ? 'codex' : null;
  return resolveRecommendedEngine();
}

function formatMissingEngineMessage(preferredEngine?: Engine): string {
  if (preferredEngine === 'gemini') {
    return `Set GEMINI_API_KEY or GOOGLE_API_KEY in your shell, or save GEMINI_API_KEY to ${geminiEnvLocalPath()} before running classification.`;
  }
  if (preferredEngine === 'claude') {
    return 'Claude CLI was requested, but `claude` was not found in PATH.';
  }
  if (preferredEngine === 'codex') {
    return 'Codex CLI was requested, but `codex` was not found in PATH.';
  }

  return `No supported classification engine found. Set GEMINI_API_KEY/GOOGLE_API_KEY, or install ${BOLD}claude${RESET} or ${BOLD}codex${RESET}.`;
}

export async function resolveClassifySetup(input: ClassifySetupInput): Promise<ClassifySetupResult | null> {
  loadEnv();

  let engine = resolveEngine(input.engine);
  if (!input.engine && isInteractiveTerminal()) {
    const choice = await maybePromptForEngineChoice();
    if (!choice) {
      return null;
    }
    engine = choice.engine;
    if (choice.engine === 'gemini' && choice.needsSetup) {
      const saved = await maybePromptForGeminiKey();
      if (!saved) {
        return null;
      }
      engine = 'gemini';
    }
  } else if (input.engine === 'gemini' && !engine) {
    const saved = await maybePromptForGeminiKey();
    if (!saved) {
      throw new Error(formatMissingEngineMessage('gemini'));
    }
    engine = 'gemini';
  }

  if (!engine) {
    throw new Error(formatMissingEngineMessage(input.engine));
  }

  if (engine === 'gemini') {
    const hasCustomSettings = input.model != null || input.batchSize != null || input.concurrency != null;
    const keySource: 'env' = 'env';

    if (!hasCustomSettings && isInteractiveTerminal()) {
      const selected = await maybePromptForProfile(buildProfiles(input.defaultGeminiModel));
      if (!selected) {
        return null;
      }

      return {
        engine,
        model: selected.model,
        batchSize: selected.batchSize,
        concurrency: selected.concurrency,
        limit: input.limit,
        profileLabel: selected.label,
        keySource,
      };
    }

    return {
      engine,
      model: input.model ?? input.defaultGeminiModel,
      batchSize: Math.max(1, input.batchSize ?? input.defaultBatchSize),
      concurrency: Math.max(1, input.concurrency ?? input.defaultConcurrency),
      limit: input.limit,
      profileLabel: hasCustomSettings ? 'Custom Gemini' : 'Rocket',
      keySource,
    };
  }

  return {
    engine,
    batchSize: Math.max(1, input.batchSize ?? input.defaultBatchSize),
    concurrency: 1,
    limit: input.limit,
    profileLabel: engine === 'claude' ? 'Claude CLI' : 'Codex CLI',
  };
}
