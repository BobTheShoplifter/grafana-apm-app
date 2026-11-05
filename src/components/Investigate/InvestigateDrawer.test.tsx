import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  describeTool,
  emptyView,
  InvestigateButton,
  InvestigateDrawer,
  reduceInvestigation,
  reportText,
} from './InvestigateDrawer';
import { InvestigationEvent } from '../../api/investigate';

const getStatusMock = jest.fn();
const runMock = jest.fn();

jest.mock('../../api/investigate', () => ({
  getInvestigateStatus: () => getStatusMock(),
  runInvestigation: (...args: unknown[]) => runMock(...args),
}));

const props = { namespace: 'shop', service: 'checkout', fromMs: 1_700_000_000_000, toMs: 1_700_003_600_000 };

describe('reduceInvestigation', () => {
  it('folds the event stream into the view', () => {
    const events: InvestigationEvent[] = [
      { type: 'start', model: 'claude-opus-5-5', rounds: 12 },
      { type: 'progress', round: 1, text: 'Checking ' },
      { type: 'progress', round: 1, text: 'error rate' },
      { type: 'tool_call', round: 1, id: 't1', name: 'query_metrics', input: { query: 'up' } },
      { type: 'tool_result', round: 1, id: 't1', name: 'query_metrics', ok: true, chars: 10, preview: '1 series' },
      { type: 'text', round: 2, text: '## Summary\n' },
      { type: 'text', round: 2, text: 'All good.' },
      { type: 'done', rounds: 2, stopReason: 'end_turn', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    ];
    const view = events.reduce(reduceInvestigation, emptyView);
    expect(view.model).toBe('claude-opus-5-5');
    expect(view.progress[1]).toBe('Checking error rate');
    expect(view.tools).toEqual([
      { id: 't1', round: 1, name: 'query_metrics', input: { query: 'up' }, ok: true, preview: '1 series' },
    ]);
    expect(reportText(view)).toBe('## Summary\nAll good.');
    expect(view.rounds).toBe(2);
  });

  it('takes the report from the latest round that wrote text', () => {
    const view = { ...emptyView, text: { 1: 'Looking at logs first.', 3: 'Final answer', 2: '  ' } };
    expect(reportText(view)).toBe('Final answer');
  });
});

describe('describeTool', () => {
  it.each([
    [{ name: 'query_logs', input: { query: '{app="x"} |= "error"' } }, 'Logs: {app="x"} |= "error"'],
    [{ name: 'get_trace', input: { trace_id: 'abc' } }, 'Trace abc'],
    [{ name: 'list_labels', input: { source: 'logs', label: 'namespace' } }, 'Labels in logs: namespace'],
  ])('describes %o', (step, want) => {
    expect(describeTool({ id: 'x', round: 1, ...step })).toBe(want);
  });
});

describe('InvestigateButton', () => {
  beforeEach(() => {
    getStatusMock.mockReset();
    runMock.mockReset();
  });

  it('renders nothing when the feature is not configured', async () => {
    getStatusMock.mockResolvedValue({ available: false });
    const { container } = render(<InvestigateButton {...props} />);
    await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the drawer when configured', async () => {
    getStatusMock.mockResolvedValue({ available: true, model: 'claude-opus-5-5' });
    render(<InvestigateButton {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /investigate/i }));
    expect(await screen.findByText('What should Claude look into?')).toBeInTheDocument();
    expect(screen.getByText(/sent to Anthropic/)).toBeInTheDocument();
  });
});

describe('InvestigateDrawer', () => {
  beforeEach(() => runMock.mockReset());

  it('streams a run into steps and a rendered report', async () => {
    runMock.mockImplementation(async (args, onEvent: (e: InvestigationEvent) => void) => {
      expect(args).toMatchObject({ namespace: 'shop', service: 'checkout', fromMs: props.fromMs, toMs: props.toMs });
      onEvent({ type: 'start', model: 'm', rounds: 12 });
      onEvent({ type: 'tool_call', round: 1, id: 't1', name: 'query_logs', input: { query: '{app="checkout"}' } });
      onEvent({
        type: 'tool_result',
        round: 1,
        id: 't1',
        name: 'query_logs',
        ok: false,
        chars: 5,
        preview: 'Error: x',
      });
      onEvent({ type: 'text', round: 2, text: '## Summary\n\nThe database is **down**.' });
      onEvent({
        type: 'done',
        rounds: 2,
        stopReason: 'end_turn',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      });
    });
    render(<InvestigateDrawer {...props} model="m" onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /start investigation/i }));

    const report = await screen.findByTestId('investigation-report');
    expect(report.querySelector('h2')?.textContent).toBe('Summary');
    expect(report.querySelector('strong')?.textContent).toBe('down');
    expect(screen.getByText('Logs: {app="checkout"}')).toBeInTheDocument();
    expect(screen.getByText(/2 rounds/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new investigation/i })).toBeInTheDocument();
  });

  it('shows a run error', async () => {
    runMock.mockImplementation(async (_args, onEvent: (e: InvestigationEvent) => void) => {
      onEvent({ type: 'error', message: 'The Anthropic API rejected the configured key.' });
    });
    render(<InvestigateDrawer {...props} onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /start investigation/i }));
    expect(await screen.findByText('The Anthropic API rejected the configured key.')).toBeInTheDocument();
  });

  it('shows a failure to start', async () => {
    runMock.mockRejectedValue(new Error('AI investigation is not configured'));
    render(<InvestigateDrawer {...props} onClose={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /start investigation/i }));
    expect(await screen.findByText('AI investigation is not configured')).toBeInTheDocument();
  });
});
