import { config, getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import pluginJson from '../plugin.json';

const BASE_URL = `/api/plugins/${pluginJson.id}/resources`;

export interface InvestigateStatus {
  available: boolean;
  model?: string;
}

/** Whether the AI investigation is configured. Any failure reads as unavailable. */
export async function getInvestigateStatus(): Promise<InvestigateStatus> {
  try {
    const res = await lastValueFrom(
      getBackendSrv().fetch<InvestigateStatus>({ url: `${BASE_URL}/investigate/status`, showErrorAlert: false })
    );
    return res.data ?? { available: false };
  } catch {
    return { available: false };
  }
}

export interface InvestigationUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type InvestigationEvent =
  | { type: 'start'; model: string; rounds: number }
  | { type: 'progress'; round: number; text: string }
  | { type: 'tool_call'; round: number; id: string; name: string; input: unknown }
  | { type: 'tool_result'; round: number; id: string; name: string; ok: boolean; chars: number; preview: string }
  | { type: 'text'; round: number; text: string }
  | { type: 'done'; rounds: number; stopReason: string; usage: InvestigationUsage }
  | { type: 'error'; message: string };

const EVENT_TYPES = new Set(['start', 'progress', 'tool_call', 'tool_result', 'text', 'done', 'error']);

/**
 * Split a server-sent-events buffer into complete events and the unfinished remainder.
 * Comments (keep-alives) and unknown event types are dropped.
 */
export function parseSSE(buffer: string): { events: InvestigationEvent[]; rest: string } {
  const events: InvestigationEvent[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let type = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        type = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).trimStart());
      }
    }
    if (!EVENT_TYPES.has(type) || data.length === 0) {
      continue;
    }
    try {
      events.push({ type, ...JSON.parse(data.join('\n')) } as InvestigationEvent);
    } catch {
      // A malformed event is skipped; the stream continues.
    }
  }
  return { events, rest };
}

export interface InvestigateArgs {
  namespace: string;
  service: string;
  question: string;
  fromMs: number;
  toMs: number;
  environment?: string;
}

/**
 * Run an investigation, calling onEvent for every event until the stream ends. Abort the
 * signal to stop it (the backend stops working when the connection closes).
 */
export async function runInvestigation(
  args: InvestigateArgs,
  onEvent: (e: InvestigationEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const ns = encodeURIComponent(args.namespace || '_');
  const url = `${config.appSubUrl ?? ''}${BASE_URL}/services/${ns}/${encodeURIComponent(args.service)}/investigate`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Grafana-Org-Id': String(config.bootData?.user?.orgId ?? ''),
    },
    body: JSON.stringify({
      question: args.question,
      from: Math.round(args.fromMs),
      to: Math.round(args.toMs),
      environment: args.environment ?? '',
    }),
  });
  if (!res.ok || !res.body) {
    const text = (await res.text().catch(() => '')).trim();
    throw new Error(text || `The investigation could not start (HTTP ${res.status}).`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSSE(buffer);
    buffer = parsed.rest;
    parsed.events.forEach(onEvent);
  }
  const tail = parseSSE(buffer + '\n\n');
  tail.events.forEach(onEvent);
}
