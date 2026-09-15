/**
 * rrweb replay player - HEAVY MODULE, never import statically.
 *
 * Loaded only through the guarded dynamic import in LazyReplayPlayer.tsx, so rrweb and its CSS
 * land in a separate content-hashed chunk instead of the initial module.js bundle.
 *
 * WHY THIS DRIVES rrweb DIRECTLY INSTEAD OF @grafana/rrweb-player.
 * The Svelte wrapper renders its shell and nothing else: `.rr-player` and an EMPTY
 * `.rr-player__frame`, no controller, no iframe, and no exception. Its controller is gated on
 * an internal `replayer` variable that is never assigned, so the component mounts into a state
 * where it has already given up. Reproduced outside the browser with a real 124-event session:
 *
 *     new RrwebPlayer({target, props})       frame children: 0, threw: null
 *     new Replayer(events, {root})           <div class="replayer-wrapper"> … <iframe>
 *
 * The Replayer underneath is fine; only the wrapper is broken. So we mount the Replayer
 * ourselves and supply the handful of controls the wrapper would have given us. That also drops
 * a Svelte runtime from the chunk.
 *
 * Version pairing still matters: the recorder and @grafana/rrweb-replay must come from the same
 * rrweb fork release, because rrweb 2.x is alpha and its event format drifts between them.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Icon, Select, ToolbarButton, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { Replayer } from '@grafana/rrweb-replay';
import '@grafana/rrweb-player/dist/style.css';
import type { ReplayPlayerProps } from './types';

const SPEEDS = [1, 2, 4, 8];
/** How often the progress readout catches up with playback. */
const TICK_MS = 100;

/**
 * The viewport the session was RECORDED at, from the first Meta event. The replayed DOM is laid
 * out at that size, so it is the size the scale has to be computed against - not the size of
 * whatever element we happen to render into.
 */
function recordedViewport(events: ReplayPlayerProps['events']): { width: number; height: number } {
  const meta = events.find((e) => e.type === 4) as { data?: { width?: number; height?: number } } | undefined;
  return { width: meta?.data?.width || 1280, height: meta?.data?.height || 720 };
}

function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function ReplayPlayer({ events, mode, seekToMs }: ReplayPlayerProps) {
  const styles = useStyles2(getStyles);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const isSnapshot = mode === 'snapshot';
  const hasEnoughEvents = events.length >= 2; // rrweb needs Meta + FullSnapshot at minimum

  // Derived up front rather than set from inside the build effect: a recording starts playing
  // at the requested offset, a snapshot starts paused at zero. Setting these in the effect
  // instead would queue a second render for state that is knowable at first render.
  const startAtMs = seekToMs !== undefined && events.length > 0 ? Math.max(0, seekToMs - events[0].timestamp) : 0;
  const [playing, setPlaying] = useState(!isSnapshot && hasEnoughEvents);
  const [offsetMs, setOffsetMs] = useState(isSnapshot ? 0 : startAtMs);
  const [speed, setSpeed] = useState(1);

  const viewport = useMemo(() => recordedViewport(events), [events]);
  const durationMs = useMemo(() => {
    if (events.length < 2) {
      return 0;
    }
    return Math.max(0, events[events.length - 1].timestamp - events[0].timestamp);
  }, [events]);

  // Build the replayer once per event set.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !hasEnoughEvents) {
      return;
    }

    const replayer = new Replayer(events, {
      root: stage,
      speed: 1,
      // The recording already decides what was captured; a warning overlay on top of a masked
      // replay only obscures it further.
      showWarning: false,
      mouseTail: false,
    });
    replayerRef.current = replayer;

    // A snapshot has one frame worth looking at, so paint it and stop. A recording starts at
    // the requested offset, or at the beginning.
    if (isSnapshot) {
      replayer.pause(0);
    } else {
      replayer.play(startAtMs);
    }

    return () => {
      try {
        replayer.pause();
        replayer.destroy?.();
      } catch {
        // Teardown after the host node already went away - nothing to clean up.
      }
      replayerRef.current = null;
      stage.replaceChildren();
    };
  }, [events, hasEnoughEvents, isSnapshot, startAtMs]);

  // Scale the recorded viewport into whatever width we have. rrweb lays the DOM out at the
  // ORIGINAL size, so without this a 2336px-wide recording simply overflows and is clipped.
  useEffect(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    if (!host || !stage) {
      return;
    }
    const fit = () => {
      const available = host.clientWidth;
      if (!available) {
        return;
      }
      const scale = Math.min(1, available / viewport.width);
      stage.style.transform = `scale(${scale})`;
      stage.style.transformOrigin = 'top left';
      // The host has to reserve the SCALED height, or the surrounding page lays out against
      // the unscaled one and leaves a large gap under the replay.
      host.style.height = `${Math.round(viewport.height * scale)}px`;
    };
    fit();
    // Re-fit on container resize: the frame is not re-measured by rrweb itself.
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [viewport.width, viewport.height, events]);

  // Progress readout. Polls rather than subscribing, because the replayer's own event stream
  // fires per rrweb event and would re-render far more often than a clock needs to.
  useEffect(() => {
    if (!playing) {
      return;
    }
    const id = window.setInterval(() => {
      const current = replayerRef.current?.getCurrentTime?.() ?? 0;
      setOffsetMs(current);
      if (durationMs > 0 && current >= durationMs) {
        setPlaying(false);
      }
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing, durationMs]);

  const toggle = useCallback(() => {
    const replayer = replayerRef.current;
    if (!replayer) {
      return;
    }
    if (playing) {
      replayer.pause();
      setPlaying(false);
    } else {
      // Resuming past the end restarts, which is friendlier than a dead button.
      replayer.play(offsetMs >= durationMs ? 0 : offsetMs);
      setPlaying(true);
    }
  }, [playing, offsetMs, durationMs]);

  const seek = useCallback(
    (value: number) => {
      const replayer = replayerRef.current;
      if (!replayer) {
        return;
      }
      setOffsetMs(value);
      if (playing) {
        replayer.play(value);
      } else {
        replayer.pause(value);
      }
    },
    [playing]
  );

  const changeSpeed = useCallback(
    (value: number) => {
      setSpeed(value);
      replayerRef.current?.setConfig?.({ speed: value });
    },
    []
  );

  if (!hasEnoughEvents) {
    return (
      <Alert severity="info" title="Replay incomplete">
        Not enough replay data was captured for this session to render a frame.
      </Alert>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        {isSnapshot ? (
          <Badge text="Masked snapshot" color="blue" icon="camera" />
        ) : (
          <Badge text="Session replay" color="blue" icon="play" />
        )}
        <span className={styles.privacyNotice}>
          <Icon name="shield" size="sm" /> Recorded with all text and inputs masked at capture time.
        </span>
      </div>

      <div ref={hostRef} className={styles.host} data-testid="replay-player-container">
        <div ref={stageRef} className={styles.stage} style={{ width: viewport.width, height: viewport.height }} />
      </div>

      {!isSnapshot && (
        <div className={styles.controls}>
          <ToolbarButton
            icon={playing ? 'pause' : 'play'}
            onClick={toggle}
            aria-label={playing ? 'Pause replay' : 'Play replay'}
          />
          <input
            className={styles.scrubber}
            type="range"
            min={0}
            max={Math.max(1, durationMs)}
            value={Math.min(offsetMs, durationMs)}
            onChange={(e) => seek(Number(e.currentTarget.value))}
            aria-label="Seek"
          />
          <span className={styles.time}>
            {formatOffset(offsetMs)} / {formatOffset(durationMs)}
          </span>
          <Select
            width={12}
            options={SPEEDS.map((s) => ({ label: `${s}x`, value: s }))}
            value={speed}
            onChange={(v) => changeSpeed(v?.value ?? 1)}
            aria-label="Playback speed"
          />
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  privacyNotice: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  }),
  host: css({
    position: 'relative',
    width: '100%',
    // Clips the scaled stage; the height is set from the scale factor at runtime.
    overflow: 'hidden',
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    // White, not the canvas colour: the replay is a page from another site and its own
    // background may not cover the frame. A dark ground behind a light page reads as broken.
    background: '#fff',
  }),
  stage: css({
    position: 'absolute',
    top: 0,
    left: 0,
  }),
  controls: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  scrubber: css({
    flex: 1,
  }),
  time: css({
    color: theme.colors.text.secondary,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  }),
});
