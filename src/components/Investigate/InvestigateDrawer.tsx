import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GrafanaTheme2, renderMarkdown } from '@grafana/data';
import { Alert, Button, Drawer, Icon, Spinner, TextArea, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import {
  getInvestigateStatus,
  InvestigateStatus,
  InvestigationEvent,
  InvestigationUsage,
  runInvestigation,
} from '../../api/investigate';

interface InvestigateProps {
  namespace: string;
  service: string;
  environment?: string;
  fromMs: number;
  toMs: number;
}

type Phase = 'idle' | 'running' | 'done' | 'error' | 'stopped';

interface ToolStep {
  id: string;
  round: number;
  name: string;
  input: unknown;
  ok?: boolean;
  preview?: string;
}

/** What the drawer shows, folded from the event stream. */
export interface InvestigationView {
  model?: string;
  progress: Record<number, string>;
  tools: ToolStep[];
  text: Record<number, string>;
  usage?: InvestigationUsage;
  rounds?: number;
  error?: string;
}

export const emptyView: InvestigationView = { progress: {}, tools: [], text: {} };

/** Fold one event into the view. Pure, so it is tested on its own. */
export function reduceInvestigation(view: InvestigationView, e: InvestigationEvent): InvestigationView {
  switch (e.type) {
    case 'start':
      return { ...view, model: e.model };
    case 'progress':
      return { ...view, progress: { ...view.progress, [e.round]: (view.progress[e.round] ?? '') + e.text } };
    case 'text':
      return { ...view, text: { ...view.text, [e.round]: (view.text[e.round] ?? '') + e.text } };
    case 'tool_call':
      return { ...view, tools: [...view.tools, { id: e.id, round: e.round, name: e.name, input: e.input }] };
    case 'tool_result':
      return {
        ...view,
        tools: view.tools.map((t) => (t.id === e.id ? { ...t, ok: e.ok, preview: e.preview } : t)),
      };
    case 'done':
      return { ...view, usage: e.usage, rounds: e.rounds };
    case 'error':
      return { ...view, error: e.message };
    default:
      return view;
  }
}

/** The answer is the text of the latest round that wrote any. */
export function reportText(view: InvestigationView): string {
  const rounds = Object.keys(view.text)
    .map(Number)
    .filter((r) => view.text[r].trim() !== '')
    .sort((a, b) => a - b);
  return rounds.length ? view.text[rounds[rounds.length - 1]] : '';
}

/** A one-line description of a tool call for the step list. */
export function describeTool(step: ToolStep): string {
  const input = (step.input ?? {}) as Record<string, unknown>;
  const q = typeof input.query === 'string' ? input.query : undefined;
  switch (step.name) {
    case 'query_metrics':
      return `Metrics: ${q ?? ''}`;
    case 'query_logs':
      return `Logs: ${q ?? ''}`;
    case 'search_traces':
      return `Trace search: ${q ?? ''}`;
    case 'get_trace':
      return `Trace ${String(input.trace_id ?? '')}`;
    case 'list_labels':
      return `Labels in ${String(input.source ?? '')}${input.label ? `: ${String(input.label)}` : ''}`;
    default:
      return step.name;
  }
}

const DEFAULT_QUESTION =
  'Is anything wrong with this service in the selected time range? If so, what is happening and why?';

/** The "Investigate" header button and its drawer. Renders nothing when the feature is off. */
export function InvestigateButton(props: InvestigateProps) {
  const [status, setStatus] = useState<InvestigateStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    getInvestigateStatus().then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, []);

  if (!status?.available) {
    return null;
  }
  return (
    <>
      <Button
        icon="ai"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        tooltip="Ask Claude to investigate this service in the selected time range"
      >
        Investigate
      </Button>
      {open && <InvestigateDrawer {...props} model={status.model} onClose={() => setOpen(false)} />}
    </>
  );
}

export function InvestigateDrawer({
  namespace,
  service,
  environment,
  fromMs,
  toMs,
  model,
  onClose,
}: InvestigateProps & { model?: string; onClose: () => void }) {
  const styles = useStyles2(getStyles);
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [phase, setPhase] = useState<Phase>('idle');
  const [view, setView] = useState<InvestigationView>(emptyView);
  const abortRef = useRef<AbortController | null>(null);

  // Stop the run when the drawer closes or the page changes.
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setView(emptyView);
    setPhase('running');
    let failed = false;
    try {
      await runInvestigation(
        { namespace, service, environment, question: question.trim(), fromMs, toMs },
        (e) => {
          if (e.type === 'error') {
            failed = true;
          }
          setView((v) => reduceInvestigation(v, e));
        },
        controller.signal
      );
      setPhase(failed ? 'error' : 'done');
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase('stopped');
        return;
      }
      setView((v) => ({ ...v, error: err instanceof Error ? err.message : String(err) }));
      setPhase('error');
    }
  }, [namespace, service, environment, question, fromMs, toMs]);

  const stop = () => abortRef.current?.abort();
  const report = reportText(view);
  const reportHtml = useMemo(() => (report ? renderMarkdown(report) : ''), [report]);
  const latestProgress = useMemo(() => {
    const rounds = Object.keys(view.progress).map(Number);
    return rounds.length ? view.progress[Math.max(...rounds)].trim() : '';
  }, [view.progress]);

  return (
    <Drawer
      title={`Investigate ${namespace ? `${namespace}/` : ''}${service}`}
      subtitle={`${new Date(fromMs).toLocaleString()} to ${new Date(toMs).toLocaleString()}${
        environment ? ` · ${environment}` : ''
      }`}
      onClose={onClose}
      size="md"
    >
      <div className={styles.container}>
        {phase === 'idle' ? (
          <>
            <label className={styles.label} htmlFor="investigate-question">
              What should Claude look into?
            </label>
            <TextArea
              id="investigate-question"
              rows={3}
              value={question}
              onChange={(e) => setQuestion(e.currentTarget.value)}
            />
            <div className={styles.note}>
              Claude ({model ?? 'Anthropic'}) reads this service&apos;s metrics, logs and traces with read-only queries
              and writes up what it finds. The data it reads is sent to Anthropic. A run takes a few minutes.
            </div>
            <div>
              <Button icon="ai" onClick={start} disabled={!question.trim()}>
                Start investigation
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.actions}>
              {phase === 'running' ? (
                <>
                  <Spinner inline />
                  <span className={styles.status}>{latestProgress ? truncateLine(latestProgress) : 'Working...'}</span>
                  <Button size="sm" variant="secondary" icon="square-shape" onClick={stop}>
                    Stop
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" icon="sync" onClick={() => setPhase('idle')}>
                  New investigation
                </Button>
              )}
            </div>

            {view.error && (
              <Alert severity="error" title="The investigation stopped">
                {view.error}
              </Alert>
            )}
            {phase === 'stopped' && <Alert severity="info" title="Stopped" />}

            {reportHtml && (
              <div
                className={styles.report}
                data-testid="investigation-report"
                dangerouslySetInnerHTML={{ __html: reportHtml }}
              />
            )}

            {view.tools.length > 0 && (
              <details className={styles.steps} open={phase === 'running' && !report}>
                <summary>
                  {view.tools.length} {view.tools.length === 1 ? 'query' : 'queries'}
                </summary>
                <ol className={styles.stepList}>
                  {view.tools.map((t) => (
                    <li key={t.id}>
                      <Icon
                        name={t.ok === undefined ? 'fa fa-spinner' : t.ok ? 'check' : 'exclamation-triangle'}
                        className={t.ok === false ? styles.fail : undefined}
                      />{' '}
                      <code className={styles.query}>{describeTool(t)}</code>
                      {t.preview && <pre className={styles.preview}>{t.preview}</pre>}
                    </li>
                  ))}
                </ol>
              </details>
            )}

            {view.usage && (
              <div className={styles.note}>
                {view.model} · {view.rounds} rounds · {view.usage.input + view.usage.cacheRead + view.usage.cacheWrite}{' '}
                input tokens ({view.usage.cacheRead} cached) · {view.usage.output} output tokens
              </div>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}

function truncateLine(s: string): string {
  const line = s.split('\n').filter(Boolean).pop() ?? s;
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(2) }),
  label: css({ fontWeight: theme.typography.fontWeightMedium }),
  note: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  actions: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1) }),
  status: css({ flex: 1, color: theme.colors.text.secondary, overflow: 'hidden', textOverflow: 'ellipsis' }),
  report: css({
    'h2, h3': { marginTop: theme.spacing(2) },
    'ul, ol': { paddingLeft: theme.spacing(3) },
    code: { wordBreak: 'break-word' },
  }),
  steps: css({ summary: { cursor: 'pointer', color: theme.colors.text.secondary } }),
  stepList: css({ paddingLeft: theme.spacing(3), display: 'flex', flexDirection: 'column', gap: theme.spacing(1) }),
  query: css({ wordBreak: 'break-word' }),
  preview: css({
    maxHeight: 160,
    overflow: 'auto',
    fontSize: theme.typography.bodySmall.fontSize,
    marginTop: theme.spacing(0.5),
  }),
  fail: css({ color: theme.colors.error.text }),
});
