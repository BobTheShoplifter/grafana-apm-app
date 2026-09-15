/**
 * Session-replay data access (#58/#67).
 *
 * TWO wire contracts are supported, both flattened by Alloy's faro.receiver into logfmt
 * `event_data_<key>` fields.
 *
 * A. @nais/apm's ReplayInstrumentation - batched, compressed:
 *
 *   kind=event event_name=faro.session_recording.chunk session_id=<sid>
 *   event_data_chunk_seq=<n> event_data_mode=snapshot|recording
 *   event_data_enc=gzip+b64 event_data_count=<events in chunk>
 *   event_data_data=<base64(gzip(JSON rrweb eventWithTime[]))>
 *
 * B. The upstream Grafana SDK, @grafana/faro-instrumentation-replay - one event per line,
 *    uncompressed:
 *
 *   kind=event event_name=faro.session_recording.event session_id=<sid>
 *   event_data_event=<JSON rrweb eventWithTime>
 *
 * B carries no sequence number, no mode and no encoding, so its events are ordered by their
 * own rrweb timestamp and reported as a continuous "recording". A session is read in ONE
 * format: chunks win when present, so nothing about A's behaviour changes and a deployment
 * that emits only A takes the identical code path it always did.
 *
 * Today chunks land under kind="event"; the future Alloy pipeline relabels
 * the stream to kind="replay" (dedicated 7d retention), so all queries here
 * match kind=~"event|replay".
 */
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { gunzipSync, strFromU8 } from 'fflate';
import { otel } from '../../../../otelconfig';
import { sanitizeLabelValue } from '../../../../utils/sanitize';
import { parseLogfmt } from '../exception-utils';

export type ReplayMode = 'snapshot' | 'recording';

/** rrweb eventWithTime — structurally typed so the heavy rrweb packages stay out of this module. */
export interface ReplayEventWithTime {
  type: number;
  data: unknown;
  timestamp: number;
}

export interface ReplayQueryOptions {
  logsUid: string;
  service: string;
  sessionId: string;
  fromMs: number;
  toMs: number;
  environment?: string;
  /** Stream label used for the environment matcher (defaults to otel.labels.deploymentEnv). */
  environmentLabel?: string;
}

export interface ReplayData {
  /** All rrweb events for the session, chunk-ordered and concatenated. */
  events: ReplayEventWithTime[];
  mode: ReplayMode;
  chunkCount: number;
}

export interface ReplayProbeResult {
  hasChunks: boolean;
  /** "recording" wins when a session has both snapshot and recording chunks. */
  mode: ReplayMode | null;
  chunkCount: number;
}

/** The only chunk encoding this plugin version understands (format is versioned via `enc`). */
const SUPPORTED_ENC = 'gzip+b64';

/** Millisecond timestamp → Loki nanosecond string (string concat avoids float precision loss). */
function msToNs(ms: number): string {
  return `${Math.floor(ms)}000000`;
}

/**
 * Shared log pipeline: stream selector + cheap line prefilters (Loki skips
 * logfmt-parsing lines that miss them) + exact session match.
 */
function buildReplayPipeline(opts: ReplayQueryOptions): string {
  const fl = otel.faroLoki;
  const service = sanitizeLabelValue(opts.service);
  const sessionId = sanitizeLabelValue(opts.sessionId);
  const envLabel = opts.environmentLabel || otel.labels.deploymentEnv;
  const envStream = opts.environment ? `, ${envLabel}="${sanitizeLabelValue(opts.environment)}"` : '';
  const selector = `{${fl.serviceName}="${service}", ${fl.kind}=~"${fl.kindEvent}|${fl.kindReplay}"${envStream}}`;
  // A regex line filter rather than two `|=` terms: `|=` clauses are ANDed, so requiring both
  // event names would match nothing at all. Dots are escaped because this is a regex now.
  const eventNames = [fl.replayChunkEvent, fl.replayEventEvent].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return `${selector} |~ \`${eventNames}\` |= \`${sessionId}\` | logfmt | ${fl.sessionId}="${sessionId}"`;
}

/**
 * Decode one single-event payload (format B): plain JSON rrweb eventWithTime.
 *
 * Returns null instead of throwing on anything that is not a usable event. One malformed
 * line in a session of thousands must not take the whole replay down, and an rrweb player
 * fed an object without a numeric `type`/`timestamp` fails far less legibly than a skip.
 */
export function decodeReplayEvent(json: string): ReplayEventWithTime | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.type === 'number' && typeof parsed.timestamp === 'number') {
      return parsed as ReplayEventWithTime;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Decode one chunk payload: base64 → gunzip → JSON rrweb eventWithTime[]. */
export function decodeReplayChunk(b64: string): ReplayEventWithTime[] {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  const parsed = JSON.parse(strFromU8(gunzipSync(bytes)));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Order and de-duplicate single-event (format B) lines.
 *
 * There is no sequence number to sort on, so the rrweb timestamp is the ordering key - which
 * is what the player uses anyway. De-duplication is by timestamp AND type together: Loki
 * retries can deliver the same line twice, while two genuinely different events can share a
 * millisecond, and dropping one of those would silently lose a DOM mutation.
 */
function assembleSingles(events: ReplayEventWithTime[]): ReplayData {
  const seen = new Set<string>();
  const unique: ReplayEventWithTime[] = [];
  for (const event of events) {
    // The WHOLE event is the key. An earlier version keyed on timestamp+type, which looked
    // sufficient and is not: a burst of DOM mutations routinely lands several distinct type-3
    // events on the same millisecond, and collapsing those silently drops real changes - the
    // replay then plays back a page that never updates.
    const key = JSON.stringify(event);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(event);
  }
  unique.sort((a, b) => a.timestamp - b.timestamp);
  // "recording" because this SDK streams continuously; it has no snapshot-only mode to report.
  return { events: unique, mode: 'recording', chunkCount: unique.length };
}

/**
 * Fetch and reassemble a session's replay: query Loki via the datasource proxy, then either
 * order chunks by chunk_seq and gunzip them (format A) or order single events by their rrweb
 * timestamp (format B). Returns null when the session has neither in the range.
 */
export async function fetchReplay(opts: ReplayQueryOptions): Promise<ReplayData | null> {
  const res = await lastValueFrom(
    getBackendSrv().fetch<any>({
      url: `/api/datasources/proxy/uid/${encodeURIComponent(opts.logsUid)}/loki/api/v1/query_range`,
      params: {
        query: buildReplayPipeline(opts),
        limit: '1000',
        direction: 'forward',
        start: msToNs(opts.fromMs),
        end: msToNs(opts.toMs),
      },
      method: 'GET',
    })
  );

  const fl = otel.faroLoki;
  const streams = res.data?.data?.result ?? [];
  const chunks: Array<{ seq: number; mode?: string; enc?: string; data: string }> = [];
  const singles: ReplayEventWithTime[] = [];
  streams.forEach((stream: any) => {
    (stream.values ?? []).forEach((val: [string, string]) => {
      const p = parseLogfmt(val[1]);
      if (p[fl.replayChunkField]) {
        chunks.push({
          seq: Number(p.event_data_chunk_seq),
          mode: p.event_data_mode,
          enc: p.event_data_enc,
          data: p[fl.replayChunkField],
        });
        return;
      }
      const single = p[fl.replayEventField] ? decodeReplayEvent(p[fl.replayEventField]) : null;
      if (single) {
        singles.push(single);
      }
    });
  });

  // Chunks win: a session that has them is a @nais/apm session and takes the original path
  // untouched. Only a session with no chunks at all falls through to the single-event format.
  if (chunks.length === 0) {
    return singles.length > 0 ? assembleSingles(singles) : null;
  }

  chunks.sort((a, b) => a.seq - b.seq);

  const events: ReplayEventWithTime[] = [];
  const seen = new Set<number>();
  let decoded = 0;
  for (const chunk of chunks) {
    if (Number.isFinite(chunk.seq) && seen.has(chunk.seq)) {
      continue; // Loki retries can duplicate lines — keep the first of each seq
    }
    seen.add(chunk.seq);
    if (chunk.enc && chunk.enc !== SUPPORTED_ENC) {
      throw new Error(
        `Unsupported replay chunk encoding "${chunk.enc}" (this plugin understands "${SUPPORTED_ENC}") — update the plugin.`
      );
    }
    events.push(...decodeReplayChunk(chunk.data));
    decoded++;
  }

  return {
    events,
    mode: chunks.some((c) => c.mode === 'recording') ? 'recording' : 'snapshot',
    chunkCount: decoded,
  };
}

/** One recorded session, for the list that lets you reach a replay without an exception. */
export interface ReplaySessionSummary {
  sessionId: string;
  /** Replay lines seen in the window - a rough proxy for how much there is to watch. */
  events: number;
  /** Epoch ms of the last bucket that carried anything, i.e. when the session was last active. */
  lastSeenMs: number;
}

/**
 * List the sessions that have replay data for a service in the window, most recent first.
 *
 * WHY THIS EXISTS. Replay was reachable from exactly one place: an exception drawer. That is
 * the right entry point when you are investigating an error, and the only one when a session
 * is recorded solely because an error happened. But a continuously-recording SDK produces
 * sessions for people who hit no error at all, and those were unreachable - the data sat in
 * Loki with nothing in the UI pointing at it.
 *
 * A metric query rather than a log query on purpose: the payloads are large and none of them
 * are needed to draw a list. Counting by session_id moves the aggregation into Loki and keeps
 * the response to one number per session.
 */
export async function listReplaySessions(
  opts: Omit<ReplayQueryOptions, 'sessionId'> & { limit?: number }
): Promise<ReplaySessionSummary[]> {
  const fl = otel.faroLoki;
  const service = sanitizeLabelValue(opts.service);
  const envLabel = opts.environmentLabel || otel.labels.deploymentEnv;
  const envStream = opts.environment ? `, ${envLabel}="${sanitizeLabelValue(opts.environment)}"` : '';
  const eventNames = [fl.replayChunkEvent, fl.replayEventEvent]
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const selector = `{${fl.serviceName}="${service}", ${fl.kind}=~"${fl.kindEvent}|${fl.kindReplay}"${envStream}}`;

  // 24 buckets across the window, floored at a minute: enough resolution to say WHEN a session
  // was last active without asking Loki for a point per scrape.
  const rangeSec = Math.max(60, Math.ceil((opts.toMs - opts.fromMs) / 1000));
  const stepSec = Math.max(60, Math.floor(rangeSec / 24));
  const query =
    `sum by (${fl.sessionId}) (count_over_time(${selector} |~ \`${eventNames}\` | logfmt ` +
    `| ${fl.sessionId}!="" [${stepSec}s]))`;

  const res = await lastValueFrom(
    getBackendSrv().fetch<any>({
      url: `/api/datasources/proxy/uid/${encodeURIComponent(opts.logsUid)}/loki/api/v1/query_range`,
      params: {
        query,
        start: msToNs(opts.fromMs),
        end: msToNs(opts.toMs),
        step: `${stepSec}s`,
      },
      method: 'GET',
    })
  );

  const sessions: ReplaySessionSummary[] = [];
  for (const series of res.data?.data?.result ?? []) {
    const sessionId = series.metric?.[fl.sessionId];
    if (!sessionId) {
      continue;
    }
    let events = 0;
    let lastSeenMs = 0;
    for (const [tsSec, value] of series.values ?? []) {
      const n = Number(value);
      if (!(n > 0)) {
        continue;
      }
      events += n;
      lastSeenMs = Math.max(lastSeenMs, Number(tsSec) * 1000);
    }
    if (events > 0) {
      sessions.push({ sessionId, events, lastSeenMs });
    }
  }

  sessions.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  return sessions.slice(0, opts.limit ?? 25);
}

/**
 * Cheap existence probe: a count-only Loki metric query (no chunk payloads
 * cross the wire) grouped by mode, so the drawer knows whether to offer
 * "Play replay" (recording) or "View snapshot" (snapshot-only session).
 */
export async function probeReplay(opts: ReplayQueryOptions): Promise<ReplayProbeResult> {
  const rangeSec = Math.max(1, Math.ceil((opts.toMs - opts.fromMs) / 1000));
  const query = `sum by (event_data_mode) (count_over_time(${buildReplayPipeline(opts)} [${rangeSec}s]))`;

  const res = await lastValueFrom(
    getBackendSrv().fetch<any>({
      url: `/api/datasources/proxy/uid/${encodeURIComponent(opts.logsUid)}/loki/api/v1/query`,
      params: {
        query,
        time: msToNs(opts.toMs),
      },
      method: 'GET',
    })
  );

  const samples = res.data?.data?.result ?? [];
  let chunkCount = 0;
  let mode: ReplayMode | null = null;
  for (const sample of samples) {
    const value = Number(sample.value?.[1] ?? 0);
    if (!(value > 0)) {
      continue;
    }
    chunkCount += value;
    const sampleMode = sample.metric?.event_data_mode;
    if (sampleMode === 'recording') {
      mode = 'recording';
    } else if (sampleMode === 'snapshot' && mode !== 'recording') {
      mode = 'snapshot';
    } else if (!sampleMode && mode !== 'recording') {
      // Format B lines carry no mode label, so the series comes back with it absent. Without
      // this branch a session recorded by the upstream SDK probes as "has chunks, mode null"
      // and the drawer offers neither Play nor View snapshot - data present, no way in.
      mode = 'recording';
    }
  }

  return { hasChunks: chunkCount > 0, mode, chunkCount };
}
