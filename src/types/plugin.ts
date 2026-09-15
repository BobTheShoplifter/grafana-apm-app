/** Shared type definitions for plugin configuration (jsonData schema). */

/** Reference to a Grafana datasource by UID. */
export interface DsRef {
  uid?: string;
  type?: string;
}

/** Datasource reference with optional per-environment overrides. */
export interface EnvAwareDs {
  uid?: string;
  type?: string;
  byEnvironment?: Record<string, DsRef>;
}

/** Label name overrides for non-standard OTel pipelines (e.g. Tempo metrics generator). */
export interface LabelOverrides {
  /** Default: "service_name". Tempo metrics generator emits "service". */
  serviceNameLabel?: string;
  /**
   * Label that identifies a service in LOKI. Default: "service_name".
   *
   * Separate from serviceNameLabel on purpose. That one names a service in PROMETHEUS span
   * metrics, and the two are different namespaces that different pipelines write: Tempo's
   * metrics generator emits `service` on its span metrics while the log pipeline still writes
   * `service_name` on its streams. Before this existed, overriding the metrics label silently
   * repointed every log query and every Logs Drilldown link at a label Loki does not have, and
   * the Logs tab came up empty with a link that filtered on nothing.
   */
  logsServiceNameLabel?: string;
  /** Default: "service_namespace". Use "k8s_namespace_name" for Tempo with k8s.namespace.name dimension. */
  serviceNamespaceLabel?: string;
  /** Default: "k8s_cluster_name". */
  deploymentEnvLabel?: string;
}

/** An entry in the ops watchlist: a specific service in a namespace to monitor. */
export interface OpsWatchlistEntry {
  namespace: string;
  service: string;
}

/** The plugin's jsonData schema — persisted in Grafana's plugin settings. */
export interface AppPluginSettings {
  metricsDataSource?: EnvAwareDs;
  tracesDataSource?: EnvAwareDs;
  logsDataSource?: EnvAwareDs;
  metricNamespace?: string;
  durationUnit?: string;
  labelOverrides?: LabelOverrides;
  /** nais API (Console) GraphQL endpoint — enables deploy/release tracking and the scorecard ownership card. Paired with secureJsonData.naisApiToken. */
  naisApiUrl?: string;
  /** Ingress hostname → service name mapping for discovering on-prem callers via nais ingress. */
  ingressAliases?: Record<string, string>;
  /** Global ops watchlist — services monitored on the Ops Status Board. Editable by any user via the backend API. */
  opsWatchlist?: OpsWatchlistEntry[];
}
