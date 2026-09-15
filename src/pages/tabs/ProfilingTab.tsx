import React, { useEffect, useMemo, useState } from 'react';
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { useStyles2, Combobox } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import {
  SceneTimeRange,
  SceneQueryRunner,
  EmbeddedScene,
  SceneFlexLayout,
  SceneFlexItem,
  PanelBuilders,
} from '@grafana/scenes';
import { sanitizeLabelValue } from '../../utils/sanitize';
import { useTimeRange } from '../../utils/timeRange';
import { useSceneTimeSync } from '../../utils/useSceneTimeSync';

interface ProfilingTabProps {
  service: string;
  namespace: string;
  /** UID of the detected Pyroscope datasource (caps.pyroscope.uid). The tab is
   * only mounted when this is set, so it is always a real UID here. */
  pyroscopeUid: string;
  /** Pyroscope conventionally labels services under `service_name`; overridable
   * for parity with the app's label config. */
  serviceNameLabel?: string;
}

// LAST-RESORT fallback only. `value` is Pyroscope's fully-qualified profileTypeId in
// `name:sampleType:sampleUnit:periodType:periodUnit` form - the exact shape the
// grafana-pyroscope-datasource query model expects.
//
// These are the GO spellings, and a hardcoded list is why this tab rendered empty for every
// service that is not Go. Node's Pyroscope SDK pushes `wall`, not `process_cpu`, and spells
// its memory type differently too. Measured on one Node service:
//     asked for   process_cpu:cpu:nanoseconds:cpu:nanoseconds
//     exists      wall:cpu:nanoseconds:wall:nanoseconds
//     asked for   memory:inuse_space:bytes:space:bytes
//     exists      memory:inuse_space:bytes:inuse_space:bytes
// Every entry missed, and since the first is also the default selection, the tab opened on a
// profile type the service had never emitted.
//
// The real list is now asked FOR THE SERVICE at mount, from the datasource's own labelValues
// resource. This array survives only for the case where that call fails.
const FALLBACK_PROFILE_TYPES: Array<{ label: string; value: string }> = [
  { label: 'CPU', value: 'process_cpu:cpu:nanoseconds:cpu:nanoseconds' },
  { label: 'Memory — in-use space', value: 'memory:inuse_space:bytes:space:bytes' },
  { label: 'Memory — allocated space', value: 'memory:alloc_space:bytes:space:bytes' },
  { label: 'Memory — allocated objects', value: 'memory:alloc_objects:count:space:bytes' },
  { label: 'Goroutines', value: 'goroutine:goroutines:count:goroutine:count' },
];

const PYROSCOPE_DS_TYPE = 'grafana-pyroscope-datasource';

/**
 * ProfilingTab renders continuous-profiling views for a service from a
 * Pyroscope datasource: a samples-over-time series and a flame graph for the
 * selected profile type (CPU or memory). It is only reachable when the backend
 * /capabilities probe reports `pyroscope.available` — production has no
 * Pyroscope today, so in practice the tab is hidden entirely.
 *
 * Follow-up (both Tempo + Pyroscope present): span→profile links — Tempo trace
 * spans carry a pyroscope profile id that deep-links into a span-scoped flame
 * graph (the datasource's `spanSelector` query field). Not built here because
 * production runs neither datasource in tandem yet.
 */
/**
 * Human label for a profileTypeId: "wall:cpu:nanoseconds:wall:nanoseconds" -> "wall - cpu".
 * The first two segments are the profile name and the sample type, which is what distinguishes
 * one entry from another in the picker; the period half is noise to a reader.
 */
function profileTypeLabel(id: string): string {
  const [name, sampleType] = id.split(':');
  return sampleType ? `${name} - ${sampleType}` : id;
}

/**
 * Pick the entry to open on. CPU-ish profiles answer "what is this service doing" and are what
 * anyone opening a profiling tab is looking for, whatever the runtime happens to call them -
 * `process_cpu` on Go, `wall` on Node. Anything else falls back to the first available, which
 * is still a profile the service HAS, rather than one it has never emitted.
 */
function preferredProfileType(ids: string[]): string {
  return ids.find((id) => /^(process_cpu|cpu|wall):/.test(id)) ?? ids[0];
}

export function ProfilingTab({ service, pyroscopeUid, serviceNameLabel = 'service_name' }: ProfilingTabProps) {
  const styles = useStyles2(getStyles);
  const [profileTypes, setProfileTypes] = useState(FALLBACK_PROFILE_TYPES);
  const [profileType, setProfileType] = useState<string>(FALLBACK_PROFILE_TYPES[0].value);
  // Resolved timestamps drive the scene window AND bust the memo on a global
  // time-picker refresh (from/to strings stay relative but fromMs/toMs
  // re-resolve), so the scene rebuilds and re-queries the fresh window.
  const { fromMs, toMs } = useTimeRange();

  // Ask the datasource which profile types THIS service has, rather than assuming. The
  // pyroscope datasource proxies Pyroscope's label API, and `__profile_type__` is the label
  // that carries the fully-qualified ids, so one call scoped by the service selector returns
  // exactly the set that can produce a flame graph.
  //
  // Deliberately NOT the /resources/profileTypes route: that returns every type in the tenant,
  // including ones emitted by other services, which would repopulate the picker with entries
  // that render empty - the bug this replaces, one level further in.
  useEffect(() => {
    if (!pyroscopeUid) {
      return;
    }
    let cancelled = false;
    const selector = `{${serviceNameLabel}="${sanitizeLabelValue(service)}"}`;

    lastValueFrom(
      getBackendSrv().fetch<string[]>({
        url: `/api/datasources/uid/${encodeURIComponent(pyroscopeUid)}/resources/labelValues`,
        params: {
          label: '__profile_type__',
          query: selector,
          // Pyroscope's label API takes epoch MILLISECONDS, unlike the Loki calls elsewhere
          // in this plugin which take nanoseconds. A mismatch here returns an empty list
          // rather than an error, which would look exactly like "service has no profiles".
          start: String(Math.floor(fromMs)),
          end: String(Math.floor(toMs)),
        },
        method: 'GET',
      })
    )
      .then((res) => {
        if (cancelled) {
          return;
        }
        const ids = (res.data ?? []).filter((id) => typeof id === 'string' && id.includes(':'));
        if (ids.length === 0) {
          return; // leave the fallback in place; the panels will show their own empty state
        }
        setProfileTypes(ids.map((id) => ({ label: profileTypeLabel(id), value: id })));
        // Only move the selection when the current one is not among them, so a deliberate
        // pick survives a time-range change that re-runs this.
        setProfileType((current) => (ids.includes(current) ? current : preferredProfileType(ids)));
      })
      .catch(() => {
        // Keep the fallback list: a discovery failure should not empty the picker.
      });

    return () => {
      cancelled = true;
    };
  }, [service, serviceNameLabel, pyroscopeUid, fromMs, toMs]);

  const scene = useMemo(() => {
    const timeRange = new SceneTimeRange({
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });

    const labelSelector = `{${serviceNameLabel}="${sanitizeLabelValue(service)}"}`;
    const datasource = { uid: pyroscopeUid, type: PYROSCOPE_DS_TYPE };

    // Two query runners against the same datasource: `metrics` yields the
    // time-series of samples, `profile` yields the flame graph. profileTypeId +
    // labelSelector are the datasource's required query fields.
    const metricsQuery = new SceneQueryRunner({
      datasource,
      queries: [
        {
          refId: 'A',
          queryType: 'metrics',
          profileTypeId: profileType,
          labelSelector,
          groupBy: [],
        },
      ],
    });

    const profileQuery = new SceneQueryRunner({
      datasource,
      queries: [
        {
          refId: 'A',
          queryType: 'profile',
          profileTypeId: profileType,
          labelSelector,
          groupBy: [],
          maxNodes: 16384,
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
            minHeight: 160,
            maxHeight: 220,
            body: PanelBuilders.timeseries().setTitle('Profile samples over time').setData(metricsQuery).build(),
          }),
          new SceneFlexItem({
            minHeight: 500,
            body: PanelBuilders.flamegraph().setTitle(`Flame graph — ${service}`).setData(profileQuery).build(),
          }),
        ],
      }),
    });
  }, [service, pyroscopeUid, serviceNameLabel, profileType, fromMs, toMs]);

  // Follow the global header time range: rebuilds on from/to string changes,
  // this re-resolves relative ranges in place on a refresh tick.
  useSceneTimeSync(scene, fromMs, toMs);

  return (
    <div className={styles.wrapper}>
      <div className={styles.controls}>
        <label className={styles.label}>Profile type:</label>
        <Combobox
          options={profileTypes}
          value={profileType}
          onChange={(v) => setProfileType(v?.value ?? FALLBACK_PROFILE_TYPES[0].value)}
          width={32}
        />
      </div>
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
  label: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  sceneWrapper: css`
    flex: 1;
    min-height: 0;
    overflow: auto;
  `,
});
