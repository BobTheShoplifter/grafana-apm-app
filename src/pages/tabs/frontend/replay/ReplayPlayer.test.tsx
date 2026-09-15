/**
 * Smoke tests for the replay player. jsdom cannot actually render a replay (it happens in an
 * iframe), so @grafana/rrweb-replay is mocked and these tests assert OUR wiring: what the
 * Replayer is constructed with, play/pause per mode, seek maths, badge and notice text, the
 * not-enough-events guard, teardown, and the lazy boundary resolving.
 */
import React, { Suspense } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('@grafana/rrweb-replay', () => {
  const instance = {
    play: jest.fn(),
    pause: jest.fn(),
    destroy: jest.fn(),
    setConfig: jest.fn(),
    getCurrentTime: jest.fn().mockReturnValue(0),
  };
  const ctor = jest.fn().mockImplementation(() => instance);
  return { __esModule: true, Replayer: ctor, __instance: instance };
});

import { Replayer } from '@grafana/rrweb-replay';
import ReplayPlayer from './ReplayPlayer';
import { LazyReplayPlayer } from './LazyReplayPlayer';
import { ReplayEventWithTime } from './fetchReplay';

const mockCtor = Replayer as unknown as jest.Mock;
const mockInstance = (jest.requireMock('@grafana/rrweb-replay') as any).__instance;

const ev = (timestamp: number, type = 3, data: unknown = {}): ReplayEventWithTime => ({ type, data, timestamp });
/** A Meta event carries the viewport the session was recorded at. */
const meta = (timestamp: number, width = 1280, height = 720) => ev(timestamp, 4, { width, height });
const snapshotEvents = [meta(1000), ev(1000, 2)];
const recordingEvents = [meta(1000), ev(1000, 2), ev(5000), ev(60000)];

beforeEach(() => {
  mockCtor.mockClear();
  mockInstance.play.mockClear();
  mockInstance.pause.mockClear();
  mockInstance.destroy.mockClear();
  mockInstance.setConfig.mockClear();
});

describe('ReplayPlayer', () => {
  it('renders a snapshot as a static frame: no controls, paused at zero, masked-snapshot badge', () => {
    render(<ReplayPlayer events={snapshotEvents} mode="snapshot" />);

    expect(screen.getByText('Masked snapshot')).toBeInTheDocument();
    expect(screen.getByText(/Recorded with all text and inputs masked at capture time/)).toBeInTheDocument();

    expect(mockCtor).toHaveBeenCalledTimes(1);
    expect(mockInstance.pause).toHaveBeenCalledWith(0);
    expect(mockInstance.play).not.toHaveBeenCalled();
    // A single frame has nothing to scrub through.
    expect(screen.queryByLabelText('Seek')).not.toBeInTheDocument();
  });

  it('renders a recording with controls and starts at the requested offset', () => {
    render(<ReplayPlayer events={recordingEvents} mode="recording" seekToMs={31000} />);

    expect(screen.getByText('Session replay')).toBeInTheDocument();
    expect(screen.getByLabelText('Seek')).toBeInTheDocument();
    // Absolute 31000ms minus the first event at 1000ms.
    expect(mockInstance.play).toHaveBeenCalledWith(30000);
  });

  it('clamps a pre-recording seek target to the start', () => {
    render(<ReplayPlayer events={recordingEvents} mode="recording" seekToMs={500} />);
    expect(mockInstance.play).toHaveBeenCalledWith(0);
  });

  it('builds the Replayer against the mounted stage, not a detached node', () => {
    const { getByTestId } = render(<ReplayPlayer events={recordingEvents} mode="recording" />);
    const options = mockCtor.mock.calls[0][1];
    // The root must be inside the host we render, or the replay paints somewhere invisible -
    // which is exactly how this failed before.
    expect(getByTestId('replay-player-container').contains(options.root)).toBe(true);
  });

  it('sizes the stage to the viewport the session was RECORDED at', () => {
    render(<ReplayPlayer events={[meta(1000, 2336, 1295), ev(1000, 2), ev(9000)]} mode="recording" />);
    const stage = mockCtor.mock.calls[0][1].root as HTMLElement;
    // Not the container's size: rrweb lays the DOM out at the original dimensions and we scale.
    expect(stage.style.width).toBe('2336px');
    expect(stage.style.height).toBe('1295px');
  });

  it('pauses and resumes from the same position', () => {
    render(<ReplayPlayer events={recordingEvents} mode="recording" />);
    const button = screen.getByLabelText('Pause replay');

    fireEvent.click(button);
    expect(mockInstance.pause).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Play replay'));
    expect(mockInstance.play).toHaveBeenCalledTimes(2);
  });

  it('seeks while paused without resuming playback', () => {
    render(<ReplayPlayer events={recordingEvents} mode="recording" />);
    fireEvent.click(screen.getByLabelText('Pause replay'));
    mockInstance.pause.mockClear();

    fireEvent.change(screen.getByLabelText('Seek'), { target: { value: '12000' } });

    expect(mockInstance.pause).toHaveBeenCalledWith(12000);
    expect(mockInstance.play).toHaveBeenCalledTimes(1); // the initial one only
  });

  it('shows an info alert instead of mounting the player when there are not enough events', () => {
    render(<ReplayPlayer events={[meta(1000)]} mode="recording" />);
    expect(screen.getByText('Replay incomplete')).toBeInTheDocument();
    expect(mockCtor).not.toHaveBeenCalled();
  });

  it('tears the player down on unmount', () => {
    const { unmount } = render(<ReplayPlayer events={recordingEvents} mode="recording" />);
    unmount();
    expect(mockInstance.destroy).toHaveBeenCalled();
  });
});

describe('LazyReplayPlayer', () => {
  it('resolves through the guarded lazy boundary and renders the badge and privacy notice', async () => {
    render(
      <Suspense fallback={<span>loading</span>}>
        <LazyReplayPlayer events={recordingEvents} mode="recording" />
      </Suspense>
    );

    expect(await screen.findByText('Session replay')).toBeInTheDocument();
    expect(screen.getByText(/masked at capture time/)).toBeInTheDocument();
  });
});
