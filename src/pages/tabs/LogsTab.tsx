import React, { useEffect, useMemo, useState } from 'react';
import { useStyles2, MultiCombobox, Input, Icon, Switch, Combobox, LinkButton } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { GraphDrawStyle, StackingMode } from '@grafana/schema';
import {
  SceneTimeRange,
  SceneQueryRunner,
  EmbeddedScene,
  SceneFlexLayout,
  SceneFlexItem,
  PanelBuilders,
} from '@grafana/scenes';
import { useDebouncedValue, escapeRegex } from '../../utils/debounce';
import { sanitizeLabelValue, escapeQueryString } from '../../utils/sanitize';
import { useUrlString, useUrlCsv, useUrlBoolean } from '../../utils/useUrlState';
import { useTimeRange } from '../../utils/timeRange';
import { buildLogsDrilldownUrl } from '../../utils/explore';
import { otel } from '../../otelconfig';
import { PatternsPanel } from './logs/PatternsPanel';

interface LogsTabProps {
  service: string;
  namespace: string;
  logsUid: string;
  from: string;
  to: string;
  serviceNameLabel?: string;
  /** Cluster/environment filter to inject into stream selectors (for centralized Loki). */
  clusterFilter?: string;
  /** The stream label clusterFilter matches: the configured environment label, as the Frontend tab uses. */
  deploymentEnvLabel?: string;
}

// Severity options based on detected_level stream label values observed in production.
// Maps each option to all case variants seen in Loki's detected_level.
const SEVERITY_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Error', value: 'error' },
  { label: 'Warn', value: 'warn' },
  { label: 'Info', value: 'info' },
  { label: 'Debug', value: 'debug' },
  { label: 'Trace', value: 'trace' },
  { label: 'Unknown', value: 'unknown' },
];

// Faro telemetry kind options — only shown when "Include browser telemetry" is on.
// These correspond to the `kind` stream label values set by the Alloy Faro pipeline.
const FARO_KIND_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Exceptions', value: 'exception' },
  { label: 'Console Logs', value: 'log' },
  { label: 'Measurements', value: 'measurement' },
  { label: 'Events', value: 'event' },
];

/** Stream labels that name a pod, in the order they are tried. */
const POD_LABELS = ['k8s_pod_name', 'pod'];
export function LogsTab({
  service,
  namespace,
  logsUid,
  from,
  to,
  // Defaults to the LOKI service label, not the span-metrics one: this tab queries log
  // streams, and the two names come from different pipelines.
  serviceNameLabel = otel.faroLoki.serviceName,
  clusterFilter,
  deploymentEnvLabel,
}: LogsTabProps) {
  // The configured label, not the built-in default: on a Loki that does not carry
  // k8s_cluster_name, the default emptied every query in this tab.
  const envLabel = deploymentEnvLabel || otel.labels.deploymentEnv;
  const [severityFilter, setSeverityFilter] = useUrlCsv('logSeverity');
  const [logSearch, setLogSearch] = useUrlString('logSearch');
  const [podFilter, setPodFilter] = useUrlString('logPod');
  const [includeFaro, setIncludeFaro] = useUrlBoolean('includeFaro');
  const [kindFilter, setKindFilter] = useUrlCsv('kindFilter');
  const [podOptions, setPodOptions] = useState<Array<{ label: string; value: string }>>([]);
  // The stream label that names the pod: `k8s_pod_name` from an OTel collector's Loki exporter,
  // `pod` from Alloy/Promtail's Kubernetes discovery. Whichever this service's streams carry.
  const [podLabel, setPodLabel] = useState<string>(POD_LABELS[0]);
  const debouncedSearch = useDebouncedValue(logSearch, 500);
  const styles = useStyles2(getStyles);
  // Resolved timestamps drive the patterns fetch AND bust the scene memo on a
  // global time-picker refresh (from/to strings stay "now-1h" but fromMs/toMs
  // re-resolve), so the scene rebuilds and re-queries the fresh window.
  const { fromMs, toMs } = useTimeRange();

  // Fetch available pod names for this service, from the first pod label its streams carry.
  useEffect(() => {
    const controller = new AbortController();
    const clusterMatcher = clusterFilter ? `, ${envLabel}="${sanitizeLabelValue(clusterFilter)}"` : '';
    const selector = encodeURIComponent(`{${serviceNameLabel}="${sanitizeLabelValue(service)}"${clusterMatcher}}`);
    const podsFor = (label: string): Promise<string[]> =>
      fetch(
        `/api/datasources/proxy/uid/${encodeURIComponent(logsUid)}/loki/api/v1/label/${label}/values?query=${selector}`,
        { signal: controller.signal }
      )
        .then((r) => r.json())
        .then((d: { data?: string[] }) => (d.data ?? []).filter((p) => p.length > 0).sort());
    (async () => {
      for (const label of POD_LABELS) {
        const pods = await podsFor(label);
        if (pods.length > 0) {
          setPodLabel(label);
          setPodOptions(pods.map((p) => ({ label: p, value: p })));
          return;
        }
      }
      setPodOptions([]);
    })().catch(() => {
      /* ignore */
    });
    return () => controller.abort();
  }, [service, logsUid, serviceNameLabel, clusterFilter, envLabel]);

  const scene = useMemo(() => {
    // Resolve against the shared URL range (fromMs/toMs) rather than the raw
    // relative strings: the global header time picker replaced this scene's own
    // picker, and a refresh re-resolves fromMs/toMs while from/to stay "now-1h".
    const timeRange = new SceneTimeRange({
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });
    const svcLabel = `${serviceNameLabel}="${sanitizeLabelValue(service)}"`;

    // Centralized Loki: inject cluster label to scope logs to the selected environment.
    const clusterStream = clusterFilter ? `, ${envLabel}="${sanitizeLabelValue(clusterFilter)}"` : '';
    // Faro browser telemetry filtering via the `kind` stream label:
    // - Off: kind="" matches only backend app logs (no kind label)
    // - On + no filter: show all (no kind constraint)
    // - On + specific kinds: kind=~"exception|log" for selected types
    let kindStream = ', kind=""';
    if (includeFaro) {
      if (kindFilter.length > 0) {
        kindStream = `, kind=~"${kindFilter.join('|')}"`;
      } else {
        kindStream = '';
      }
    }

    // Pod filtering uses the pod stream label found above (only present on backend log streams).
    const podStream = podFilter ? `, ${podLabel}="${sanitizeLabelValue(podFilter)}"` : '';

    const streamSelector = `{${svcLabel}${clusterStream}${kindStream}${podStream}}`;

    // Severity filtering uses `detected_level`, Loki-computed structured metadata
    // that's attached to every log entry regardless of body format. Filtering on
    // it is a bare label-filter expression evaluated *before* any parser stage, so
    // it works for plain-text/logfmt lines too — unlike the previous `| json |
    // level=~"…"` approach, which silently dropped every non-JSON log (a failed
    // `| json` leaves `level` empty). Values are already normalized by Loki
    // (error/warn/info/debug/trace/unknown), matching SEVERITY_OPTIONS directly.
    const severityLabelFilter = severityFilter.length > 0 ? ` | detected_level=~"${severityFilter.join('|')}"` : '';

    // escapeRegex makes the term a literal regex; escapeQueryString then escapes
    // the backslashes/quotes for the LogQL double-quoted string literal — without
    // it, a term with a regex metachar (e.g. `[` from an issue-table deep link)
    // becomes an invalid `\[` string escape and Loki rejects the whole query.
    const textFilter = debouncedSearch ? ` |~ "${escapeQueryString(escapeRegex(debouncedSearch))}"` : '';

    const volumeQuery = new SceneQueryRunner({
      datasource: { uid: logsUid, type: 'loki' },
      queries: [
        {
          refId: 'volume',
          expr: `sum by (detected_level) (count_over_time(${streamSelector}${textFilter}${severityLabelFilter} [$__auto]))`,
          legendFormat: '{{detected_level}}',
          queryType: 'range',
        },
      ],
    });

    const logQuery = new SceneQueryRunner({
      datasource: { uid: logsUid, type: 'loki' },
      queries: [
        {
          refId: 'A',
          expr: `${streamSelector}${textFilter}${severityLabelFilter} | json | line_format \`{{ if .message }}{{ .message }}{{ else if .msg }}{{ .msg }}{{ else }}{{ __line__ }}{{ end }}\` | drop __error__, __error_details__`,
          queryType: 'range',
          maxLines: 200,
        },
      ],
    });

    return new EmbeddedScene({
      $timeRange: timeRange,
      controls: [],
      body: new SceneFlexLayout({
        direction: 'column',
        children: [
          new SceneFlexItem({
            minHeight: 120,
            maxHeight: 180,
            body: PanelBuilders.timeseries()
              .setTitle('Log volume')
              .setData(volumeQuery)
              .setCustomFieldConfig('stacking', { mode: StackingMode.Normal })
              .setCustomFieldConfig('fillOpacity', 80)
              .setCustomFieldConfig('lineWidth', 0)
              .setCustomFieldConfig('drawStyle', GraphDrawStyle.Bars)
              .build(),
          }),
          new SceneFlexItem({
            minHeight: 400,
            body: PanelBuilders.logs()
              .setTitle(`Logs — ${service}`)
              .setData(logQuery)
              .setOption('enableLogDetails', true)
              .setOption('showTime', true)
              .setOption('wrapLogMessage', true)
              .setOption('prettifyLogMessage', false)
              .setOption('showLabels', false)
              .setOption('showCommonLabels', false)
              .build(),
          }),
        ],
      }),
    });
  }, [
    service,
    logsUid,
    severityFilter,
    debouncedSearch,
    podFilter,
    podLabel,
    includeFaro,
    kindFilter,
    fromMs,
    toMs,
    serviceNameLabel,
    clusterFilter,
    envLabel,
  ]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.controls}>
        <Input
          prefix={<Icon name="search" />}
          placeholder="Search logs..."
          width={24}
          value={logSearch}
          onChange={(e) => setLogSearch(e.currentTarget.value)}
        />
        <label className={styles.label}>Severity:</label>
        <MultiCombobox
          options={SEVERITY_OPTIONS}
          value={severityFilter}
          onChange={(v) => setSeverityFilter(v.map((o) => o.value))}
          width={30}
          placeholder="All severities"
        />
        {podOptions.length > 1 && (
          <>
            <label className={styles.label}>Pod:</label>
            <Combobox
              options={[{ label: 'All pods', value: '' }, ...podOptions]}
              value={podFilter}
              onChange={(v) => setPodFilter(v?.value ?? '')}
              width={36}
              placeholder="All pods"
            />
          </>
        )}
        <label className={styles.toggle}>
          <Switch value={includeFaro} onChange={() => setIncludeFaro(!includeFaro)} />
          <span>Include browser telemetry</span>
        </label>
        {includeFaro && (
          <>
            <label className={styles.label}>Kind:</label>
            <MultiCombobox
              options={FARO_KIND_OPTIONS}
              value={kindFilter}
              onChange={(v) => setKindFilter(v.map((o) => o.value))}
              width={28}
              placeholder="All kinds"
            />
          </>
        )}
        <LinkButton
          variant="secondary"
          size="sm"
          icon="gf-logs"
          className={styles.drilldownLink}
          // The same scope as this tab's own queries: service and environment. Not the
          // namespace, which the tab never filters on and which log streams need not carry: a
          // `service_namespace` filter on a Loki that lacks the label opened an empty drilldown.
          href={buildLogsDrilldownUrl(logsUid, service, {
            environment: clusterFilter,
            environmentLabel: envLabel,
            from,
            to,
            serviceNameLabel,
          })}
          tooltip="Open this service's logs in Grafana's queryless Logs Drilldown app"
        >
          Open in Logs Drilldown
        </LinkButton>
      </div>
      <PatternsPanel
        namespace={namespace}
        service={service}
        logsUid={logsUid}
        fromMs={fromMs}
        toMs={toMs}
        onSelectFilter={setLogSearch}
      />
      <div className={styles.sceneWrapper}>
        <scene.Component model={scene} />
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  `,
  controls: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    margin-bottom: ${theme.spacing(2)};
    flex-wrap: wrap;
  `,
  sceneWrapper: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
  `,
  label: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  toggle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    cursor: pointer;
    margin-left: ${theme.spacing(0.5)};
  `,
  drilldownLink: css`
    margin-left: auto;
  `,
});
