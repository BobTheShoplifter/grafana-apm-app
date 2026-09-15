/**
 * Session replay browser: the list of recorded sessions for a service.
 *
 * WHY THIS EXISTS. Replay had exactly one entry point, the exception drawer. That is right
 * when you are investigating an error, and it is the only entry point a session needs when it
 * was recorded BECAUSE of one. A continuously-recording SDK is different: it produces sessions
 * for people who never hit an error, and those had nowhere to be opened from. The recordings
 * were in Loki and the UI pointed at none of them.
 *
 * Each row reuses the same ReplaySection the drawer uses, so there is one player and one fetch
 * path; this component only answers "which sessions exist".
 *
 * It reads the time range itself rather than taking it as a prop, so the enclosing scene does
 * not have to rebuild on every refresh tick just to hand this component two numbers.
 */
import React, { useEffect, useState } from 'react';
import { Alert, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2, dateTimeFormat } from '@grafana/data';
import { css } from '@emotion/css';
import { listReplaySessions, ReplaySessionSummary } from './fetchReplay';
import { ReplaySection } from './ReplaySection';
import { useTimeRange } from '../../../../utils/timeRange';

export interface ReplaySessionsProps {
  logsUid: string;
  service: string;
  environment?: string;
  environmentLabel?: string;
}

interface LoadedSessions {
  /** Which request produced this. A result whose key is stale renders as loading, which is
   *  what lets the loading state exist without a setState call inside the effect body. */
  key: string;
  state: 'ready' | 'error';
  sessions: ReplaySessionSummary[];
}

export function ReplaySessions({ logsUid, service, environment, environmentLabel }: ReplaySessionsProps) {
  const styles = useStyles2(getStyles);
  const { fromMs, toMs } = useTimeRange();
  const [loaded, setLoaded] = useState<LoadedSessions | null>(null);

  const requestKey = `${logsUid}|${service}|${fromMs}|${toMs}|${environment ?? ''}|${environmentLabel ?? ''}`;

  useEffect(() => {
    if (!logsUid || !service) {
      return;
    }
    let cancelled = false;

    listReplaySessions({ logsUid, service, fromMs, toMs, environment, environmentLabel })
      .then((sessions) => {
        if (!cancelled) {
          setLoaded({ key: requestKey, state: 'ready', sessions });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded({ key: requestKey, state: 'error', sessions: [] });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestKey, logsUid, service, fromMs, toMs, environment, environmentLabel]);

  if (!logsUid) {
    return null;
  }

  if (!loaded || loaded.key !== requestKey) {
    return <LoadingPlaceholder text="Looking for recorded sessions…" />;
  }

  if (loaded.state === 'error') {
    return (
      <Alert severity="warning" title="Could not list session replays">
        The Loki query failed. Replays may still exist; the Issues tab reaches them per exception.
      </Alert>
    );
  }

  if (loaded.sessions.length === 0) {
    // Deliberately not an error: most services record nothing, and a service that does will
    // have no sessions in a window nobody used it in. Both are normal, so say what would make
    // rows appear rather than implying something is broken.
    return (
      <div className={styles.empty}>
        No recorded sessions in this time range. Replay is opt-in per app: the browser SDK needs
        its replay instrumentation enabled, and only sessions from after that was deployed are
        recorded.
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Last active</th>
            <th>Session</th>
            <th className={styles.numeric}>Events</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {loaded.sessions.map((session) => (
            <tr key={session.sessionId}>
              <td>{dateTimeFormat(session.lastSeenMs)}</td>
              {/* Monospace: session ids get compared by eye against a log line or a trace. */}
              <td className={styles.mono}>{session.sessionId}</td>
              <td className={styles.numeric}>{session.events.toLocaleString()}</td>
              <td>
                <ReplaySection
                  // Remount per session so the player never shows the previous one's frames
                  // while the next is still loading.
                  key={session.sessionId}
                  mode="recording"
                  logsUid={logsUid}
                  service={service}
                  sessionId={session.sessionId}
                  fromMs={fromMs}
                  toMs={toMs}
                  environment={environment}
                  environmentLabel={environmentLabel}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css({
    // The player expands in place inside a row, so the container must not clip it.
    overflowX: 'auto',
  }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    'th, td': {
      textAlign: 'left',
      padding: theme.spacing(0.75, 1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      verticalAlign: 'top',
    },
    th: {
      color: theme.colors.text.secondary,
      fontWeight: theme.typography.fontWeightMedium,
      whiteSpace: 'nowrap',
    },
  }),
  mono: css({
    fontFamily: theme.typography.fontFamilyMonospace,
  }),
  numeric: css({
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  }),
  empty: css({
    color: theme.colors.text.secondary,
    padding: theme.spacing(2),
    maxWidth: '60ch',
  }),
});
