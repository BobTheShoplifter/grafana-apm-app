import { of } from 'rxjs';
import { gzipSync, strToU8 } from 'fflate';
import { fetchReplay, probeReplay, decodeReplayChunk, decodeReplayEvent, ReplayEventWithTime } from './fetchReplay';

const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: (options: unknown) => mockFetch(options) }),
}));

/** Round-trip half of the SDK's transport: gzip the rrweb event array and base64 it. */
function encodeChunk(events: ReplayEventWithTime[]): string {
  return Buffer.from(gzipSync(strToU8(JSON.stringify(events)))).toString('base64');
}

/** One Loki logfmt line as Alloy's faro.receiver flattens a chunk event. */
function chunkLine(seq: number, mode: 'snapshot' | 'recording', events: ReplayEventWithTime[], enc = 'gzip+b64') {
  return (
    `kind=event event_name=faro.session_recording.chunk session_id=sess-1 ` +
    `event_data_chunk_seq=${seq} event_data_mode=${mode} event_data_enc=${enc} ` +
    `event_data_count=${events.length} event_data_data="${encodeChunk(events)}"`
  );
}

/**
 * One Loki logfmt line as Alloy's faro.receiver flattens an upstream
 * @grafana/faro-instrumentation-replay event: one rrweb event, plain JSON, no chunking.
 */
function eventLine(event: ReplayEventWithTime) {
  return (
    `kind=event event_name=faro.session_recording.event session_id=sess-1 ` +
    `event_data_event="${JSON.stringify(event).replace(/"/g, '\\"')}"`
  );
}

function lokiStreams(lines: string[]) {
  return of({
    data: { data: { result: [{ stream: {}, values: lines.map((l, i) => [`${1751500000000 + i}000000`, l]) }] } },
  });
}

const baseOpts = {
  logsUid: 'loki-uid',
  service: 'my-app',
  sessionId: 'sess-1',
  fromMs: 1751500000000,
  toMs: 1751503600000,
};

const ev = (timestamp: number, type = 3): ReplayEventWithTime => ({ type, data: { t: timestamp }, timestamp });

beforeEach(() => {
  mockFetch.mockReset();
});

describe('decodeReplayChunk', () => {
  it('round-trips gzip+base64 rrweb events', () => {
    const events = [ev(1000, 4), ev(1000, 2), ev(1500)];
    expect(decodeReplayChunk(encodeChunk(events))).toEqual(events);
  });
});

describe('decodeReplayEvent', () => {
  it('parses a plain JSON rrweb event', () => {
    expect(decodeReplayEvent('{"type":3,"data":{},"timestamp":42}')).toEqual({ type: 3, data: {}, timestamp: 42 });
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(decodeReplayEvent('{nope')).toBeNull();
  });

  it('returns null for JSON that is not an rrweb event', () => {
    // A player fed an object without a numeric type/timestamp fails far less legibly.
    expect(decodeReplayEvent('{"hello":"world"}')).toBeNull();
  });
});

describe('fetchReplay', () => {
  it('queries the datasource proxy with the chunk pipeline and reassembles chunks in seq order', async () => {
    const chunk0 = [ev(1000, 4), ev(1000, 2)];
    const chunk1 = [ev(2000), ev(3000)];
    // Deliberately out of order: Loki returns seq 1 before seq 0.
    mockFetch.mockReturnValue(lokiStreams([chunkLine(1, 'recording', chunk1), chunkLine(0, 'recording', chunk0)]));

    const result = await fetchReplay(baseOpts);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0][0];
    expect(call.url).toBe('/api/datasources/proxy/uid/loki-uid/loki/api/v1/query_range');
    expect(call.params.query).toBe(
      '{service_name="my-app", kind=~"event|replay"} |~ `faro\\.session_recording\\.chunk|faro\\.session_recording\\.event` |= `sess-1` | logfmt | session_id="sess-1"'
    );
    expect(call.params.limit).toBe('1000');
    expect(call.params.direction).toBe('forward');
    expect(call.params.start).toBe('1751500000000000000');
    expect(call.params.end).toBe('1751503600000000000');

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('recording');
    expect(result!.chunkCount).toBe(2);
    expect(result!.events).toEqual([...chunk0, ...chunk1]);
    // Concatenation preserved chronological order across chunks.
    const timestamps = result!.events.map((e) => e.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('adds the environment matcher with the given label', async () => {
    mockFetch.mockReturnValue(lokiStreams([chunkLine(0, 'snapshot', [ev(1, 4), ev(1, 2)])]));

    await fetchReplay({ ...baseOpts, environment: 'prod', environmentLabel: 'env' });

    expect(mockFetch.mock.calls[0][0].params.query).toContain(
      '{service_name="my-app", kind=~"event|replay", env="prod"}'
    );
  });

  it('reports snapshot mode when no chunk is a recording', async () => {
    mockFetch.mockReturnValue(lokiStreams([chunkLine(0, 'snapshot', [ev(1, 4), ev(1, 2)])]));

    const result = await fetchReplay(baseOpts);
    expect(result!.mode).toBe('snapshot');
    expect(result!.events).toHaveLength(2);
  });

  it('dedupes retried lines with the same chunk_seq', async () => {
    const chunk = [ev(1000, 4), ev(1000, 2)];
    mockFetch.mockReturnValue(lokiStreams([chunkLine(0, 'recording', chunk), chunkLine(0, 'recording', chunk)]));

    const result = await fetchReplay(baseOpts);
    expect(result!.chunkCount).toBe(1);
    expect(result!.events).toHaveLength(2);
  });

  it('returns null when the session has no chunks', async () => {
    mockFetch.mockReturnValue(of({ data: { data: { result: [] } } }));
    expect(await fetchReplay(baseOpts)).toBeNull();
  });

  it('reads the upstream single-event format when a session has no chunks', async () => {
    mockFetch.mockReturnValue(lokiStreams([eventLine(ev(20)), eventLine(ev(10))]));

    const data = await fetchReplay(baseOpts);

    // No chunk_seq to sort on, so the rrweb timestamp is the ordering key.
    expect(data?.events.map((e) => e.timestamp)).toEqual([10, 20]);
    // That SDK streams continuously and reports no mode, so it is a recording.
    expect(data?.mode).toBe('recording');
    expect(data?.chunkCount).toBe(2);
  });

  it('dedupes retried single-event lines without dropping same-millisecond events', async () => {
    mockFetch.mockReturnValue(
      lokiStreams([eventLine(ev(10, 3)), eventLine(ev(10, 3)), eventLine(ev(10, 2))])
    );

    const data = await fetchReplay(baseOpts);

    // The duplicate of type 3 goes; the genuinely different type 2 at the same ms stays.
    expect(data?.events.map((e) => e.type)).toEqual([3, 2]);
  });

  it('skips a malformed single-event line instead of failing the whole session', async () => {
    mockFetch.mockReturnValue(
      lokiStreams(['kind=event event_name=faro.session_recording.event session_id=sess-1 event_data_event="{oops"', eventLine(ev(10))])
    );

    const data = await fetchReplay(baseOpts);

    expect(data?.events.map((e) => e.timestamp)).toEqual([10]);
  });

  it('prefers chunks when a session somehow has both formats', async () => {
    mockFetch.mockReturnValue(lokiStreams([chunkLine(0, 'recording', [ev(1)]), eventLine(ev(99))]));

    const data = await fetchReplay(baseOpts);

    // The @nais/apm path is untouched by the addition: chunks win outright.
    expect(data?.events.map((e) => e.timestamp)).toEqual([1]);
    expect(data?.chunkCount).toBe(1);
  });

  it('rejects unknown chunk encodings instead of rendering garbage', async () => {
    mockFetch.mockReturnValue(lokiStreams([chunkLine(0, 'recording', [ev(1, 4), ev(1, 2)], 'zstd+b64')]));
    await expect(fetchReplay(baseOpts)).rejects.toThrow(/Unsupported replay chunk encoding "zstd\+b64"/);
  });
});

describe('probeReplay', () => {
  it('issues a count-only instant metric query grouped by mode', async () => {
    mockFetch.mockReturnValue(
      of({
        data: {
          data: {
            result: [
              { metric: { event_data_mode: 'snapshot' }, value: [1751503600, '2'] },
              { metric: { event_data_mode: 'recording' }, value: [1751503600, '3'] },
            ],
          },
        },
      })
    );

    const probe = await probeReplay(baseOpts);

    const call = mockFetch.mock.calls[0][0];
    expect(call.url).toBe('/api/datasources/proxy/uid/loki-uid/loki/api/v1/query');
    expect(call.params.time).toBe('1751503600000000000');
    // Count-only metric query over the same pipeline — no chunk payloads cross the wire.
    expect(call.params.query).toBe(
      'sum by (event_data_mode) (count_over_time(' +
        '{service_name="my-app", kind=~"event|replay"} |~ `faro\\.session_recording\\.chunk|faro\\.session_recording\\.event` |= `sess-1` | logfmt | session_id="sess-1"' +
        ' [3600s]))'
    );

    // "recording" wins when both modes are present.
    expect(probe).toEqual({ hasChunks: true, mode: 'recording', chunkCount: 5 });
  });

  it('reports snapshot-only sessions', async () => {
    mockFetch.mockReturnValue(
      of({ data: { data: { result: [{ metric: { event_data_mode: 'snapshot' }, value: [1, '1'] }] } } })
    );
    expect(await probeReplay(baseOpts)).toEqual({ hasChunks: true, mode: 'snapshot', chunkCount: 1 });
  });

  it('treats a series with no mode label as a recording', async () => {
    mockFetch.mockReturnValue(of({ data: { data: { result: [{ metric: {}, value: [0, '7'] }] } } }));

    // Upstream single-event lines carry no event_data_mode, so the grouped series comes back
    // without the label. Without this the drawer would offer neither Play nor View snapshot.
    await expect(probeReplay(baseOpts)).resolves.toEqual({ hasChunks: true, mode: 'recording', chunkCount: 7 });
  });

  it('reports absence when the vector is empty', async () => {
    mockFetch.mockReturnValue(of({ data: { data: { result: [] } } }));
    expect(await probeReplay(baseOpts)).toEqual({ hasChunks: false, mode: null, chunkCount: 0 });
  });
});
