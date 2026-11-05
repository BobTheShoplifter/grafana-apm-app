import { parseSSE } from './investigate';

describe('parseSSE', () => {
  it('returns complete events and keeps the unfinished tail', () => {
    const { events, rest } = parseSSE(
      'event: start\ndata: {"model":"m","rounds":12}\n\nevent: text\ndata: {"round":1,"text":"hel'
    );
    expect(events).toEqual([{ type: 'start', model: 'm', rounds: 12 }]);
    expect(rest).toBe('event: text\ndata: {"round":1,"text":"hel');
  });

  it('drops keep-alive comments and unknown event types', () => {
    const { events } = parseSSE(': keep-alive\n\nevent: other\ndata: {}\n\nevent: done\ndata: {"rounds":2}\n\n');
    expect(events).toEqual([{ type: 'done', rounds: 2 }]);
  });

  it('handles CRLF line endings and skips malformed JSON', () => {
    const { events } = parseSSE(
      'event: error\r\ndata: {"message":"boom"}\r\n\r\nevent: text\r\ndata: {not json}\r\n\r\n'
    );
    expect(events).toEqual([{ type: 'error', message: 'boom' }]);
  });

  it('reassembles an event split across chunks', () => {
    const first = parseSSE('event: tool_call\ndata: {"round":1,"id":"t1",');
    expect(first.events).toEqual([]);
    const second = parseSSE(first.rest + '"name":"query_logs","input":{}}\n\n');
    expect(second.events).toEqual([{ type: 'tool_call', round: 1, id: 't1', name: 'query_logs', input: {} }]);
  });
});
